/**
 * BL-0403 — app-supplied trial context must reach placements and grants.
 *
 * `user.trial` (init), `update({ trial })`, `setUserContext` and a server
 * action's `userContext` all merge into `userContext.trial`, but the two trial
 * readers — the placement resolver's synthesized `__providers.plan.trial*`
 * (so the scaffold `matchesTrialTrigger` gate and the `{{trial_days_*}}`
 * tokens) and the reverse-trial grant adapter (`resolveReverseTrialGrants`) —
 * read only the SDK's private trial status, which only
 * `initialData.trialStatus`, `hydrate()`, `getTrialStatus()` and
 * `setTrialInstances()` wrote. So the trial the app supplied was ignored.
 *
 * The fix is one trial view both readers share: the app's context trial or
 * the SDK-held status, whichever changed most recently.
 *
 * Every assertion runs through the real static resolver (`local_only` +
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
  vi.clearAllMocks();
});

function trialPlacement(
  id: string,
  trigger: Record<string, unknown>,
  body: string,
): Record<string, unknown> {
  return {
    id,
    name: id,
    category: 'trial',
    trigger,
    payloads: [
      {
        id: `${id}_p0`,
        target: { plan_ids: [], segment_chips: [] },
        surfaces: [
          {
            template_id: 'banner_trial',
            fields: { header: 'Trial', body },
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

/** Canonical Playbook: a free → pro reverse trial granting `sso`, plus trial placements. */
function playbook(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-09-28T00:00:00Z',
    plans: [
      { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
      { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 1 },
    ],
    entitlements: [{ unique_handle: 'sso', name: 'SSO', type: 'feature' }],
    entitlement_rules: [
      {
        id: 'r_sso_free', entitlement_id: 'sso', targets: [{ kind: 'plan', id: 'free' }],
        segment_ids: [], kind: 'feature', enabled: false,
      },
      {
        id: 'r_sso_pro', entitlement_id: 'sso', targets: [{ kind: 'plan', id: 'pro' }],
        segment_ids: [], kind: 'feature', enabled: true,
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
    surface_templates: [
      { id: 'banner_trial', surface_type: 'banner', fields: [] },
    ],
    placements: [
      trialPlacement(
        'pl_trial_ending',
        { type: 'trial_ending', days_before_end: 3 },
        'Your trial ends in {{trial_days_remaining}} days.',
      ),
      trialPlacement(
        'pl_trial_progress',
        { type: 'trial_progress', progress_percent: 50 },
        'Day {{trial_days_total}} trial, {{trial_days_remaining}} to go.',
      ),
      trialPlacement('pl_trial_ended', { type: 'trial_ended' }, 'Your trial has ended.'),
    ],
  } as unknown as RevTurbineConfig;
}

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_bl0403',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
    localRuntime: { playbook: playbook(), ...over.localRuntime },
  });
}

async function decide(sdk: RevTurbineCustomerSdk, name: string) {
  const placementId = await sdk.registerPlacement({ name });
  return sdk.getPlacementDecision({ placementId, userId: 'u_1' });
}

const ENDING: RevTurbineTrialContext = {
  in_trial: true,
  trial_type: 'free',
  trial_limit_type: 'time',
  state: 'running_out',
  day_number: 12,
  days_remaining: 2,
};

const EARLY: RevTurbineTrialContext = {
  in_trial: true,
  trial_type: 'free',
  trial_limit_type: 'time',
  state: 'active',
  day_number: 4,
  days_remaining: 10,
};

describe('BL-0403: app-supplied trial reaches trial placements', () => {
  it('init `user.trial` makes a trial_ending placement visible and fills {{trial_days_remaining}}', async () => {
    const sdk = makeSdk({ user: { id: 'u_1', plan_handle: 'free', trial: ENDING } });
    const decision = await decide(sdk, 'pl_trial_ending');
    expect(decision.visible).toBe(true);
    expect(decision.content.body).toBe('Your trial ends in 2 days.');
  });

  it('update({ trial }) makes a trial_ending placement visible', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'free' });
    expect((await decide(sdk, 'pl_trial_ending')).visible).toBe(false);

    sdk.update({ trial: { in_trial: true, trial_limit_type: 'time', day_number: 12, days_remaining: 2 } });
    const decision = await decide(sdk, 'pl_trial_ending');
    expect(decision.visible).toBe(true);
    expect(decision.content.body).toBe('Your trial ends in 2 days.');
  });

  it('setUserContext({ trial }) drives trial_progress and fills {{trial_days_total}}', async () => {
    const sdk = makeSdk();
    sdk.setUserContext({ id: 'u_1', plan_handle: 'free', trial: ENDING });
    const decision = await decide(sdk, 'pl_trial_progress');
    expect(decision.visible).toBe(true);
    expect(decision.content.body).toBe('Day 14 trial, 2 to go.');
  });

  it('an expired app-supplied trial shows trial_ended and hides trial_ending', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'free' });
    sdk.update({ trial: { in_trial: false, state: 'expired', days_remaining: 0 } });
    expect((await decide(sdk, 'pl_trial_ended')).visible).toBe(true);
    expect((await decide(sdk, 'pl_trial_ending')).visible).toBe(false);
  });

  it('a trial with days to spare does not fire trial_ending (the gate reads the real value)', async () => {
    const sdk = makeSdk({ user: { id: 'u_1', plan_handle: 'free', trial: EARLY } });
    expect((await decide(sdk, 'pl_trial_ending')).visible).toBe(false);
  });
});

