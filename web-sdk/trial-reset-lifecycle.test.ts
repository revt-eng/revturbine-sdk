/**
 * BL-0417 — trial-state follow-ups from BL-0403 (sdk #570).
 *
 * 1. A reset (`resetIdentity()` / `resetUserContext()`), or identifying a
 *    DIFFERENT user without one, must not carry the previous user's trial —
 *    the SDK-held (server-derived / hydrated) status, the trial-view source
 *    markers, or the lifecycle stage — nor their usage into the next user's
 *    trial placements, reverse-trial grants, tokens and usage thresholds.
 * 2. App-supplied trial changes (`user.trial` at init, `update({ trial })`,
 *    `setUserContext`) run the trial lifecycle evaluation, with the
 *    evaluator's once-per-stage dedupe, so `trial_midpoint` /
 *    `trial_expiring` no longer fire only from `getTrialStatus()` /
 *    `setTrialInstances()`.
 * 3. `getUserContext()` projects `trial`, `tiers`, `payment_failed`,
 *    `payment_at_risk` and `instances` (read-only copies).
 *
 * Placement assertions run through the real static resolver (`local_only` +
 * `localRuntime.playbook`) and the public `getPlacementDecision` / `can`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions, RevTurbineTrialContext } from './customer-side';
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

function placement(
  id: string,
  category: string,
  trigger: Record<string, unknown>,
  body: string,
): Record<string, unknown> {
  return {
    id,
    name: id,
    category,
    trigger,
    payloads: [
      {
        id: `${id}_p0`,
        target: { plan_ids: [], segment_chips: [] },
        surfaces: [{ template_id: 'banner', fields: { header: 'Heads up', body }, ctas: [] }],
        caps: {},
        status: 'active',
      },
    ],
    order: 0,
  };
}

/**
 * A free → pro reverse trial granting `sso`, trial placements, and a
 * 1000-call `api_calls` allowance on `free` with an 80% usage warning.
 */
function playbook(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-09-28T00:00:00Z',
    plans: [
      { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
      { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 1 },
    ],
    entitlements: [
      { unique_handle: 'sso', name: 'SSO', type: 'feature' },
      { unique_handle: 'api_calls', name: 'API Calls', type: 'usage_limit', unit: 'calls' },
    ],
    entitlement_rules: [
      {
        id: 'r_sso_free', entitlement_id: 'sso', targets: [{ kind: 'plan', id: 'free' }],
        segment_ids: [], kind: 'feature', enabled: false,
      },
      {
        id: 'r_sso_pro', entitlement_id: 'sso', targets: [{ kind: 'plan', id: 'pro' }],
        segment_ids: [], kind: 'feature', enabled: true,
      },
      {
        id: 'r_api_free', entitlement_id: 'api_calls', targets: [{ kind: 'plan', id: 'free' }],
        segment_ids: [], kind: 'usage_limit', limit_value: 1000, unit: 'calls',
        period_scope: 'per_month', enforcement: 'hard_block',
      },
    ],
    reverse_trial_rules: [
      {
        id: 'rtr_pro',
        name: 'Pro reverse trial',
        handle: 'pro_reverse',
        premium_plan_id: 'pro',
        fallback_plan_id: 'free',
        duration_days: 14,
        entitlements_during_trial: ['sso'],
        is_active: true,
      },
    ],
    segments: [],
    content_ui_paths: [],
    surface_templates: [{ id: 'banner', surface_type: 'banner', fields: [] }],
    placements: [
      placement(
        'pl_trial_ending', 'trial', { type: 'trial_ending', days_before_end: 3 },
        'Your trial ends in {{trial_days_remaining}} days.',
      ),
      placement('pl_trial_ended', 'trial', { type: 'trial_ended' }, 'Your trial has ended.'),
      placement(
        'pl_usage_warning', 'usage_credit_seat',
        { type: 'usage_threshold', entitlement_handle: 'api_calls', threshold_percent: 80 },
        '{{usage_remaining}} calls left.',
      ),
    ],
  } as unknown as RevTurbineConfig;
}

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_bl0417',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    placementBehavior: { enableTrialAutoTriggers: true },
    ...over,
    localRuntime: { playbook: playbook(), ...over.localRuntime },
  });
}

