/**
 * @vitest-environment jsdom
 *
 * ST-1696 (SDK 0.16.0) — the per-call `cost` on usage-limit and credits checks
 * (Kent's final rule, 2026-11-11), through the browser SDK's `can()` /
 * `checkEntitlement()`:
 *
 *   - cost > 0: allowed while `used + cost <= limit`;
 *   - cost 0: always allowed (free), with a developer WARNING;
 *   - missing / invalid cost: today's check (`used >= limit`) and a developer
 *     ERROR, naming only the kind of an invalid value;
 *   - a feature rule and an unlimited entitlement ignore it, silently;
 *   - the diagnostic never changes allowed / status / reason;
 *   - core's default routing prints ONE console line per handle + code (the
 *     browser adds none of its own, so nothing prints twice).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk, RuntimeMode } from './customer-side';

const PLAYBOOK = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  playbook_handle: 'default',
  playbook_version_id: null,
  tenant_id: 't_1',
  environment_id: 'production',
  plans: [{ unique_handle: 'pro', name: 'Pro', tier_position: 0, sort_order: 0 }],
  entitlements: [
    { unique_handle: 'api_calls', name: 'API calls', type: 'usage_limit', unit: 'calls' },
    { unique_handle: 'api_calls_unlimited', name: 'Unlimited', type: 'usage_limit', unit: 'calls' },
    { unique_handle: 'ai_credits', name: 'AI credits', type: 'credits', unit: 'credits' },
    { unique_handle: 'export', name: 'Export', type: 'feature' },
  ],
  entitlement_rules: [
    { id: 'r_api', entitlement_id: 'api_calls', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 10, enforcement: 'hard_block' } },
    { id: 'r_unl', entitlement_id: 'api_calls_unlimited', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: null, enforcement: 'hard_block' } },
    { id: 'r_cr', entitlement_id: 'ai_credits', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'credits', allowance_value: 100, enforcement: 'hard_block' } },
    { id: 'r_ex', entitlement_id: 'export', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'feature', enabled: true } },
  ],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [],
};

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const sdks: RevTurbineCustomerSdk[] = [];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' })));
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const sdk of sdks.splice(0)) sdk.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function build(): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    user: { id: 'u1', plan_handle: 'pro' },
    tenantId: 't_1',
    runtimeMode: RuntimeMode.LocalOnly,
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: PLAYBOOK },
  } as never);
  sdks.push(sdk);
  return sdk;
}

const costLines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('cost'));

describe('cost on a usage_limit entitlement', () => {
  it('cost above 0 is allowed while it fits and refused when it does not', async () => {
    const sdk = build();
    expect(await sdk.can('api_calls', { used: 7, cost: 3 })).toMatchObject({ allowed: true, status: 'allowed' });
    expect(await sdk.can('api_calls', { used: 7, cost: 3.5 })).toMatchObject({
      allowed: false, status: 'denied', reason: 'usage_limit_reached',
    });
    expect(costLines(warnSpy)).toHaveLength(0);
    expect(costLines(errorSpy)).toHaveLength(0);
  });

  it('cost 0 is free: allowed past the limit, with a warning diagnostic and one console.warn', async () => {
    const sdk = build();
    const r = await sdk.can('api_calls', { used: 25, cost: 0 });
    expect(r.allowed).toBe(true);
    expect(r.diagnostic).toEqual({ level: 'warning', code: 'entitlement_cost_zero', handle: 'api_calls' });
    await sdk.can('api_calls', { used: 25, cost: 0 });
    expect(costLines(warnSpy)).toHaveLength(1);
    expect(costLines(errorSpy)).toHaveLength(0);
  });

  it('a missing cost keeps today\'s check, reports an error diagnostic and prints ONE console.error', async () => {
    const sdk = build();
    const under = await sdk.can('api_calls', { used: 9 });
    const at = await sdk.can('api_calls', { used: 10 });
    expect(under.allowed).toBe(true);
    expect(at).toMatchObject({ allowed: false, status: 'denied', reason: 'usage_limit_reached' });
    expect(at.diagnostic).toEqual({ level: 'error', code: 'entitlement_cost_missing', handle: 'api_calls' });
    expect(costLines(errorSpy)).toHaveLength(1);
    expect(costLines(errorSpy)[0]).toContain('Pass a cost (0 for free)');
  });

  it('an invalid cost is treated as missing and names only the kind, never the value', async () => {
    const sdk = build();
    const r = await sdk.can('api_calls', { used: 9, cost: -1 });
    expect(r.allowed).toBe(true);
    expect(r.diagnostic).toEqual({ level: 'error', code: 'entitlement_cost_invalid', handle: 'api_calls', received: 'negative' });
    const bad = await sdk.can('api_calls', { used: 9, cost: '3' as never });
    expect(bad.diagnostic?.received).toBe('non_number');
    const printed = costLines(errorSpy).join('\n');
    expect(printed).not.toContain('"3"');
    expect(printed).toContain('a negative number');
  });

  it('floating-point tolerance matches the reference formula', async () => {
    const sdk = build();
    const r1 = await sdk.can('api_calls', { used: 9.7, cost: 0.3 });
    expect(r1.allowed).toBe(true);
  });

  it('a feature rule and an unlimited entitlement ignore cost silently', async () => {
    const sdk = build();
    for (const [handle, ctx] of [['export', { cost: 2 }], ['api_calls_unlimited', { used: 50, cost: 5 }], ['api_calls_unlimited', { used: 50 }]] as const) {
      const r = await sdk.can(handle, ctx);
      expect(r.allowed).toBe(true);
      expect(r.diagnostic).toBeUndefined();
    }
    expect(costLines(warnSpy)).toHaveLength(0);
    expect(costLines(errorSpy)).toHaveLength(0);
  });
});

describe('cost on a credits entitlement', () => {
  it('a balance is the limit for the cost rule', async () => {
    const sdk = build();
    expect(await sdk.can('ai_credits', { balance: 40, cost: 40 })).toMatchObject({ allowed: true });
    expect(await sdk.can('ai_credits', { balance: 40, cost: 41 })).toMatchObject({
      allowed: false, reason: 'credit_balance_exhausted', limit: 100, used: 60, remaining: 40,
    });
  });

  it('without a cost the balance check is unchanged and reports the missing-cost error', async () => {
    const sdk = build();
    const r = await sdk.can('ai_credits', { balance: 0 });
    expect(r).toMatchObject({ allowed: false, reason: 'credit_balance_exhausted' });
    expect(r.diagnostic?.code).toBe('entitlement_cost_missing');
  });
});

describe('existing calls', () => {
  it('without a cost return the same allowed / status / reason as before (only the diagnostic is new)', async () => {
    const sdk = build();
    const { diagnostic, ...rest } = await sdk.checkEntitlement('api_calls', { used: 3 });
    expect(rest).toMatchObject({ allowed: true, status: 'allowed', limit: 10, used: 3, remaining: 7 });
    expect(diagnostic?.code).toBe('entitlement_cost_missing');
  });
});
