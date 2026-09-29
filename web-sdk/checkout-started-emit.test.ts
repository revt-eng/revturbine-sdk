/**
 * Plan 282 TASK-8/9 — the `checkout_started` emit site.
 *
 * The event is the step between a CTA click and checkout, so the placement
 * chain can hold `success ≤ checkout_started ≤ clicked ≤ presented` (AC-8,
 * Appendix A.4). It fires on a `cta_clicked` whose CTA opens a plan picker or
 * pricing page, and NEVER for a CTA that opens checkout directly
 * (`open_checkout_modal` is "on click": no separate step, started = clicked).
 * The payload is exactly the scaffold contract: `placement_id` required, the
 * rest optional and nullable — `null` when the decision held no value, never
 * a guess.
 *
 * Plan: docs/dev-lifecycle/inprogress/282-control-center-real-data-attribution-proof.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacementOutput } from '@revt-eng/core';
import { validateEventPayload } from '@revt-eng/schema';
import { CHECKOUT_STARTED_CTA_ACTION_TYPES, RevTurbineCustomerSdk } from './customer-side';
import { PlacementController } from './controllers';

const SLOT = 'slot_upgrade';
const OUTPUT_ID = 'payload_upgrade';
const USER = 'user_click';

function output(ctaPath: Record<string, unknown>): PlacementOutput {
  return {
    output_id: OUTPUT_ID,
    rule_id: 'rule_upgrade',
    decision_id: 'dec_upgrade',
    config_version: 'v1',
    category: 'upsell',
    surface: { type: 'banner', template: 'banner_placement', slot_id: SLOT },
    content: { header: 'Upgrade to Pro', cta_label: 'See plans' },
    cta_path: ctaPath,
    present_upsell: true,
  };
}

function makeSdk(decided: PlacementOutput): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_282',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    user: { id: USER, plan_handle: 'free' },
    localRuntime: {
      resolvers: {
        getPlacementDecision: async (input: { placementId: string }) => ({
          placementId: input.placementId,
          requestId: 'rid_282',
          visible: true,
          decisionSource: 'local' as const,
          reasonCodes: [],
          content: decided.content,
          output: decided,
        }),
      },
    },
  });
  (sdk as unknown as { placements: Map<string, unknown> }).placements
    .set(SLOT, { id: SLOT, name: SLOT, route: '/' });
  return sdk;
}

type EmitSpy = ReturnType<typeof spyOnEmits>;

/** Spy on the typed emit funnel; short-circuits the network entirely. */
function spyOnEmits(sdk: RevTurbineCustomerSdk) {
  return vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
}

function emitted(spy: EmitSpy, name: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter(([eventName]) => eventName === name)
    .map(([, payload]) => payload as Record<string, unknown>);
}