async function decide(sdk: RevTurbineCustomerSdk, name: string, userId: string) {
  const placementId = await sdk.registerPlacement({ name });
  return sdk.getPlacementDecision({ placementId, userId });
}

/** A server-evaluated hydration payload carrying a (server-derived) trial status. */
function hydration(userId: string, trial: RevTurbineTrialContext): Parameters<RevTurbineCustomerSdk['hydrate']>[0] {
  return {
    version: '1.0.0',
    request_id: 'req_1',
    evaluated_at: '2026-09-28T00:00:00Z',
    user: { id: userId },
    trial_status: trial,
  } as Parameters<RevTurbineCustomerSdk['hydrate']>[0];
}

const ENDING: RevTurbineTrialContext = {
  in_trial: true, trial_type: 'free', trial_limit_type: 'time', day_number: 12, days_remaining: 2,
};
const REVERSE_ENDING: RevTurbineTrialContext = {
  in_trial: true, trial_type: 'reverse', plan_handle: 'free', day_number: 12, days_remaining: 2,
};
const MIDPOINT: RevTurbineTrialContext = {
  in_trial: true, trial_type: 'free', trial_limit_type: 'time', day_number: 7, days_remaining: 7,
};

/** Trial lifecycle names `emitTrigger` was called with, in order. */
function spyLifecycle(): () => string[] {
  const spy = vi.spyOn(RevTurbineCustomerSdk.prototype, 'emitTrigger');
  return () => spy.mock.calls
    .map(([trigger]) => String(trigger))
    .filter((name) => name.startsWith('trial_'));
}

describe('BL-0417 (1): the previous user\'s trial does not leak into the next user', () => {
  for (const reset of ['resetIdentity', 'resetUserContext'] as const) {
    it(`${reset}(): user B after user A's server-derived trial starts with no trial`, async () => {
      const sdk = makeSdk();
      sdk.identify('u_a', { plan_handle: 'free' });
      sdk.hydrate(hydration('u_a', REVERSE_ENDING));
      expect((await decide(sdk, 'pl_trial_ending', 'u_a')).visible).toBe(true);
      expect((await sdk.can('sso')).allowed).toBe(true);

      sdk[reset]();
      sdk.identify('u_b', { plan_handle: 'free' });

      expect((await decide(sdk, 'pl_trial_ending', 'u_b')).visible).toBe(false);
      expect((await decide(sdk, 'pl_trial_ended', 'u_b')).visible).toBe(false);
      expect((await sdk.can('sso')).allowed).toBe(false);
      expect(sdk.getUserContext().trial).toBeUndefined();
      expect(await sdk.getTrialStatus()).toEqual({ in_trial: false });
    });
  }

  it('a reset also forgets which source was newer: user B\'s own app trial is used', async () => {
    const sdk = makeSdk();
    sdk.identify('u_a', { plan_handle: 'free' });
    sdk.hydrate(hydration('u_a', MIDPOINT));
    sdk.resetIdentity();
    sdk.identify('u_b', { plan_handle: 'free' });
    sdk.update({ trial: ENDING });
    const decision = await decide(sdk, 'pl_trial_ending', 'u_b');
    expect(decision.visible).toBe(true);
    expect(decision.content.body).toBe('Your trial ends in 2 days.');
  });

  it('identify() of a different user without a reset drops user A\'s trial (both sources)', async () => {
    const sdk = makeSdk();
    sdk.identify('u_a', { plan_handle: 'free' });
    sdk.update({ trial: REVERSE_ENDING });
    sdk.hydrate(hydration('u_a', REVERSE_ENDING));
    expect((await sdk.can('sso')).allowed).toBe(true);

    sdk.identify('u_b', { plan_handle: 'free' });
    expect((await decide(sdk, 'pl_trial_ending', 'u_b')).visible).toBe(false);
    expect((await sdk.can('sso')).allowed).toBe(false);
    expect(sdk.getUserContext().trial).toBeUndefined();
  });

  it('setUserContext({ id }) naming a different user is a switch too', async () => {
    const sdk = makeSdk();
    sdk.identify('u_a', { plan_handle: 'free' });
    sdk.hydrate(hydration('u_a', ENDING));
    sdk.setUserContext({ id: 'u_b', plan_handle: 'free' });
    expect((await decide(sdk, 'pl_trial_ending', 'u_b')).visible).toBe(false);
  });

  it('anonymous → identified is not a switch: the anonymous trial is kept', async () => {
    const sdk = makeSdk();
    sdk.update({ trial: ENDING });
    sdk.identify('u_a', { plan_handle: 'free' });
    expect((await decide(sdk, 'pl_trial_ending', 'u_a')).visible).toBe(true);
  });

  it('re-identifying the same user keeps their trial', async () => {
    const sdk = makeSdk();
    sdk.identify('u_a', { plan_handle: 'free' });
    sdk.hydrate(hydration('u_a', ENDING));
    sdk.identify('u_a', { plan_handle: 'free' });
    expect((await decide(sdk, 'pl_trial_ending', 'u_a')).visible).toBe(true);
  });

  it('user B with no trial after user A\'s trial emits no trial_expired', async () => {
    const lifecycle = spyLifecycle();
    const sdk = makeSdk();
    sdk.identify('u_a', { plan_handle: 'free' });
    sdk.update({ trial: MIDPOINT });
    expect(lifecycle()).toEqual(['trial_midpoint']);

    sdk.resetIdentity();
    sdk.identify('u_b', { plan_handle: 'free' });
    sdk.identify('u_c', { plan_handle: 'free' });
    expect(lifecycle()).toEqual(['trial_midpoint']);
  });
});

