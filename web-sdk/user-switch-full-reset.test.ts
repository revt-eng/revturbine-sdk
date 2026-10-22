/**
 * BL-0421 — switching user without a reset is a FULL reset of user-scoped
 * state, not a partial merge.
 *
 * Before: `identify(B)` / `setUserContext({ id: B })` / `hydrate()` for a
 * different user dropped only trial and usage (BL-0417); user A's plan handle,
 * plan, entitlements, payment flags, tiers, instances and custom fields were
 * merged into B, so B could be granted A's plan until the next server
 * delivery. Anonymous → identified and re-identifying the same user still
 * merge. `getUserContext()` also projects `plan_handle` and
 * `builtin_dimensions` now.
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

function playbook(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-10-21T00:00:00Z',
    plans: [
      { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
      { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 1 },
    ],
    entitlements: [{ unique_handle: 'sso', name: 'SSO', type: 'feature' }],
    entitlement_rules: [
      { id: 'r_sso_pro', entitlement_id: 'sso', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], kind: 'feature', enabled: true },
    ],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

function makeSdk(): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_bl0421',
    publicKey: 'pub_test',
    runtimeMode: 'local_only',
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: playbook() },
  });
}

/** User A: on pro, with mirrored entitlements, payment flags, tiers and custom fields. */
function identifyUserA(sdk: RevTurbineCustomerSdk): void {
  sdk.identify('user_a', {
    plan_handle: 'pro',
    plan: { handle: 'pro', name: 'Pro' },
    email: 'a@example.com',
    account_id: 'acct_a',
    custom: { team: 'a-team' },
  });
  sdk.setUserContext({ payment_failed: true, payment_at_risk: true, tiers: { support: 'gold' } });
}

function expectNothingOfUserA(sdk: RevTurbineCustomerSdk): void {
  const ctx = sdk.getUserContext();
  expect(ctx.user_id).toBe('user_b');
  expect(ctx.plan_handle).toBeUndefined();
  expect(ctx.plan).toBeUndefined();
  expect(ctx.email).toBeUndefined();
  expect(ctx.account_id).toBeUndefined();
  expect(ctx.custom).toEqual({});
  expect(ctx.payment_failed).toBeUndefined();
  expect(ctx.payment_at_risk).toBeUndefined();
  expect(ctx.tiers).toBeUndefined();
}

describe('BL-0421: a user switch without a reset carries nothing of the previous user', () => {
  it('identify(B) after A: B is not granted A\'s plan, and holds none of A\'s fields', async () => {
    const sdk = makeSdk();
    identifyUserA(sdk);
    expect((await sdk.can('sso')).allowed).toBe(true);

    sdk.identify('user_b');
    expectNothingOfUserA(sdk);
    expect((await sdk.can('sso')).allowed).toBe(false);
  });

  it('setUserContext({ id: B }) after A is a full switch too', async () => {
    const sdk = makeSdk();
    identifyUserA(sdk);
    sdk.setUserContext({ id: 'user_b' });
    expectNothingOfUserA(sdk);
    expect((await sdk.can('sso')).allowed).toBe(false);
  });

  it('B\'s own values apply after the switch', async () => {
    const sdk = makeSdk();
    identifyUserA(sdk);
    sdk.identify('user_b', { plan_handle: 'pro', custom: { team: 'b-team' } });
    const ctx = sdk.getUserContext();
    expect(ctx.plan_handle).toBe('pro');
    expect(ctx.custom).toEqual({ team: 'b-team' });
    expect(ctx.payment_failed).toBeUndefined();
    expect((await sdk.can('sso')).allowed).toBe(true);
  });

  it('anonymous → identified keeps the guest merge', () => {
    const sdk = makeSdk();
    sdk.setUserContext({ custom: { referrer: 'ad' }, plan_handle: 'pro' });
    sdk.identify('user_b');
    const ctx = sdk.getUserContext();
    expect(ctx.custom).toEqual({ referrer: 'ad' });
    expect(ctx.plan_handle).toBe('pro');
  });

  it('re-identifying the same user keeps their context', () => {
    const sdk = makeSdk();
    identifyUserA(sdk);
    sdk.identify('user_a');
    const ctx = sdk.getUserContext();
    expect(ctx.plan_handle).toBe('pro');
    expect(ctx.payment_failed).toBe(true);
    expect(ctx.custom).toEqual({ team: 'a-team' });
  });
});

describe('BL-0421: getUserContext() projects plan_handle', () => {
  it('returns the plan matching identity, absent when none was supplied', () => {
    const sdk = makeSdk();
    expect(sdk.getUserContext().plan_handle).toBeUndefined();
    sdk.identify('user_a', { plan_handle: 'pro' });
    expect(sdk.getUserContext().plan_handle).toBe('pro');
  });
});
