/**
 * BL-0004 — `sdk.convert()` reloads the UserContext, and mounted surfaces
 * re-resolve against it.
 *
 * Kent, 2026-09-25: *"Converting should trigger a reloading of UserContext with
 * the new plan/billing state the user has converted to."* That ruling closes
 * plan 236 TASK-13, which recorded the opposite as a limitation: a converted
 * placement stayed on screen until the slot next happened to resolve a decision,
 * so a host calling the public convert path had to refresh by hand or use the
 * component's `ctaComplete()`.
 *
 * Why the reload is what makes the placement leave, rather than a suppression:
 * conversion writes NO cooldown and NO permanent retirement (spec §interaction
 * table; Kent's plan 254 D-9 ruling, pinned by `conversion-eligibility.test.ts`).
 * Eligibility is a function of the user's CURRENT plan. So the only honest way a
 * converted upgrade banner disappears is the user no longer matching it — which
 * requires the context to move first.
 *
 * These drive a real `RevTurbineCustomerSdk` and a real `PlacementController`.
 * The React half lives in `react/convert-reloads-user-context.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import { PlacementController } from './controllers';
import type { PlacementOutput } from '@revt-eng/core';
import type { RevTurbineStorage } from './storage';

const SLOT = 'slot_upgrade';
const USER = 'user_convert';

function createStorage(map = new Map<string, string>()): RevTurbineStorage {
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

/**
 * The upgrade output, with a CTA that names the plan it converts ONTO —
 * `cta_path.plan_handle` is the only place `convert(outputId)` can learn the
 * post-conversion plan from, since it receives an output id and nothing else.
 */
function upgradeOutput(): PlacementOutput {
  return {
    output_id: 'payload_upgrade',
    rule_id: 'pl_upgrade',
    decision_id: 'dec_upgrade',
    config_version: 'v1',
    category: 'upsell',
    surface: { type: 'banner', template: 'banner_placement', slot_id: SLOT },
    content: { header: 'Upgrade to Pro', body: 'Unlock the dashboard', cta_label: 'Upgrade' },
    cta_path: { type: 'open_checkout_modal', plan_handle: 'pro' },
    ui_path: { type: 'open_checkout_modal', plan_handle: 'pro' },
    present_upsell: true,
  } as unknown as PlacementOutput;
}

/**
 * An SDK whose local resolver shows the upgrade banner only while the held plan
 * is not already `pro` — i.e. real plan-dependent eligibility, so the assertion
 * is about the decision changing and not about a mocked visibility flag.
 */
function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  const storage = createStorage();
  let sdk: RevTurbineCustomerSdk;
  const options = {
    tenantId: 'tenant_bl0004',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    persistentStorage: storage,
    user: { id: USER, plan_handle: 'free' },
    localRuntime: {
      resolvers: {
        getPlacementDecision: async (input: { placementId: string }) => {
          const onPro = heldPlanHandle(sdk) === 'pro';
          return {
            placementId: input.placementId,
            requestId: `rid_${Math.random()}`,
            visible: !onPro,
            decisionSource: 'local' as const,
            reasonCodes: onPro ? ['plan_mismatch'] : [],
            content: onPro
              ? {}
              : { header: 'Upgrade to Pro', body: 'Unlock the dashboard', cta_label: 'Upgrade' },
            ...(onPro ? {} : { output: upgradeOutput() }),
          };
        },
      },
    },
    ...over,
  };
  sdk = new RevTurbineCustomerSdk(options as unknown as RevTurbineInitOptions);
  // `registerPlacement` hashes the id; seed the registry with the literal slot
  // id so `getPlacementDecision({ placementId: SLOT })` addresses it, exactly as
  // `conversion-eligibility.test.ts` does.
  (sdk as unknown as { placements: Map<string, unknown> }).placements
    .set(SLOT, { id: SLOT, name: SLOT, route: '/' });
  return sdk;
}

/**
 * The plan handle the SDK is HOLDING.
 *
 * `getUserContext()` projects the persisted snapshot shape and carries `plan`
 * but not the first-class `plan_handle` / `payment_at_risk` fields, so the
 * assertions read the held context directly rather than through a projection
 * that would hide the field under test.
 */
function heldPlanHandle(sdk: RevTurbineCustomerSdk): string | undefined {
  return (sdk as unknown as { userContext: { plan_handle?: string } }).userContext.plan_handle;
}

function heldPaymentAtRisk(sdk: RevTurbineCustomerSdk): boolean | undefined {
  return (sdk as unknown as { userContext: { payment_at_risk?: boolean } }).userContext.payment_at_risk;
}

