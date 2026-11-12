/**
 * @vitest-environment jsdom
 *
 * ST-1741 (SDK 0.17.0, Kent's D-7) — usage that counts down, through the
 * browser SDK's public surfaces (`can`, `checkEntitlement`, `setUserContext`,
 * `identify`, `update`):
 *
 *   - a `credits` entitlement COUNTS DOWN: with a cost above 0 the check is over
 *     when the cost exceeds the balance (the call's `balance`, its `used`, the
 *     `remaining` the app mirrored, `limit - used` when it sent both, held
 *     usage);
 *   - a `usage_limit` COUNTS UP: over when `used + cost` exceeds the limit, with
 *     used / limit from the call, the app's mirrored numbers, or held usage;
 *   - when the numbers compared were the app's or the call's, a mirrored
 *     "allowed" no longer overrides an over result; a mirrored denial stands;
 *   - cost 0, a missing cost and an invalid cost are exactly as on 0.16.0;
 *   - a mirrored record with a boolean `allowed` and no `status` sets the answer
 *     (D-6), with no rule_handle;
 *   - the browser hands core the mirrored record unchanged: raising the mirrored
 *     remaining through `setUserContext` / `update` flips the next result, and
 *     the SDK never decrements a balance itself.
 *
 * The decision itself is core's (`@revt-eng/core` 0.1.560); the cross-port
 * contract is the parity corpus. These tests pin that the browser feeds it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk, RuntimeMode } from './customer-side';

function playbook(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifact_type: 'playbook',
    format_version: '1.0.0',
    playbook_handle: 'default',
    playbook_version_id: null,
    tenant_id: 't_1',
    environment_id: 'production',
    plans: [{ unique_handle: 'pro', name: 'Pro', tier_position: 0, sort_order: 0 }],
    entitlements: [
      { unique_handle: 'video_credits', name: 'Video credits', type: 'credits', unit: 'credits' },
      { unique_handle: 'api_calls', name: 'API calls', type: 'usage_limit', unit: 'calls' },
      { unique_handle: 'api_calls_open', name: 'Open API calls', type: 'usage_limit', unit: 'calls' },
      { unique_handle: 'degrading_credits', name: 'Degrading credits', type: 'credits', unit: 'credits' },
    ],
    entitlement_rules: [
      // The Color42 shape: a credits rule that blocks with an upsell.
      { id: 'r_video', entitlement_id: 'video_credits', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'credits', allowance: 1000, enforcement: 'block_with_upsell' } },
      { id: 'r_api', entitlement_id: 'api_calls', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 100, enforcement: 'hard_block' } },
      { id: 'r_open', entitlement_id: 'api_calls_open', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: null, enforcement: 'hard_block' } },
      { id: 'r_deg', entitlement_id: 'degrading_credits', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'credits', allowance: 1000, enforcement: 'degrade' } },
    ],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
    ...extra,
  };
}

const sdks: RevTurbineCustomerSdk[] = [];
let userSeq = 0;

function build(
  entitlements: Record<string, unknown> | undefined,
  options: Record<string, unknown> = {},
  pb: Record<string, unknown> = playbook(),
): RevTurbineCustomerSdk {
  // A distinct user per SDK: the context is persisted by user id, so two SDKs
  // in one test must not see each other's mirrored record.
  userSeq += 1;
  const sdk = new RevTurbineCustomerSdk({
    user: { id: `u_${userSeq}`, plan_handle: 'pro', ...(entitlements ? { entitlements } : {}) },
    tenantId: 't_1',
    runtimeMode: RuntimeMode.LocalOnly,
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: pb },
    ...options,
  } as never);
  sdks.push(sdk);
  return sdk;
}

beforeEach(() => {
  // The SDK persists the user context per user id; start each test clean.
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' })));
  // Core prints a cost diagnostic once per handle + code per process; the
  // tests assert the results, not the console.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const sdk of sdks.splice(0)) sdk.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('credits count down from the balance the app mirrored', () => {
  const mirrored = { status: 'allowed', limit: 1000, used: 995 };

  it('a cost that fits (even exactly) keeps the mirrored allowed', async () => {
    const sdk = build({ video_credits: mirrored });
    expect(await sdk.can('video_credits', { cost: 5 })).toMatchObject({
      allowed: true, status: 'allowed', reason: 'entitlement_mirrored', remaining: 5,
    });
    expect(await sdk.checkEntitlement('video_credits', { cost: 1 })).toMatchObject({ allowed: true });
  });

  it('a cost that does not fit is refused per the rule, with its handle and reason', async () => {
    const sdk = build({ video_credits: mirrored });
    expect(await sdk.can('video_credits', { cost: 5.5 })).toMatchObject({
      status: 'denied',
      allowed: false,
      reason: 'credit_balance_exhausted_block_with_upsell',
      rule_handle: 'r_video',
      limit: 1000,
      used: 995,
      remaining: 5,
    });
  });

  it('the mirrored remaining alone is enough', async () => {
    const sdk = build({ video_credits: { status: 'allowed', remaining: 5 } });
    expect(await sdk.can('video_credits', { cost: 40 })).toMatchObject({ allowed: false, remaining: 5, used: 995 });
    expect(await sdk.can('video_credits', { cost: 5 })).toMatchObject({ allowed: true });
  });

  it('a derived balance is compared as used + cost against the limit (999.7 + 0.3 fits 1000)', async () => {
    expect(1000 - 999.7).not.toBe(0.3);
    const sdk = build({ video_credits: { status: 'allowed', limit: 1000, used: 999.7 } });
    expect(await sdk.can('video_credits', { cost: 0.3 })).toMatchObject({ allowed: true, reason: 'entitlement_mirrored' });
    expect(await sdk.can('video_credits', { cost: 0.3000001 })).toMatchObject({ allowed: false });
  });

  it('the derived-remaining FALLBACK: when limit or used follows the Playbook, the balance form applies', async () => {
    const entitlements = { video_credits: { status: 'allowed', limit: 1000, used: 999.7 } };
    // Default merge: the app's pair is compared as used + cost against limit.
    expect(await build(entitlements).can('video_credits', { cost: 0.3 })).toMatchObject({ allowed: true });
    // The pair is no longer wholly the app's, so remaining (1000 - 999.7) is the balance.
    const limitFromPlaybook = build(entitlements, { entitlementMerge: { fields: { limit: 'playbook' } } });
    expect(await limitFromPlaybook.can('video_credits', { cost: 0.3 })).toMatchObject({
      status: 'denied', allowed: false, reason: 'credit_balance_exhausted_block_with_upsell', remaining: 0.2999999999999545,
    });
    const usedFromPlaybook = build(entitlements, { entitlementMerge: { fields: { used: 'playbook' } } });
    expect(await usedFromPlaybook.can('video_credits', { cost: 0.3 })).toMatchObject({
      allowed: false, reason: 'credit_balance_exhausted_block_with_upsell',
    });
  });

  it('a per-call balance beats the mirrored numbers', async () => {
    const sdk = build({ video_credits: { status: 'allowed', remaining: 5 } });
    expect(await sdk.can('video_credits', { cost: 40, balance: 100 })).toMatchObject({ allowed: true });
    expect(await sdk.can('video_credits', { cost: 40, balance: 10 })).toMatchObject({ allowed: false });
  });

  it('a mirrored denial stays denied; a mirrored answer with no numbers is unchanged', async () => {
    expect(await build({ video_credits: { status: 'denied', remaining: 50 } }).can('video_credits', { cost: 1 })).toMatchObject({
      allowed: false, reason: 'entitlement_mirrored',
    });
    expect(await build({ video_credits: { status: 'allowed' } }).can('video_credits', { cost: 4000 })).toMatchObject({
      allowed: true, reason: 'entitlement_mirrored',
    });
    expect(await build({ video_credits: true }).can('video_credits', { cost: 4000 })).toMatchObject({
      allowed: true, reason: 'entitlement_mirrored',
    });
  });

  it('cost 0, a missing cost and an invalid cost never consult the mirrored remaining', async () => {
    const sdk = build({ video_credits: { status: 'allowed', remaining: 0 } });
    for (const context of [{ cost: 0 }, {}, { cost: -1 }]) {
      expect(await sdk.can('video_credits', context as never)).toMatchObject({ allowed: true, reason: 'entitlement_mirrored' });
    }
  });

  it('the rule decides what over means (enforcement mode)', async () => {
    const over = { degrading_credits: { status: 'allowed', remaining: 5 } };
    expect(await build(over).can('degrading_credits', { cost: 40 })).toMatchObject({
      status: 'limited', allowed: true, reason: 'credit_balance_exhausted_degraded',
    });
  });

  it('no plan: the over result is limited, not allowed, with the plain reason and no rule_handle', async () => {
    // A user with no plan: the options' `user` replaces the helper's (which has one).
    const sdk = build(undefined, { user: { id: 'u_no_plan', entitlements: { video_credits: { status: 'allowed', limit: 5, used: 0 } } } });
    const over = await sdk.can('video_credits', { cost: 40 });
    expect(over).toMatchObject({ status: 'limited', allowed: false, reason: 'credit_balance_exhausted', limit: 5, used: 0, remaining: 5 });
    expect(over).not.toHaveProperty('rule_handle');
    expect(await sdk.can('video_credits', { cost: 3 })).toMatchObject({ allowed: true, reason: 'entitlement_mirrored' });
  });
});

describe('usage limits count up from the used the app mirrored', () => {
  it('used + cost against the rule limit, the cost fitting exactly', async () => {
    const sdk = build({ api_calls: { status: 'allowed', used: 95 } });
    expect(await sdk.can('api_calls', { cost: 5 })).toMatchObject({ allowed: true, reason: 'entitlement_mirrored', used: 95 });
    expect(await sdk.can('api_calls', { cost: 6 })).toMatchObject({
      allowed: false, status: 'denied', reason: 'usage_limit_reached', rule_handle: 'r_api', used: 95, limit: 100,
    });
  });

  it('a mirrored limit and used win over the rule limit; the call used beats both', async () => {
    const sdk = build({ api_calls: { status: 'allowed', limit: 20, used: 15 } });
    expect(await sdk.can('api_calls', { cost: 5 })).toMatchObject({ allowed: true });
    expect(await sdk.can('api_calls', { cost: 6 })).toMatchObject({ allowed: false, limit: 20 });
    expect(await sdk.can('api_calls', { cost: 6, used: 0 })).toMatchObject({ allowed: true });
  });

  it('a mirrored finite limit applies even when the rule is unlimited', async () => {
    const sdk = build({ api_calls_open: { status: 'allowed', limit: 10, used: 8 } });
    expect(await sdk.can('api_calls_open', { cost: 2 })).toMatchObject({ allowed: true });
    expect(await sdk.can('api_calls_open', { cost: 3 })).toMatchObject({ allowed: false, limit: 10 });
  });

  it('a mirrored remaining alone and a per-call balance are ignored on a usage limit', async () => {
    const sdk = build({ api_calls: { status: 'allowed', remaining: 0 } });
    expect(await sdk.can('api_calls', { cost: 5 })).toMatchObject({ allowed: true, reason: 'entitlement_mirrored' });
    expect(await sdk.can('api_calls', { cost: 5, balance: 0 })).toMatchObject({ allowed: true });
  });

  it('a mirrored denial stays denied; cost 0 and a missing cost are as on 0.16.0', async () => {
    expect(await build({ api_calls: { status: 'denied', used: 1 } }).can('api_calls', { cost: 1 })).toMatchObject({ allowed: false });
    const sdk = build({ api_calls: { status: 'allowed', used: 95 } });
    expect(await sdk.can('api_calls', { cost: 0 })).toMatchObject({ allowed: true, reason: 'entitlement_mirrored' });
    expect(await sdk.can('api_calls', {} as never)).toMatchObject({ allowed: true, reason: 'entitlement_mirrored' });
  });
});

describe('D-6: a mirrored boolean `allowed` without a status sets the answer', () => {
  it('allowed true is allowed and false is denied, with the mirrored reason and no rule_handle', async () => {
    const on = await build({ video_credits: { allowed: true } }).checkEntitlement('video_credits', { cost: 1 });
    expect(on).toMatchObject({ status: 'allowed', allowed: true, reason: 'entitlement_mirrored' });
    expect(on).not.toHaveProperty('rule_handle');
    const off = await build({ video_credits: { allowed: false } }).checkEntitlement('video_credits', { cost: 1 });
    expect(off).toMatchObject({ status: 'denied', allowed: false, reason: 'entitlement_mirrored' });
    expect(off).not.toHaveProperty('rule_handle');
  });
});

describe('the browser feeds core the mirrored record unchanged', () => {
  it('setUserContext raising the mirrored remaining flips the next result; the SDK never decrements', async () => {
    const sdk = build({ video_credits: { status: 'allowed', limit: 1000, used: 995 } });
    expect(await sdk.can('video_credits', { cost: 5 })).toMatchObject({ allowed: true, remaining: 5 });
    // A fit does not spend anything: the next identical check sees the same balance.
    expect(await sdk.can('video_credits', { cost: 5 })).toMatchObject({ allowed: true, remaining: 5 });
    expect(await sdk.can('video_credits', { cost: 40 })).toMatchObject({ allowed: false });
    sdk.setUserContext({ entitlements: { video_credits: { status: 'allowed', limit: 1000, used: 900 } } } as never);
    expect(await sdk.can('video_credits', { cost: 40 })).toMatchObject({ allowed: true, remaining: 100 });
    sdk.setUserContext({ entitlements: { video_credits: { status: 'allowed', limit: 1000, used: 1000 } } } as never);
    expect(await sdk.can('video_credits', { cost: 1 })).toMatchObject({ allowed: false, remaining: 0 });
  });

  it('identify() carries the same mirrored record', async () => {
    const sdk = build(undefined);
    sdk.identify('u2', { plan_handle: 'pro', entitlements: { api_calls: { status: 'allowed', used: 99 } } } as never);
    expect(await sdk.can('api_calls', { cost: 1 })).toMatchObject({ allowed: true, used: 99 });
    expect(await sdk.can('api_calls', { cost: 2 })).toMatchObject({ allowed: false, used: 99 });
  });

  it('update() carries the same mirrored record', async () => {
    const sdk = build(undefined);
    sdk.update({ entitlements: { video_credits: { status: 'allowed', remaining: 3 } } } as never);
    expect(await sdk.can('video_credits', { cost: 3 })).toMatchObject({ allowed: true });
    expect(await sdk.can('video_credits', { cost: 4 })).toMatchObject({ allowed: false });
  });

  it('the trait flattened for segment evaluation counts a mirrored grant unless denied (unchanged)', () => {
    const sdk = build({
      video_credits: { status: 'allowed', remaining: 0 },
      api_calls: { status: 'denied' },
    });
    const traits = sdk.getTargeting().traits as Record<string, unknown>;
    expect(traits.video_credits).toBe(true);
    expect(traits.api_calls).toBe(false);
  });
});