async function decideThenClick(sdk: RevTurbineCustomerSdk, over: Record<string, unknown> = {}): Promise<EmitSpy> {
  const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
  const spy = spyOnEmits(sdk);
  await sdk.trackTreatmentInteraction({
    userId: USER,
    placementId: SLOT,
    interactionType: 'cta_clicked',
    payloadId: String(decision.output?.output_id),
    ...over,
  });
  return spy;
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

describe('checkout_started fires for a CTA that opens a plan picker or pricing page', () => {
  it('emits once, with the TASK-8 payload, on a navigate_to_plans click', async () => {
    const sdk = makeSdk(output({ type: 'navigate_to_plans', plan_handle: 'pro' }));
    const spy = await decideThenClick(sdk);

    const events = emitted(spy, 'checkout_started');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      placement_id: SLOT,
      payload_id: OUTPUT_ID,
      decision_id: 'dec_upgrade',
      plan_handle: 'pro',
      rule_handle: 'rule_upgrade',
    });
    // The click itself is still the canonical interaction — one of each.
    expect(emitted(spy, 'placement_interaction')).toHaveLength(1);
  });

  it('validates against the scaffold contract as emitted', async () => {
    const sdk = makeSdk(output({ type: 'navigate_to_plans', plan_handle: 'pro' }));
    const spy = await decideThenClick(sdk);

    const verdict = validateEventPayload('checkout_started', emitted(spy, 'checkout_started')[0]);
    expect(verdict.ok, 'ok' in verdict && !verdict.ok ? `${verdict.reason}: ${verdict.detail ?? ''}` : '').toBe(true);
  });

  it('accepts the authored view_plans alias for an output built by hand', async () => {
    const sdk = makeSdk(output({ type: 'view_plans' }));
    const spy = await decideThenClick(sdk);

    expect(emitted(spy, 'checkout_started')).toHaveLength(1);
    expect(CHECKOUT_STARTED_CTA_ACTION_TYPES).toContain('view_plans');
  });

  it('sends null, not a guess, for a plan the CTA never named', async () => {
    const sdk = makeSdk(output({ type: 'navigate_to_plans' }));
    const spy = await decideThenClick(sdk);

    const [event] = emitted(spy, 'checkout_started');
    expect(event.plan_handle).toBeNull();
    expect(validateEventPayload('checkout_started', event).ok).toBe(true);
  });

  it('fires through the React controller’s ctaClick() exactly once', async () => {
    const sdk = makeSdk(output({ type: 'navigate_to_plans', plan_handle: 'pro' }));
    const controller = new PlacementController(sdk, { surfaceSlot: { id: SLOT, name: SLOT }, userId: USER });
    (controller as unknown as { _placementId: string })._placementId = SLOT;
    await controller.load();
    const spy = spyOnEmits(sdk);

    await controller.ctaClick('navigate_to_plans');

    const events = emitted(spy, 'checkout_started');
    expect(events).toHaveLength(1);
    expect(events[0].placement_id).toBe(SLOT);
    expect(events[0].payload_id).toBe(OUTPUT_ID);
    expect(events[0].decision_id).toBe('dec_upgrade');
    controller.dispose();
  });
});

describe('checkout_started does NOT fire where there is no picker step', () => {
  it('not for open_checkout_modal — that CTA opens checkout directly ("on click")', async () => {
    const sdk = makeSdk(output({ type: 'open_checkout_modal', plan_handle: 'pro' }));
    const spy = await decideThenClick(sdk);

    expect(emitted(spy, 'checkout_started')).toHaveLength(0);
    expect(emitted(spy, 'placement_interaction')).toHaveLength(1);
    expect(CHECKOUT_STARTED_CTA_ACTION_TYPES).not.toContain('open_checkout_modal');
  });

  it.each(['open_upgrade_modal', 'contact_sales', 'custom_url', 'dismiss'])(
    'not for a %s CTA',
    async (type) => {
      const sdk = makeSdk(output({ type }));
      const spy = await decideThenClick(sdk);
      expect(emitted(spy, 'checkout_started')).toHaveLength(0);
    },
  );

  it.each(['impression', 'dismiss', 'remind_me_later', 'cta_completed'] as const)(
    'not on a %s interaction, even on a picker CTA',
    async (interactionType) => {
      const sdk = makeSdk(output({ type: 'navigate_to_plans', plan_handle: 'pro' }));
      const spy = await decideThenClick(sdk, { interactionType });
      expect(emitted(spy, 'checkout_started')).toHaveLength(0);
    },
  );

  it('not for a click on an output this SDK never decided — no decision, no honest step', async () => {
    const sdk = makeSdk(output({ type: 'navigate_to_plans', plan_handle: 'pro' }));
    await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    const spy = spyOnEmits(sdk);

    await sdk.trackTreatmentInteraction({ userId: USER, placementId: SLOT, interactionType: 'cta_clicked' });
    await sdk.trackTreatmentInteraction({
      userId: USER, placementId: SLOT, interactionType: 'cta_clicked', payloadId: 'out_unknown',
    });

    expect(emitted(spy, 'checkout_started')).toHaveLength(0);
    expect(emitted(spy, 'placement_interaction')).toHaveLength(2);
  });
});