/** Drain the microtask queue the controller's re-decide runs on. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a mounted slot re-decides after sdk.convert()', () => {
  it('drops the converted placement without a host refresh', async () => {
    const sdk = makeSdk();
    const controller = new PlacementController(sdk, { surfaceSlot: { id: SLOT, name: SLOT }, userId: USER });
    controller.watchUserContext();
    (controller as unknown as { _placementId: string })._placementId = SLOT;

    const decision = await controller.load();
    expect(controller.state.visible).toBe(true);
    const outputId = String(decision?.output?.output_id);

    await sdk.convert(outputId);
    await settle();

    // The reload moved the plan, and the mounted controller re-decided itself.
    expect(heldPlanHandle(sdk)).toBe('pro');
    expect(controller.state.visible).toBe(false);
    controller.dispose();
  });

  it('takes the converted plan from the CTA that named it', async () => {
    const sdk = makeSdk();
    const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    await sdk.convert(String(decision.output?.output_id));

    expect(heldPlanHandle(sdk)).toBe('pro');
    expect(sdk.getUserContext().plan).toEqual({ handle: 'pro', name: 'pro' });
  });

  it('stops re-deciding once the controller is disposed', async () => {
    const sdk = makeSdk();
    const controller = new PlacementController(sdk, { surfaceSlot: { id: SLOT, name: SLOT }, userId: USER });
    controller.watchUserContext();
    (controller as unknown as { _placementId: string })._placementId = SLOT;
    await controller.load();
    controller.dispose();

    const spy = vi.spyOn(sdk, 'getPlacementDecision');
    sdk.update({ plan_handle: 'pro' });
    await settle();

    // A controller that outlives its consumer would keep deciding forever.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the conversion is not reported as a suppression', () => {
  it('leaves the decision eligible again once the plan no longer matches nothing', async () => {
    const sdk = makeSdk();
    const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    await sdk.convert(String(decision.output?.output_id));

    // Back on `free` (a downgrade, a refund, a host correction): the placement
    // is eligible again. Conversion wrote no cooldown and no retirement.
    sdk.update({ plan_handle: 'free' });
    const after = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    expect(after.visible).toBe(true);
  });
});

describe('a failed conversion changes nothing', () => {
  it('does not move the plan or re-decide when the interaction path throws', async () => {
    const sdk = makeSdk();
    const controller = new PlacementController(sdk, { surfaceSlot: { id: SLOT, name: SLOT }, userId: USER });
    controller.watchUserContext();
    (controller as unknown as { _placementId: string })._placementId = SLOT;
    const decision = await controller.load();
    expect(controller.state.visible).toBe(true);

    vi.spyOn(sdk, 'trackTreatmentInteraction').mockRejectedValue(new Error('network down'));
    const decideSpy = vi.spyOn(sdk, 'getPlacementDecision');

    await expect(sdk.convert(String(decision?.output?.output_id))).rejects.toThrow('network down');
    await settle();

    expect(heldPlanHandle(sdk)).toBe('free');
    expect(controller.state.visible).toBe(true);
    expect(decideSpy).not.toHaveBeenCalled();
    controller.dispose();
  });
});

describe('a CTA that names no plan still notifies', () => {
  it('re-decides mounted surfaces without inventing a plan move', async () => {
    const sdk = makeSdk();
    // `navigate_to_plans` names no target plan, so there is nothing to apply
    // optimistically — but the conversion must still reach mounted surfaces.
    const output = upgradeOutput();
    const planlessOutput = { ...output, cta_path: { type: 'navigate_to_plans' }, ui_path: { type: 'navigate_to_plans' } };
    (sdk as unknown as { indexDecisionOutput: (d: unknown) => void })
      .indexDecisionOutput({ placementId: SLOT, output: planlessOutput });

    const notified = vi.fn();
    sdk.onUserContextChange(notified);

    await sdk.convert(String(output.output_id));

    expect(notified).toHaveBeenCalledTimes(1);
    expect(heldPlanHandle(sdk)).toBe('free');
  });
});

describe('a stale server plan does not undo the optimistic conversion', () => {
  it('drops a client-context plan equal to the plan converted away from', async () => {
    const sdk = makeSdk({
      clientSession: async () => 'rt_client_test',
    } as unknown as Partial<RevTurbineInitOptions>);

    // The webhook has not landed: the server still reports `free`, while the
    // trial/billing signals in the same response are authoritative and apply.
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/sdk/client-context')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ plan: { handle: 'free', name: 'Free' }, billing: { health: 'attention_required' } }),
        } as unknown as Response;
      }
      return { ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response;
    }));

    const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    await sdk.convert(String(decision.output?.output_id));
    await settle();

    expect(heldPlanHandle(sdk)).toBe('pro');
    expect(heldPaymentAtRisk(sdk)).toBe(true);
  });

  it('applies the server plan once it stops reporting the old one', async () => {
    let serverPlan = 'free';
    const sdk = makeSdk({
      clientSession: async () => 'rt_client_test',
    } as unknown as Partial<RevTurbineInitOptions>);

    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/sdk/client-context')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ plan: { handle: serverPlan, name: serverPlan } }),
        } as unknown as Response;
      }
      return { ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response;
    }));

    const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    await sdk.convert(String(decision.output?.output_id));
    await settle();
    expect(heldPlanHandle(sdk)).toBe('pro');

    // A later read that names a DIFFERENT plan — here an out-of-band move to
    // `enterprise` — clears the pending state and applies, so the suppression
    // cannot outlive the webhook lag it exists to cover.
    serverPlan = 'enterprise';
    await sdk.fetchClientContext();
    await settle();
    expect(heldPlanHandle(sdk)).toBe('enterprise');
  });
});
