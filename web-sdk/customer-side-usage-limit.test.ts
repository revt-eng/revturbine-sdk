import { describe, expect, it } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineConfig } from '@revt-eng/schema';

/**
 * Regression: in local-runtime, `getUsage()` must return the limit for the
 * USER'S plan, not the last rule in the config.
 *
 * Bug: `hydrateUsageLimitRulesFromExportedConfig` wrote every plan's
 * `usage_limit` rule to the same map key with no plan filter, so the last rule
 * (here Enterprise = 999999) overwrote Free/Pro — for every user.
 */
function makeConfig(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [
      { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
      { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 0 },
      { unique_handle: 'enterprise', name: 'Enterprise', tier_position: 2, sort_order: 0 },
    ],
    entitlements: [
      { unique_handle: 'generations', name: 'Generations', type: 'usage_limit', unit: 'images' },
    ],
    // Enterprise LAST — reproduces the last-write-wins overwrite.
    entitlement_rules: [
      { id: 'r_free', entitlement_id: 'generations', targets: [{ kind: 'plan', id: 'free' }], segment_ids: [],
        kind: 'usage_limit', limit_value: 30, unit: 'images', period_scope: 'per_month', enforcement: 'hard_block' },
      { id: 'r_pro', entitlement_id: 'generations', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [],
        kind: 'usage_limit', limit_value: 2000, unit: 'images', period_scope: 'per_month', enforcement: 'allow_overage' },
      { id: 'r_ent', entitlement_id: 'generations', targets: [{ kind: 'plan', id: 'enterprise' }], segment_ids: [],
        kind: 'usage_limit', limit_value: 999999, unit: 'images', period_scope: 'per_month', enforcement: 'allow_overage' },
    ],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

function makeSdk(): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_usage',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { exportedConfig: makeConfig() },
  });
}

/** The generations usage entry, however getUsage keys it (unit/handle). */
function genLimit(sdk: RevTurbineCustomerSdk): number | undefined {
  const usage = sdk.getUsage();
  const entry = usage.generations ?? usage.images ?? Object.values(usage)[0];
  return entry?.limit;
}

describe('getUsage() resolves the per-plan usage limit (local-runtime)', () => {
  it('Free user → 30, not the Enterprise 999999', () => {
    const sdk = makeSdk();
    sdk.identify('u_free', { plan: { id: 'free', name: 'Free' } });
    sdk.updateUsage({ generations: 10 });
    expect(genLimit(sdk)).toBe(30);
  });

  it('Pro user → 2000', () => {
    const sdk = makeSdk();
    sdk.identify('u_pro', { plan: { id: 'pro', name: 'Pro' } });
    sdk.updateUsage({ generations: 10 });
    expect(genLimit(sdk)).toBe(2000);
  });

  it('switching plan in-session updates the limit', () => {
    const sdk = makeSdk();
    sdk.identify('u', { plan: { id: 'free', name: 'Free' } });
    sdk.updateUsage({ generations: 10 });
    expect(genLimit(sdk)).toBe(30);
    sdk.identify('u', { plan: { id: 'pro', name: 'Pro' } });
    expect(genLimit(sdk)).toBe(2000);
  });
});
