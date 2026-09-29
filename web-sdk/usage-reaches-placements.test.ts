/**
 * BL-0402 — `update({ usage })` must reach placements.
 *
 * `updateUsage()` wrote only the private `usageBalances` store. `can()` and
 * `getUsage()` read it, but the placement resolver's provider context
 * (`synthesizeProviderContext`) built `entitlements.usage` from
 * `userContext.usage` alone and took `limit` only from a per-entry field
 * (default 0). The shared threshold gate (`matchesThresholdTrigger`) fails
 * closed on a missing/zero limit, so `usage_threshold` / `credit_threshold`
 * placements never fired for app-reported usage and the `{{usage_remaining}}`
 * / `{{usage_percent}}` tokens stayed stale.
 *
 * The fix is one usage view every reader shares: app-reported balances win
 * over context amounts, and a missing per-entry limit resolves from the
 * Playbook allowance for the user's current plan (unlimited = no threshold).
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
  vi.clearAllMocks();
});

function thresholdPlacement(
  id: string,
  type: 'usage_threshold' | 'credit_threshold',
  entitlementHandle: string,
  body: string,
): Record<string, unknown> {
  return {
    id,
    name: id,
    category: 'usage_credit_seat',
    trigger: { type, entitlement_handle: entitlementHandle, threshold_percent: 80 },
    payloads: [
      {
        id: `${id}_p0`,
        target: { plan_ids: [], segment_chips: [] },
        surfaces: [
          {
            template_id: 'banner_warning',
            fields: { header: 'Heads up', body },
            ctas: [],
          },
        ],
        caps: {},
        status: 'active',
      },
    ],
    order: 0,
  };
}

/** Canonical (flat, plan 147) Playbook: plan-scoped allowances on the rules. */
function playbook(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-09-28T00:00:00Z',
    plans: [
      { unique_handle: 'starter', name: 'Starter', tier_position: 0, sort_order: 0 },
      { unique_handle: 'scale', name: 'Scale', tier_position: 1, sort_order: 1 },
    ],
    entitlements: [
      { unique_handle: 'api_calls', name: 'API Calls', type: 'usage_limit', unit: 'calls' },
      { unique_handle: 'credits', name: 'Render Credits', type: 'credits', unit: 'credits' },
    ],
    entitlement_rules: [
      {
        id: 'er_api_calls_starter', entitlement_id: 'api_calls',
        targets: [{ kind: 'plan', id: 'starter' }], segment_ids: [],
        kind: 'usage_limit', limit_value: 1000, unit: 'calls', period_scope: 'per_month', enforcement: 'hard_block',
      },
      {
        id: 'er_api_calls_scale', entitlement_id: 'api_calls',
        targets: [{ kind: 'plan', id: 'scale' }], segment_ids: [],
        kind: 'usage_limit', limit_value: 'unlimited', unit: 'calls', period_scope: 'per_month', enforcement: 'hard_block',
      },
      {
        id: 'er_credits_starter', entitlement_id: 'credits',
        targets: [{ kind: 'plan', id: 'starter' }], segment_ids: [],
        kind: 'credits', allowance_value: 20, reset_period: 'month', unit: 'credits', max_balance: null,
      },
    ],
    segments: [],
    content_ui_paths: [],
    surface_templates: [
      { id: 'banner_warning', surface_type: 'banner', fields: [] },
    ],
    placements: [
      {
        id: 'pl_quota_meter',
        name: 'pl_quota_meter',
        category: 'fixed',
        trigger: { type: 'surface_render', slot_id: 'sidebar_usage' },
        payloads: [
          {
            id: 'pl_quota_meter_p0',
            target: { plan_ids: [], segment_chips: [] },
            surfaces: [
              {
                template_id: 'banner_warning',
                fields: {
                  header: 'API Calls',
                  body: '{{usage_current}} / {{usage_limit}} used ({{calls_usage_remaining}} left)',
                },
                ctas: [],
              },
            ],
            caps: {},
            status: 'active',
          },
        ],
        order: 0,
      },
      thresholdPlacement(
        'pl_usage_warning', 'usage_threshold', 'api_calls',
        "You've used {{usage_percent}}% — {{usage_remaining}} calls left.",
      ),
      thresholdPlacement(
        'pl_credits_low', 'credit_threshold', 'credits',
        '{{usage_remaining}} credits left ({{usage_percent}}% used).',
      ),
    ],
  } as unknown as RevTurbineConfig;
}