describe('BL-0403: app-supplied reverse trial grants entitlements', () => {
  it('update({ trial }) with a reverse trial grants the premium entitlement', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'free' });
    expect((await sdk.can('sso')).allowed).toBe(false);

    sdk.update({
      trial: { in_trial: true, trial_type: 'reverse', plan_handle: 'free', day_number: 3, days_remaining: 11 },
    });
    expect((await sdk.can('sso')).allowed).toBe(true);
  });

  it('init `user.trial` with a reverse trial grants the premium entitlement', async () => {
    const sdk = makeSdk({
      user: {
        id: 'u_1',
        plan_handle: 'free',
        trial: { in_trial: true, trial_type: 'reverse', plan_handle: 'free', days_remaining: 11 },
      },
    });
    expect((await sdk.can('sso')).allowed).toBe(true);
  });
});

describe('BL-0403: precedence — the most recent trial change wins', () => {
  it('an initialData.trialStatus supplied alongside init `user.trial` wins (hydrated is newer)', async () => {
    const sdk = makeSdk({
      user: { id: 'u_1', plan_handle: 'free', trial: ENDING },
      localRuntime: { initialData: { trialStatus: EARLY } },
    });
    const decision = await decide(sdk, 'pl_trial_ending');
    expect(decision.visible).toBe(false);
    expect((await decide(sdk, 'pl_trial_progress')).content.body).toBe('Day 14 trial, 10 to go.');
  });

  it('hydrate() after update({ trial }) wins', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'free' });
    sdk.update({ trial: ENDING });
    expect((await decide(sdk, 'pl_trial_ending')).visible).toBe(true);

    sdk.hydrate({
      version: '1.0.0',
      request_id: 'req_1',
      evaluated_at: '2026-09-28T00:00:00Z',
      trial_status: { in_trial: true, trial_type: 'free', day_number: 4, days_remaining: 10 },
    } as Parameters<RevTurbineCustomerSdk['hydrate']>[0]);
    expect((await decide(sdk, 'pl_trial_ending')).visible).toBe(false);
  });

  it('re-sending the same app trial does not displace a newer hydrated status', async () => {
    const sdk = makeSdk();
    sdk.identify('u_1', { plan_handle: 'free' });
    sdk.update({ trial: ENDING });
    sdk.hydrate({
      version: '1.0.0',
      request_id: 'req_1',
      evaluated_at: '2026-09-28T00:00:00Z',
      trial_status: { in_trial: true, trial_type: 'free', day_number: 4, days_remaining: 10 },
    } as Parameters<RevTurbineCustomerSdk['hydrate']>[0]);
    sdk.update({ trial: { ...ENDING } });
    expect((await decide(sdk, 'pl_trial_ending')).visible).toBe(false);
  });

  it('a changed app trial after a hydrated status wins', async () => {
    const sdk = makeSdk({ localRuntime: { initialData: { trialStatus: EARLY } } });
    sdk.identify('u_1', { plan_handle: 'free' });
    expect((await decide(sdk, 'pl_trial_ending')).visible).toBe(false);

    sdk.update({ trial: ENDING });
    expect((await decide(sdk, 'pl_trial_ending')).visible).toBe(true);
  });

  it('local_only getTrialStatus() with no resolver reports the app-supplied trial', async () => {
    const sdk = makeSdk({ user: { id: 'u_1', plan_handle: 'free', trial: ENDING } });
    expect(await sdk.getTrialStatus()).toEqual(ENDING);
  });

  it('the resolved precedence survives a local_only reload', async () => {
    const storage = new Map<string, string>();
    const persistentStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    };
    const first = makeSdk({ persistentStorage, localRuntime: { initialData: { trialStatus: EARLY } } });
    first.identify('u_1', { plan_handle: 'free' });
    first.update({ trial: ENDING });
    expect((await decide(first, 'pl_trial_ending')).visible).toBe(true);

    const reloaded = makeSdk({ persistentStorage, localRuntime: { initialData: { trialStatus: EARLY } } });
    expect((await decide(reloaded, 'pl_trial_ending')).visible).toBe(true);
  });
});
