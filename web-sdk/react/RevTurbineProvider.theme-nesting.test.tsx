/**
 * @vitest-environment jsdom
 *
 * Plan 233 TASK-5 / AC-6 — an app-mounted theme provider wins.
 *
 * `RevTurbineProvider` rendered its own `RevTurbineThemeProvider` *inside*
 * itself, so an app that mounted one around the SDK was silently overridden:
 * the nearest provider wins in React, and the SDK's was always nearer. The
 * customer hit this reaching for a workaround after losing their theming, and
 * had to deminify our bundle to work out why their provider did nothing.
 *
 * Kent's ruling (Q-2): explicit local intent always beats a resolved default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from './RevTurbineProvider';
import { RevTurbineThemeProvider, useRevTurbineTheme } from '../theme/ThemeContext';
import { DEFAULT_THEME } from '../theme/defaults';
import type { RevTurbineInitOptions } from '../customer-side';
import type { RevTurbineTheme } from '../theme/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let seen: RevTurbineTheme;

function Consumer() {
  seen = useRevTurbineTheme();
  return <div>consumer</div>;
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

/** SDK options that resolve a branding theme through the ladder (TASK-3). */
const OPTIONS = {
  tenantId: 't_1',
  runtimeMode: 'local_only',
  localRuntime: { playbook: PLAYBOOK },
  branding: { theme: { colors: { background: '#5d0000' } } },
} as unknown as RevTurbineInitOptions;

async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('AC-6 — an app-level theme provider outranks the SDK', () => {
  it('renders the app theme, not the SDK-resolved branding', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await mount(
      <RevTurbineThemeProvider theme={{ colors: { background: '#0a0a0a' } }}>
        <RevTurbineProvider options={OPTIONS}>
          <Consumer />
        </RevTurbineProvider>
      </RevTurbineThemeProvider>,
    );

    // Before this change the SDK's inner provider was nearer and won, so this
    // read '#5d0000' — the app's explicit provider did nothing.
    expect(seen.colors.background).toBe('#0a0a0a');
  });

  it('warns in development, naming what is being overridden', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await mount(
      <RevTurbineThemeProvider theme={{ colors: { background: '#0a0a0a' } }}>
        <RevTurbineProvider options={OPTIONS}>
          <Consumer />
        </RevTurbineProvider>
      </RevTurbineThemeProvider>,
    );

    const messages = warn.mock.calls.map((call) => String(call[0]));
    const override = messages.filter((m) => m.includes('RevTurbineThemeProvider is mounted above'));
    expect(override).toHaveLength(1);
    // A warning that does not say what stopped working is not actionable.
    expect(override[0]).toContain('branding');
  });

  it('does not warn in a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await mount(
      <RevTurbineThemeProvider theme={{ colors: { background: '#0a0a0a' } }}>
        <RevTurbineProvider options={OPTIONS}>
          <Consumer />
        </RevTurbineProvider>
      </RevTurbineThemeProvider>,
    );

    const override = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((m) => m.includes('RevTurbineThemeProvider is mounted above'));
    expect(override).toHaveLength(0);
    // Precedence is behaviour, not a development nicety — it still applies.
    expect(seen.colors.background).toBe('#0a0a0a');
  });

  it('partially-specified app themes still default the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await mount(
      <RevTurbineThemeProvider theme={{ colors: { background: '#0a0a0a' } }}>
        <RevTurbineProvider options={OPTIONS}>
          <Consumer />
        </RevTurbineProvider>
      </RevTurbineThemeProvider>,
    );

    expect(seen.typography.fontSize).toBe(DEFAULT_THEME.typography.fontSize);
  });
});

describe('with no app-level provider, the SDK still owns the theme', () => {
  it('renders the SDK-resolved branding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await mount(
      <RevTurbineProvider options={OPTIONS}>
        <Consumer />
      </RevTurbineProvider>,
    );

    expect(seen.colors.background).toBe('#5d0000');

    // And says nothing — the warning must fire only on a real conflict.
    const override = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((m) => m.includes('RevTurbineThemeProvider is mounted above'));
    expect(override).toHaveLength(0);
  });
});
