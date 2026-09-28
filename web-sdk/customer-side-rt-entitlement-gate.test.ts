/**
 * BL-0370 (sdk-internal #558 / BL-0365; plan 279 PD-3): pins that everything
 * gated on a built-in `rt.<dimension>.<value>` segment — checkEntitlement()/
 * `can()`, getEligiblePlans() variation eligibility, and
 * explainPlacementDecision() — follows ONLY the DELIVERED
 * `builtin_dimensions` field and rejects a `custom.rt_*` spoof, on the same
 * user, the same Playbook, the same call.
 *
 * `getTargeting()` now derives its `rt_*` traits via `buildTargetingState`
 * (customer-side.ts, the loop over `isReservedTraitKey` right after usage
 * traits are merged): any `custom.rt_*` key is deleted first, then the
 * reserved traits are re-stamped from `builtin_dimensions` alone. Before
 * #558 this was inverted — a throwaway probe on `main` showed the delivered
 * case DENIED and the spoofed case ALLOWED, exactly backwards. This file
 * commits that probe as a permanent regression lock.
 *
 * Fixture style follows `customer-side-catalog.test.ts` (getEligiblePlans)
 * and `entitlement-fail-closed.test.ts` / `customer-side-usage-limit.test.ts`
 * (entitlement_rules `targets` + `segment_ids` shape). The `rt.*` segment
 * definition itself is taken from the catalogue generator
 * (`generateBuiltinSegments`), never hand-written, so it can't drift from
 * what a hosted Playbook actually exports (BL-0365's `local-builtin-segments`
 * module does the same for a local Playbook).
 *
 * BL-0381 (D-46): "delivered" means delivered by the authenticated
 * `GET /api/sdk/client-context` response — the only browser source. An
 * app-set `builtin_dimensions` (via `update()`) is dropped and denies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RevTurbineConfig } from '@revt-eng/schema';
import { generateBuiltinSegments } from '@revt-eng/core';
import { RevTurbineCustomerSdk } from './customer-side';

// The one catalogue-generated definition this suite gates on. Reused as-is —
// never hand-typed — so a change to the generator's shape fails this test
// instead of silently drifting from the built-in it claims to be.
const [PAID_SEGMENT] = generateBuiltinSegments({ dimensions: ['subscription_state'] }).segments
  .filter((segment) => segment.handle === 'rt.subscription_state.paid');

function playbook(): RevTurbineConfig {
  return {
    version: '1.0.0',
    plans: [
      { unique_handle: 'starter', name: 'Starter', tier_position: 0, sort_order: 0, visibility: 'public' },
    ],
    plan_variations: [
      { handle: 'starter_default', plan_handle: 'starter', billing_period: 'monthly', segment_handle: null, price_amount: 4900, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
      { handle: 'starter_paid_upsell', plan_handle: 'starter', billing_period: 'monthly', segment_handle: 'rt.subscription_state.paid', price_amount: 2900, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
    ],
    entitlements: [
      { unique_handle: 'paid_feature', name: 'Paid feature', type: 'feature' },
    ],
    entitlement_rules: [
      {
        id: 'er_paid_feature',
        entitlement_id: 'paid_feature',
        targets: [{ kind: 'plan', id: 'starter' }],
        segment_ids: ['rt.subscription_state.paid'],
        kind: 'feature',
        enabled: true,
      },
    ],
    segments: [PAID_SEGMENT],
    content_ui_paths: [],
    surface_templates: [
      { id: 'banner_tpl', surface_type: 'banner' },
    ],
    placements: [
      {
        id: 'pl_paid_offer',
        name: 'Paid offer',
        category: 'fixed',
        order: 0,
        trigger: { type: 'surface_render', slot_id: 'offer_slot' },
        payloads: [
          {
            id: 'pl_paid_offer_p0',
            target: { plan_ids: [], segment_chips: ['rt.subscription_state.paid'] },
            surfaces: [{ template_id: 'banner_tpl', fields: { header: 'Paid offer', body: 'body' }, ctas: [] }],
          },
        ],
      },
    ],
  } as unknown as RevTurbineConfig;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Deliver `dims` the only way the browser receives them: the client-context fetch. */
async function deliver(instance: RevTurbineCustomerSdk, dims: Record<string, string>): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => (
    String(url).endsWith('/api/sdk/client-context')
      ? new Response(JSON.stringify({ builtin_dimensions: dims }))
      : new Response('{}')
  )));
  await instance.fetchClientContext('rt_client_rt_gate');
}

