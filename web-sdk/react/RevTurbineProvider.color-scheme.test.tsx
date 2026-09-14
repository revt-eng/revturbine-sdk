/**
 * @vitest-environment jsdom
 *
 * Plan 233 TASK-6 / AC-7 — light/dark without re-initializing.
 *
 * The SDK shipped no sanctioned dark story at all. The escalated customer, in a
 * dark app, ended up injecting a palette into the Playbook object and
 * re-initialising the SDK on every toggle — which tears down and rebuilds the
 * instance, losing decision caches, interaction state and in-flight work, to
 * change a colour.
 *
 * So the load-bearing assertion here is not "the palette changed". It is that
 * the SDK instance is the SAME OBJECT across the toggle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from './RevTurbineProvider';
import { useRevTurbine } from './useRevTurbine';
import { useRevTurbineTheme } from '../theme/ThemeContext';
import { DARK_THEME, DEFAULT_THEME, type RevTurbineColorScheme } from '../theme/defaults';
import type { RevTurbineCustomerSdk, RevTurbineInitOptions } from '../customer-side';
import type { RevTurbineTheme } from '../theme/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let seen: RevTurbineTheme;
let sdkSeen: RevTurbineCustomerSdk | null = null;
let schemeSeen: 'light' | 'dark';

function Probe() {
  seen = useRevTurbineTheme();
  const handle = useRevTurbine();
  sdkSeen = handle.sdk;
  schemeSeen = handle.colorScheme;
  return <div>probe</div>;
}

const PLAYBOOK = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  playbook_handle: 'default',
  playbook_version_id: null,
  tenant_id: 't_1',
  environment_id: 'production',
  plans: [],
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
};

// Stable identity: a new options object every render would re-init regardless
// of what this task changed, and would mask the very thing AC-7 asserts.
const OPTIONS = {
  tenantId: 't_1',
  runtimeMode: 'local_only',
  localRuntime: { playbook: PLAYBOOK },
} as unknown as RevTurbineInitOptions;

/** matchMedia stub — jsdom ships none. */
function stubMatchMedia(prefersDark: boolean, listeners: Array<(e: MediaQueryListEvent) => void> = []) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: prefersDark && query.includes('dark'),
    media: query,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.push(fn),
    removeEventListener: () => {},
    addListener: (fn: (e: MediaQueryListEvent) => void) => listeners.push(fn),
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

async function mount(scheme?: RevTurbineColorScheme): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={OPTIONS} colorScheme={scheme}>
        <Probe />
      </RevTurbineProvider>,
    );
  });
}

async function rerender(scheme: RevTurbineColorScheme): Promise<void> {
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={OPTIONS} colorScheme={scheme}>
        <Probe />
      </RevTurbineProvider>,
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  stubMatchMedia(false);
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  sdkSeen = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AC-7 — toggling scheme repaints without re-initializing', () => {
  it('keeps the SAME SDK instance across a light→dark toggle', async () => {
    await mount('light');
    const before = sdkSeen;
    expect(before).not.toBeNull();

    await rerender('dark');

    // The assertion the task exists for. Object identity, not deep equality:
    // a rebuilt SDK would be equal-looking and still have lost its caches.
    expect(sdkSeen).toBe(before);
  });

  it('repaints placements with the dark palette', async () => {
    await mount('light');
    expect(seen.colors.background).toBe(DEFAULT_THEME.colors.background);

    await rerender('dark');

    expect(seen.colors.background).toBe(DARK_THEME.colors.background);
    expect(seen.colors.text).toBe(DARK_THEME.colors.text);
  });

  it('exposes the resolved scheme through useRevTurbine()', async () => {
    await mount('dark');
    expect(schemeSeen).toBe('dark');

    await rerender('light');
    expect(schemeSeen).toBe('light');
  });
});

describe('system preference', () => {
  it('defaults to system and follows prefers-color-scheme: dark', async () => {
    stubMatchMedia(true);
    await mount();

    expect(schemeSeen).toBe('dark');
    expect(seen.colors.background).toBe(DARK_THEME.colors.background);
  });

  it('defaults to light when the system prefers light', async () => {
    stubMatchMedia(false);
    await mount();

    expect(schemeSeen).toBe('light');
    expect(seen.colors.background).toBe(DEFAULT_THEME.colors.background);
  });

  it('reacts to a live system change without remounting', async () => {
    const listeners: Array<(e: MediaQueryListEvent) => void> = [];
    stubMatchMedia(false, listeners);
    await mount('system');
    const before = sdkSeen;
    expect(schemeSeen).toBe('light');

    await act(async () => {
      for (const fn of listeners) fn({ matches: true } as MediaQueryListEvent);
    });

    expect(schemeSeen).toBe('dark');
    expect(sdkSeen).toBe(before);
  });

  it('does not subscribe when the scheme is fixed', async () => {
    const listeners: Array<(e: MediaQueryListEvent) => void> = [];
    stubMatchMedia(false, listeners);
    await mount('light');

    // A fixed preference has nothing to listen for; subscribing anyway would
    // let an OS change override an explicit choice.
    expect(listeners).toHaveLength(0);
  });

  it('falls back to light when matchMedia is unavailable', async () => {
    vi.stubGlobal('matchMedia', undefined);
    await mount('system');

    expect(schemeSeen).toBe('light');
    expect(seen.colors.background).toBe(DEFAULT_THEME.colors.background);
  });
});

describe('branding still applies on top of the scheme', () => {
  const BRANDED = {
    ...OPTIONS,
    branding: { theme: { colors: { primary: '#ff00ff' } } },
  } as unknown as RevTurbineInitOptions;

  async function mountBranded(scheme: RevTurbineColorScheme): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RevTurbineProvider options={BRANDED} colorScheme={scheme}>
          <Probe />
        </RevTurbineProvider>,
      );
    });
  }

  it('keeps brand tokens while the scheme supplies the rest', async () => {
    await mountBranded('dark');

    // The scheme selects the base palette; branding still wins per token.
    expect(seen.colors.primary).toBe('#ff00ff');
    expect(seen.colors.background).toBe(DARK_THEME.colors.background);
  });
});
