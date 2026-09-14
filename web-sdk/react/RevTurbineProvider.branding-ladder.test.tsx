/**
 * @vitest-environment jsdom
 *
 * Plan 233 TASK-3 / AC-4 — the rendered theme resolves through the branding ladder.
 *
 * The defect: `getBranding()` walked the four-rung ladder correctly (explicit
 * `branding` → branding API → legacy config `theme` → defaults) while the React
 * provider read `localRuntime.playbook.theme` directly. Two branding resolutions
 * for one tenant, and the one that actually painted placements ignored rung 1.
 *
 * What made it bite: our own CLI emits `VAL-DEP-01` telling authors to move
 * `theme` out of the Playbook and pass the SDK `branding` argument — and
 * `repairDeprecatedFields` *strips* the field on ingestion. A customer followed
 * that advice exactly and lost all theming: white modals in a dark app, because
 * in local mode the stripped Playbook field was the only source the renderer read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from './RevTurbineProvider';
import { useRevTurbine } from './useRevTurbine';
import { useRevTurbineTheme } from '../theme/ThemeContext';
import type { RevTurbineInitOptions } from '../customer-side';
import type { RevTurbineTheme } from '../theme/types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let renderedTheme: RevTurbineTheme;
let handle: ReturnType<typeof useRevTurbine>;

/** Stands in for a placement component — they all read the theme this way. */
function ThemeProbe() {
  renderedTheme = useRevTurbineTheme();
  handle = useRevTurbine();
  return <div>probe</div>;
}

/** A Playbook carrying NO `theme` — the shape the CLI produces after
 *  `repairDeprecatedFields` strips the deprecated field. */
const PLAYBOOK_WITHOUT_THEME = {
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

async function mount(options: Partial<RevTurbineInitOptions>): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={options as RevTurbineInitOptions}>
        <ThemeProbe />
      </RevTurbineProvider>,
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
});

describe('AC-4 — the branding init option reaches useRevTurbineTheme()', () => {
  it('renders the explicit branding theme when the Playbook carries none', async () => {
    await mount({
      tenantId: 't_1',
      runtimeMode: 'local_only',
      localRuntime: { playbook: PLAYBOOK_WITHOUT_THEME },
      branding: { theme: { colors: { background: '#000' } } },
    });

    // Before plan 233 this read DEFAULT_THEME's '#ffffff': the provider consulted
    // the Playbook's stripped `theme` and never the `branding` option.
    expect(renderedTheme.colors.background).toBe('#000');
  });

  it('still merges unspecified tokens over the defaults', async () => {
    await mount({
      tenantId: 't_1',
      runtimeMode: 'local_only',
      localRuntime: { playbook: PLAYBOOK_WITHOUT_THEME },
      branding: { theme: { colors: { background: '#000' } } },
    });

    // A partial branding theme must extend the default map, not replace it —
    // otherwise every unspecified token renders undefined.
    expect(renderedTheme.typography.fontSize).toBe('14px');
    expect(renderedTheme.colors.primary).toBeTruthy();
  });
});

describe('the guard: getBranding() and useRevTurbineTheme() cannot diverge', () => {
  it('agrees with getBranding() for the explicit rung', async () => {
    await mount({
      tenantId: 't_1',
      runtimeMode: 'local_only',
      localRuntime: { playbook: PLAYBOOK_WITHOUT_THEME },
      branding: { theme: { colors: { background: '#000' } } },
    });

    const resolved = handle.sdk!.getBranding();
    expect(resolved.source).toBe('explicit');
    // The divergence IS the defect, so pin that both surfaces answer the same.
    expect(renderedTheme.colors.background)
      .toBe((resolved.branding.theme as { colors: { background: string } }).colors.background);
  });

  it('agrees with getBranding() for the legacy config rung', async () => {
    await mount({
      tenantId: 't_1',
      runtimeMode: 'local_only',
      localRuntime: {
        playbook: { ...PLAYBOOK_WITHOUT_THEME, theme: { colors: { background: '#111' } } },
      },
    });

    const resolved = handle.sdk!.getBranding();
    expect(resolved.source).toBe('legacy-config');
    expect(renderedTheme.colors.background).toBe('#111');
  });

  it('lets the explicit branding option outrank a Playbook theme', async () => {
    await mount({
      tenantId: 't_1',
      runtimeMode: 'local_only',
      localRuntime: {
        playbook: { ...PLAYBOOK_WITHOUT_THEME, theme: { colors: { background: '#111' } } },
      },
      branding: { theme: { colors: { background: '#000' } } },
    });

    // Ladder order, now observable in what actually paints.
    expect(handle.sdk!.getBranding().source).toBe('explicit');
    expect(renderedTheme.colors.background).toBe('#000');
  });

  it('falls back to the default theme when nothing is branded', async () => {
    await mount({
      tenantId: 't_1',
      runtimeMode: 'local_only',
      localRuntime: { playbook: PLAYBOOK_WITHOUT_THEME },
    });

    expect(handle.sdk!.getBranding().source).toBe('default');
    expect(renderedTheme.colors.background).toBe('#ffffff');
  });
});