function sdk(): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_rt_gate',
    apiKey: 'test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: playbook() },
  });
}

describe('BL-0370: rt.* segment gating follows builtin_dimensions, never a custom.rt_* spoof', () => {
  describe('checkEntitlement', () => {
    it('grants when builtin_dimensions.subscription_state is delivered by client-context', async () => {
      const instance = sdk();
      instance.identify('user_1', { plan_handle: 'starter' });
      await deliver(instance, { subscription_state: 'paid' });

      const result = await instance.checkEntitlement('paid_feature');
      expect(result.allowed).toBe(true);
      expect(result.status).toBe('allowed');
    });

    it('denies when the app sets builtin_dimensions itself via update() (D-46, BL-0381)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const instance = sdk();
      instance.identify('user_1', { plan_handle: 'starter' });
      instance.update({ builtin_dimensions: { subscription_state: 'paid' } } as never);

      const result = await instance.checkEntitlement('paid_feature');
      expect(result.allowed).toBe(false);
      expect(result.status).toBe('denied');
    });

    it('denies when only custom.rt_subscription_state is set (spoof)', async () => {
      const instance = sdk();
      instance.identify('user_1', { plan_handle: 'starter', custom: { rt_subscription_state: 'paid' } });

      const result = await instance.checkEntitlement('paid_feature');
      expect(result.allowed).toBe(false);
      expect(result.status).toBe('denied');
      expect(result.reason).toBe('no_matching_entitlement_rule');
    });
  });

  describe('getEligiblePlans', () => {
    it('surfaces the rt.subscription_state.paid-gated variation when the dimension is delivered', async () => {
      const instance = sdk();
      instance.identify('user_1', { plan_handle: 'starter' });
      await deliver(instance, { subscription_state: 'paid' });

      const plans = await instance.getEligiblePlans();
      expect(plans.map((plan) => plan.variationHandle)).toEqual(['starter_paid_upsell']);
    });

    it('falls back to the unsegmented variation when only custom.rt_subscription_state is spoofed', async () => {
      const instance = sdk();
      instance.identify('user_1', { plan_handle: 'starter', custom: { rt_subscription_state: 'paid' } });

      const plans = await instance.getEligiblePlans();
      expect(plans.map((plan) => plan.variationHandle)).toEqual(['starter_default']);
    });
  });

  describe('explainPlacementDecision agrees with the decision for the same inputs', () => {
    it('renders the rt.subscription_state.paid-chipped placement when the dimension is delivered', async () => {
      const instance = sdk();
      instance.identify('user_1', { plan_handle: 'starter' });
      await deliver(instance, { subscription_state: 'paid' });
      const placementId = await instance.registerSurfaceSlot({
        id: 'offer_slot', name: 'offer', surfaceTemplateIds: ['banner_tpl'],
      });

      const explanation = await instance.explainPlacementDecision({ placementId, userId: 'user_1' });
      expect(explanation.targeting.segmentIds).toContain('rt.subscription_state.paid');
      expect(explanation.eligiblePayloads[0]?.matchesSegment).toBe(true);
      expect(Boolean(explanation.decision.output)).toBe(true);

      const entitlement = await instance.checkEntitlement('paid_feature');
      expect(entitlement.allowed).toBe(true);
    });

    it('does not render the same placement for a custom.rt_subscription_state spoof, and the entitlement agrees', async () => {
      const instance = sdk();
      instance.identify('user_1', { plan_handle: 'starter', custom: { rt_subscription_state: 'paid' } });
      const placementId = await instance.registerSurfaceSlot({
        id: 'offer_slot', name: 'offer', surfaceTemplateIds: ['banner_tpl'],
      });

      const explanation = await instance.explainPlacementDecision({ placementId, userId: 'user_1' });
      expect(explanation.targeting.traits.rt_subscription_state).toBeUndefined();
      expect(explanation.targeting.segmentIds).not.toContain('rt.subscription_state.paid');
      expect(explanation.eligiblePayloads[0]?.matchesSegment).toBe(false);
      expect(Boolean(explanation.decision.output)).toBe(false);

      const entitlement = await instance.checkEntitlement('paid_feature');
      expect(entitlement.allowed).toBe(false);
    });
  });
});
