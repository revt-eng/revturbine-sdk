import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  RevTurbineCustomerSdk,
  initRevTurbine,
  resolveLocalPlaybook,
  type RevTurbineInitInputOptions,
} from './customer-side';
import type { RevTurbineConfig } from './generated';

// Plan 163 (dogfood DX finding, plan 154 TASK-6): the local-only minimal-init
// arm is discriminated by the `playbook` key, which the runtime resolves
// through `resolveLocalPlaybook`. These tests pin that contract: the key compiles and the runtime treats it
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
  it('compiles with playbook, and rejects a missing playbook', () => {
    const withPlaybook: RevTurbineInitInputOptions = {
      localRuntime: { playbook: makeConfig() },
    };
    const withExplicitMode: RevTurbineInitInputOptions = {
      runtimeMode: 'local_only',
      localRuntime: { playbook: makeConfig() },
    };
    // @ts-expect-error — minimal init requires a config artifact under `playbook`
    const withNeither: RevTurbineInitInputOptions = { localRuntime: {} };

    expect([withPlaybook, withExplicitMode, withNeither]).toBeDefined();
  });
});

describe('resolveLocalPlaybook (the one resolver the `playbook` key routes through)', () => {
  it('returns the playbook, and undefined when absent', () => {
    const canonical = makeConfig('cfg_canonical');
    expect(resolveLocalPlaybook({ playbook: canonical })).toBe(canonical);
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
