/**
 * BL-0426 (1) — a Playbook segment without a handle used to crash init deep
 * inside segment normalisation (`Cannot read properties of undefined (reading
 * 'startsWith')`). Init now validates the loaded Playbook and throws ONE
 * descriptive error naming the offending segment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineConfig } from '@revt-eng/schema';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function playbook(segments: unknown[]): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-10-21T00:00:00Z',
    plans: [{ unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 }],
    entitlements: [{ unique_handle: 'sso', name: 'SSO', type: 'feature' }],
    entitlement_rules: [],
    segments,
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

function makeSdk(segments: unknown[]): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_bl0426',
    publicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: playbook(segments) },
  });
}

describe('BL-0426 (2): a rule naming no entitlement warns once, and the reason is unchanged', () => {
  function sdkWithOrphanRule(): RevTurbineCustomerSdk {
    const config = playbook([]) as unknown as Record<string, unknown>;
    config.entitlement_rules = [
      { id: 'r_orphan', entitlement_id: 'sso_typo', targets: [{ kind: 'plan', id: 'free' }], segment_ids: [], kind: 'feature', enabled: true },
      { id: 'r_ok', entitlement_id: 'sso', targets: [{ kind: 'plan', id: 'free' }], segment_ids: [], kind: 'feature', enabled: true },
    ];
    return new RevTurbineCustomerSdk({
      tenantId: 'tenant_bl0426',
      publicKey: 'pub_test',
      runtimeMode: 'local_only',
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      localRuntime: { playbook: config as unknown as RevTurbineConfig },
    });
  }

  it('warns once per rule, naming the rule and the unmatched handle', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sdk = sdkWithOrphanRule();
    sdk.identify('user_1', { plan_handle: 'free' });
    await sdk.can('sso_typo');
    await sdk.can('sso_typo');
    const orphanWarnings = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('r_orphan'));
    expect(orphanWarnings).toHaveLength(1);
    expect(orphanWarnings[0]).toContain('"sso_typo"');
    expect(warn.mock.calls.some(([m]) => String(m).includes('"r_ok"'))).toBe(false);
  });

  it('does not change the check outcome: the matched handle is decided by its rule', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sdk = sdkWithOrphanRule();
    sdk.identify('user_1', { plan_handle: 'free' });
    expect((await sdk.can('sso')).allowed).toBe(true);
  });
});

describe('BL-0426 (1): a malformed Playbook segment fails init descriptively', () => {
  it('a segment with no handle throws one error naming the segment, not a TypeError', () => {
    let thrown: unknown;
    try {
      makeSdk([{ id: 'seg_no_handle', name: 'No handle', predicates: [] }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(String((thrown as Error).message)).toMatch(/segment/i);
    expect(String((thrown as Error).message)).toContain('seg_no_handle');
    expect(String((thrown as Error).message)).toMatch(/handle/);
  });

  it('a well-formed segment still initialises', () => {
    expect(() => makeSdk([
      { handle: 'power_users', name: 'Power users', predicates: [] },
    ])).not.toThrow();
  });

  it.each([
    ['plans', { name: 'Nameless plan' }, 'unique_handle'],
    ['entitlements', { name: 'Nameless entitlement', type: 'feature' }, 'unique_handle'],
  ])('a %s row with no identity key is refused the same way', (array, row, key) => {
    const config = playbook([]) as unknown as Record<string, unknown[]>;
    config[array] = [...config[array], row];
    expect(() => new RevTurbineCustomerSdk({
      tenantId: 'tenant_bl0426',
      publicKey: 'pub_test',
      runtimeMode: 'local_only',
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      localRuntime: { playbook: config as unknown as RevTurbineConfig },
    })).toThrow(new RegExp(`${array}\\[1\\] \\("Nameless [a-z]+"\\) has no "${key}"`));
  });
});