function makeSdk(): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_bl0402',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: playbook() },
  });
}

async function decide(sdk: RevTurbineCustomerSdk, name: string) {
  const placementId = await sdk.registerPlacement({ name });
  return sdk.getPlacementDecision({ placementId, userId: 'u_1' });
}

describe('BL-0402: update({ usage }) reaches usage_threshold placements', () => {
  it('hides the 80% usage warning at 50% and shows it at 80%', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'starter' });

    sdk.update({ usage: { api_calls: 500 } });
    expect((await decide(sdk, 'pl_usage_warning')).visible).toBe(false);

    sdk.update({ usage: { api_calls: 800 } });
    const at80 = await decide(sdk, 'pl_usage_warning');
    expect(at80.visible).toBe(true);
    // Tokens read the same view: 800 of the Playbook's 1000 allowance.
    expect(at80.content.body).toBe("You've used 80% — 200 calls left.");
  });

  it('updateUsage() behaves the same as update({ usage })', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'starter' });
    sdk.updateUsage({ api_calls: 950 });
    const decision = await decide(sdk, 'pl_usage_warning');
    expect(decision.visible).toBe(true);
    expect(decision.content.body).toBe("You've used 95% — 50 calls left.");
  });

  it('the app-reported balance overrides a stale init/identify usage amount', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', {
      plan_handle: 'starter',
      usage: { api_calls: { entitlement_handle: 'api_calls', unit: 'calls', amount: 100 } },
    });
    expect((await decide(sdk, 'pl_usage_warning')).visible).toBe(false);

    sdk.update({ usage: { api_calls: 900 } });
    const decision = await decide(sdk, 'pl_usage_warning');
    expect(decision.visible).toBe(true);
    expect(decision.content.body).toBe("You've used 90% — 100 calls left.");
  });

  it('a per-entry limit on the user context still wins over the Playbook allowance', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', {
      plan_handle: 'starter',
      usage: { api_calls: { entitlement_handle: 'api_calls', unit: 'calls', amount: 0, limit: 5000 } },
    });
    sdk.update({ usage: { api_calls: 900 } });
    // 900 / 5000 = 18% — below threshold, even though 900 / 1000 would fire.
    expect((await decide(sdk, 'pl_usage_warning')).visible).toBe(false);
  });

  it('an unlimited plan allowance never fires the threshold', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'scale' });
    sdk.update({ usage: { api_calls: 1_000_000 } });
    expect((await decide(sdk, 'pl_usage_warning')).visible).toBe(false);
  });
});

describe('BL-0402: update({ usage }) reaches credit_threshold placements', () => {
  it('hides the low-credits warning at 50% consumed and shows it at 80%', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'starter' });

    sdk.update({ usage: { credits: 10 } });
    expect((await decide(sdk, 'pl_credits_low')).visible).toBe(false);

    sdk.update({ usage: { credits: 16 } });
    const at80 = await decide(sdk, 'pl_credits_low');
    expect(at80.visible).toBe(true);
    expect(at80.content.body).toBe('4 credits left (80% used).');
  });
});

describe('BL-0402: usage tokens in decision content read the same view', () => {
  it('fills a fixed quota meter from app-reported usage and the plan allowance', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'starter' });
    sdk.update({ usage: { api_calls: 500 } });
    expect((await decide(sdk, 'pl_quota_meter')).content.body).toBe('500 / 1000 used (500 left)');

    sdk.update({ usage: { api_calls: 800 } });
    expect((await decide(sdk, 'pl_quota_meter')).content.body).toBe('800 / 1000 used (200 left)');
  });

  it('leaves limit-derived tokens untouched when no limit is known (unlimited plan)', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'scale' });
    sdk.update({ usage: { api_calls: 42 } });
    expect((await decide(sdk, 'pl_quota_meter')).content.body)
      .toBe('42 / {{usage_limit}} used ({{calls_usage_remaining}} left)');
  });
});

describe('BL-0402: getUsage() is unchanged', () => {
  it('reports the same current + plan-scoped limit before and after the fix', () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'starter' });
    sdk.update({ usage: { api_calls: 800, credits: 16 } });
    expect(sdk.getUsage()).toEqual({
      calls: { current: 800, limit: 1000 },
      credits: { current: 16, limit: 20 },
    });
  });

  it('reports no limit for an unlimited allowance', () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'scale' });
    sdk.update({ usage: { api_calls: 42 } });
    expect(sdk.getUsage()).toEqual({ calls: { current: 42 } });
  });
});