describe('BL-0417 (1): the usage view does not leak across a user switch', () => {
  it('resetIdentity() already clears reported usage (no leak)', async () => {
    const sdk = makeSdk();
    sdk.identify('u_a', { plan_handle: 'free' });
    sdk.updateUsage({ api_calls: 950 });
    expect((await decide(sdk, 'pl_usage_warning', 'u_a')).visible).toBe(true);

    sdk.resetIdentity();
    sdk.identify('u_b', { plan_handle: 'free' });
    expect((await decide(sdk, 'pl_usage_warning', 'u_b')).visible).toBe(false);
  });

  it('identify() of a different user without a reset drops user A\'s usage', async () => {
    const sdk = makeSdk();
    sdk.identify('u_a', { plan_handle: 'free', usage: { api_calls: { entitlement_handle: 'api_calls', unit: 'calls', amount: 900 } } });
    sdk.updateUsage({ api_calls: 950 });
    expect((await decide(sdk, 'pl_usage_warning', 'u_a')).visible).toBe(true);

    sdk.identify('u_b', { plan_handle: 'free' });
    expect((await decide(sdk, 'pl_usage_warning', 'u_b')).visible).toBe(false);
    expect(sdk.getUserContext().usage).toEqual({});
  });

  it('the new user\'s own usage still applies after a switch', async () => {
    const sdk = makeSdk();
    sdk.identify('u_a', { plan_handle: 'free' });
    sdk.updateUsage({ api_calls: 100 });
    sdk.identify('u_b', { plan_handle: 'free', usage: { api_calls: { entitlement_handle: 'api_calls', unit: 'calls', amount: 900 } } });
    const decision = await decide(sdk, 'pl_usage_warning', 'u_b');
    expect(decision.visible).toBe(true);
    expect(decision.content.body).toBe('100 calls left.');
  });
});

