import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  RevTurbineCustomerSdk,
  initRevTurbine,
  resolveLocalPlaybook,
  type RevTurbineInitInputOptions,
} from './customer-side';
import type { RevTurbineConfig } from './generated';

// Plan 163 (dogfood DX finding, plan 154 TASK-6): the local-only minimal-init
// arm previously required the DEPRECATED `exportedConfig` key as its typed
// discriminant, while the runtime already resolved the canonical `playbook`
// key through `resolveLocalPlaybook`. These tests pin the corrected contract:
// canonical key compiles, alias still compiles, and the runtime treats them
// identically (playbook wins when both are supplied).

function makeConfig(id = 'cfg_a'): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [{ id, unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 }],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

describe('minimal-init typing accepts the canonical `playbook` key', () => {
  it('compiles with playbook alone, with the deprecated alias, and rejects neither', () => {
    const withPlaybook: RevTurbineInitInputOptions = {
      localRuntime: { playbook: makeConfig() },
    };
    const withAlias: RevTurbineInitInputOptions = {
      localRuntime: { exportedConfig: makeConfig() },
    };
    const withExplicitMode: RevTurbineInitInputOptions = {
      runtimeMode: 'local_only',
      localRuntime: { playbook: makeConfig() },
    };
    // @ts-expect-error — minimal init requires a config artifact under one of the two keys
    const withNeither: RevTurbineInitInputOptions = { localRuntime: {} };

    expect([withPlaybook, withAlias, withExplicitMode, withNeither]).toBeDefined();
  });
});

describe('resolveLocalPlaybook precedence (the one resolver both keys route through)', () => {
  it('prefers the canonical key when both are supplied', () => {
    const canonical = makeConfig('cfg_canonical');
    const legacy = makeConfig('cfg_legacy');
    expect(resolveLocalPlaybook({ playbook: canonical, exportedConfig: legacy })).toBe(canonical);
  });

  it('falls back to the deprecated alias, and to undefined when absent', () => {
    const legacy = makeConfig('cfg_legacy');
    expect(resolveLocalPlaybook({ exportedConfig: legacy })).toBe(legacy);
    expect(resolveLocalPlaybook({})).toBeUndefined();
    expect(resolveLocalPlaybook(undefined)).toBeUndefined();
  });
});

describe('runtime minimal init with the canonical key', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('initRevTurbine constructs with playbook-only minimal options (local defaults injected)', () => {
    // The public factory is the minimal-init entry: normalizeInitOptions
    // injects the local-only transport defaults before construction. The class
    // constructor itself takes full options by design.
    const sdk = initRevTurbine({ localRuntime: { playbook: makeConfig() } });
    expect(sdk).toBeInstanceOf(RevTurbineCustomerSdk);
  });
});
