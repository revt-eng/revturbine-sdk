/**
 * Plan 46 TASK-3 / AC-4 — `recommended_plan_handle` and `recommended_plan_name`
 * personalization-token resolution.
 *
 * Pins the contract: when the user has a current commercial plan and the
 * tenant's RevTurbineConfig.plans defines a hierarchy with `tier_position`,
 * the SDK exposes the next-tier-up plan as personalization tokens
 * `recommended_plan_handle` and `recommended_plan_name`. At the top of the
 * ladder (no next tier), tokens resolve to empty strings.
 *
 * Q-2 (a) — tokens resolve via the existing personalization-token
 * derivation, alongside `usage_percent` / `trial_percent_elapsed`.
 *
 * Q-3 — the "current commercial plan" input is the base plan
 * (`userContext.plan.id`), NOT the trial-grant overlay. Audited in
 * customer-side.ts where `currentPlanHandle` is read directly from
 * `userContext.plan.id`.
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

function makeExportedConfig(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [
      { id: 'plan_starter', unique_handle: 'starter', name: 'Starter', tier_position: 0, sort_order: 0 },
      { id: 'plan_pro',     unique_handle: 'pro',     name: 'Pro',     tier_position: 1, sort_order: 0 },
      { id: 'plan_team',    unique_handle: 'team',    name: 'Team',    tier_position: 2, sort_order: 0 },
    ],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

function makeSdk(): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_recs',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { exportedConfig: makeExportedConfig() },
  });
}

describe('recommended_plan_* personalization tokens', () => {
  it('AC-4: pro-plan user → recommended_plan_handle=team, recommended_plan_name=Team', () => {
    const sdk = makeSdk();
    sdk.identify('user_pro', { plan: { id: 'pro', name: 'Pro' } });

    const tokens = sdk.getPersonalizationTokens();
    expect(tokens.recommended_plan_handle).toBe('team');
    expect(tokens.recommended_plan_name).toBe('Team');
  });

  it('AC-4: starter-plan user → recommended_plan_handle=pro, recommended_plan_name=Pro', () => {
    const sdk = makeSdk();
    sdk.identify('user_starter', { plan: { id: 'starter', name: 'Starter' } });

    const tokens = sdk.getPersonalizationTokens();
    expect(tokens.recommended_plan_handle).toBe('pro');
    expect(tokens.recommended_plan_name).toBe('Pro');
  });

  it('AC-4: top-of-ladder user (team) → tokens resolve to empty strings', () => {
    const sdk = makeSdk();
    sdk.identify('user_team', { plan: { id: 'team', name: 'Team' } });

    const tokens = sdk.getPersonalizationTokens();
    expect(tokens.recommended_plan_handle).toBe('');
    expect(tokens.recommended_plan_name).toBe('');
  });

  it('unknown current plan → tokens resolve to empty strings (no throw)', () => {
    const sdk = makeSdk();
    sdk.identify('user_unknown', { plan: { id: 'not_a_plan', name: 'Unknown' } });

    const tokens = sdk.getPersonalizationTokens();
    expect(tokens.recommended_plan_handle).toBe('');
    expect(tokens.recommended_plan_name).toBe('');
  });

  it('no current plan set → tokens resolve to empty strings', () => {
    const sdk = makeSdk();
    sdk.identify('user_anon');

    const tokens = sdk.getPersonalizationTokens();
    expect(tokens.recommended_plan_handle).toBe('');
    expect(tokens.recommended_plan_name).toBe('');
  });
});

/**
 * Plan #47 TASK-4 / AC-3 — per-placement recommendation-strategy dispatch.
 *
 * `getPersonalizationTokens(payload)` overlays the placement's authored
 * `recommendation_strategy` on top of the user-level default. Exercises all
 * six dispatch outcomes through the public overload.
 */
describe('recommendation strategy dispatch (plan #47)', () => {
  it('next_tier_up strategy → same as the default helper output (pro → team)', () => {
    const sdk = makeSdk();
    sdk.identify('user_pro', { plan: { id: 'pro', name: 'Pro' } });

    const tokens = sdk.getPersonalizationTokens({ recommendation_strategy: 'next_tier_up' });
    expect(tokens.recommended_plan_handle).toBe('team');
    expect(tokens.recommended_plan_name).toBe('Team');
  });

  it('custom strategy + valid override → resolves to the override plan', () => {
    const sdk = makeSdk();
    sdk.identify('user_starter', { plan: { id: 'starter', name: 'Starter' } });

    const tokens = sdk.getPersonalizationTokens({
      recommendation_strategy: 'custom',
      recommendation_plan_override: 'team',
    });
    expect(tokens.recommended_plan_handle).toBe('team');
    expect(tokens.recommended_plan_name).toBe('Team');
  });

  it('custom strategy + missing override → empty tokens', () => {
    const sdk = makeSdk();
    sdk.identify('user_starter', { plan: { id: 'starter', name: 'Starter' } });

    const tokens = sdk.getPersonalizationTokens({ recommendation_strategy: 'custom' });
    expect(tokens.recommended_plan_handle).toBe('');
    expect(tokens.recommended_plan_name).toBe('');
  });

  it('custom strategy + unknown override handle → empty tokens (no throw)', () => {
    const sdk = makeSdk();
    sdk.identify('user_starter', { plan: { id: 'starter', name: 'Starter' } });

    const tokens = sdk.getPersonalizationTokens({
      recommendation_strategy: 'custom',
      recommendation_plan_override: 'enterprise',
    });
    expect(tokens.recommended_plan_handle).toBe('');
    expect(tokens.recommended_plan_name).toBe('');
  });

  it('custom strategy + override === current plan → empty tokens', () => {
    const sdk = makeSdk();
    sdk.identify('user_pro', { plan: { id: 'pro', name: 'Pro' } });

    const tokens = sdk.getPersonalizationTokens({
      recommendation_strategy: 'custom',
      recommendation_plan_override: 'pro',
    });
    expect(tokens.recommended_plan_handle).toBe('');
    expect(tokens.recommended_plan_name).toBe('');
  });

  it('best_value strategy → falls back to next_tier_up output (until that plan ships)', () => {
    const sdk = makeSdk();
    sdk.identify('user_pro', { plan: { id: 'pro', name: 'Pro' } });

    const tokens = sdk.getPersonalizationTokens({ recommendation_strategy: 'best_value' });
    expect(tokens.recommended_plan_handle).toBe('team');
    expect(tokens.recommended_plan_name).toBe('Team');
  });
});