describe('BL-0417 (2): app-supplied trial changes run the lifecycle evaluation', () => {
  it('init `user.trial` at the midpoint emits trial_midpoint', () => {
    const lifecycle = spyLifecycle();
    makeSdk({ user: { id: 'u_1', plan_handle: 'free', trial: MIDPOINT } });
    expect(lifecycle()).toEqual(['trial_midpoint']);
  });

  it('update({ trial }) emits trial_midpoint then trial_expiring, each once', () => {
    const lifecycle = spyLifecycle();
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'free' });
    expect(lifecycle()).toEqual([]);

    sdk.update({ trial: MIDPOINT });
    sdk.update({ trial: { ...MIDPOINT } }); // unchanged — no re-fire
    sdk.update({ plan_handle: 'free' }); // unrelated change — no re-fire
    sdk.update({ trial: ENDING });
    sdk.update({ trial: { ...ENDING, day_number: 13, days_remaining: 1 } }); // still expiring
    expect(lifecycle()).toEqual(['trial_midpoint', 'trial_expiring']);
  });

  it('setUserContext({ trial }) emits trial_expiring', () => {
    const lifecycle = spyLifecycle();
    const sdk = makeSdk();
    sdk.setUserContext({ id: 'u_1', plan_handle: 'free', trial: ENDING });
    expect(lifecycle()).toEqual(['trial_expiring']);
  });

  it('both sources reporting the same threshold fire it once', async () => {
    const lifecycle = spyLifecycle();
    const sdk = makeSdk({
      localRuntime: { playbook: playbook(), resolvers: { getTrialStatus: async () => ENDING } },
    });
    sdk.identify('u_1', { plan_handle: 'free' });
    sdk.update({ trial: ENDING });
    sdk.hydrate(hydration('u_1', { ...ENDING }));
    await sdk.getTrialStatus();
    expect(lifecycle()).toEqual(['trial_expiring']);
  });

  it('an app trial that ends after a midpoint emits trial_expired', () => {
    const lifecycle = spyLifecycle();
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'free' });
    sdk.update({ trial: MIDPOINT });
    sdk.update({ trial: { in_trial: false, state: 'expired', days_remaining: 0 } });
    expect(lifecycle()).toEqual(['trial_midpoint', 'trial_expired']);
  });

  it('enableTrialAutoTriggers: false keeps app-supplied trial changes silent', () => {
    const lifecycle = spyLifecycle();
    const sdk = makeSdk({ placementBehavior: { enableTrialAutoTriggers: false } });
    sdk.identify('u_1', { plan_handle: 'free' });
    sdk.update({ trial: MIDPOINT });
    sdk.update({ trial: ENDING });
    expect(lifecycle()).toEqual([]);
  });
});

describe('BL-0417 (3): getUserContext() projects the decision-driving fields', () => {
  it('includes trial (the resolved view), tiers, payment_failed, payment_at_risk and instances', () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'free' });
    const instances = [{ product_instance_id: 'inst_1', user_id: 'u_1', usage: {}, entitlements: { sso: true } }];
    sdk.setUserContext({
      trial: ENDING,
      tiers: { seats: 'team' },
      payment_failed: true,
      payment_at_risk: false,
      instances,
    });

    const snapshot = sdk.getUserContext();
    expect(snapshot.trial).toEqual(ENDING);
    expect(snapshot.tiers).toEqual({ seats: 'team' });
    expect(snapshot.payment_failed).toBe(true);
    expect(snapshot.payment_at_risk).toBe(false);
    expect(snapshot.instances).toEqual(instances);
  });

  it('trial is the view decisions use — a newer SDK status wins over the context trial', () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'free' });
    sdk.update({ trial: ENDING });
    sdk.hydrate(hydration('u_1', MIDPOINT));
    // hydrate() keeps the wire's trial fields (no trial_limit_type).
    expect(sdk.getUserContext().trial).toMatchObject({ in_trial: true, day_number: 7, days_remaining: 7 });
  });

  it('omits the fields when nothing supplied them', () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'free' });
    const snapshot = sdk.getUserContext();
    for (const key of ['trial', 'tiers', 'payment_failed', 'payment_at_risk', 'instances'] as const) {
      expect(snapshot).not.toHaveProperty(key);
    }
  });

  it('is a read-only projection: mutating the snapshot changes nothing in the SDK', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'free' });
    sdk.setUserContext({ trial: ENDING, tiers: { seats: 'team' } });
    const snapshot = sdk.getUserContext();
    if (snapshot.trial) snapshot.trial.days_remaining = 30;
    if (snapshot.tiers) snapshot.tiers.seats = 'enterprise';

    const again = sdk.getUserContext();
    expect(again.trial?.days_remaining).toBe(2);
    expect(again.tiers).toEqual({ seats: 'team' });
    expect((await decide(sdk, 'pl_trial_ending', 'u_1')).visible).toBe(true);
  });
});
