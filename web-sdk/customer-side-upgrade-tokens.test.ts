/**
 * BL-0121 — upgrade-token resolution in the placement-decision lane.
 *
 * `applyPriceTokens` is the only token substitution the decision lane runs
 * over `RevTurbinePlacementDecision.content`. Two defects, both observed on
 * the CybeDefend demo (SDK 0.7.13, 2026-09-22):
 *
 *  1. The substitution regex covered `plan_price` / `upgrade_plan_price`
 *     only, so `{{recommended_plan_name}}` and `{{recommended_plan_handle}}`
 *     — which the SDK already derives via the parity-locked
 *     `resolveRecommendedPlanTokens` helper and exposes on
 *     `getPersonalizationTokens()` — were never written into the rendered
 *     content and reached the end user as raw `{{...}}`.
 *
 *  2. `priceTokensForProviders` prefers the variation whose billing period
 *     matches `providers.plan.billingPeriod`, but the web-sdk plan-provider
 *     projection never populated `billingPeriod` (scaffold's
 *     `core/adapters/hydration.ts` does, from `user_context.billing_period`).
 *     With the preference never satisfiable, selection fell through to
 *     `candidates[0]` — and `getEligiblePlans` breaks intra-plan ties on
 *     `variationHandle.localeCompare`, so `<plan>_annual` always sorts ahead
 *     of `<plan>_monthly`. Every price token rendered the ANNUAL amount
 *     ($228.00 for a $19/mo plan) regardless of the user's cadence.
 *
 * Spec: placement-studio-ui.md §"Messages (Message Blocks)" token table
 * (`{{upgrade_plan_price}}` = "Recommended upgrade plan price",
 * `{{recommended_plan_name}}` = "Recommended upgrade plan name (from the
 * placement's recommendation strategy)"); placement-prioritization.md §7.1
 * for the strategy dispatch that produces the handle/name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
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

/**
 * Two-tier ladder where every plan has BOTH an annual and a monthly
 * variation, named the way every real tenant config names them
 * (`<plan>_annual` / `<plan>_monthly`). `developer` mirrors the CybeDefend
 * plan from the bug report: $19.00/mo, $228.00/yr.
 */
function config(): RevTurbineConfig {
  return {
    version: '1.0.0',
    plans: [
      { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0, visibility: 'public' },
      { unique_handle: 'developer', name: 'Developer', tier_position: 1, sort_order: 0, visibility: 'public' },
      { unique_handle: 'team', name: 'Team', tier_position: 2, sort_order: 0, visibility: 'public' },
    ],
    plan_variations: [
      { handle: 'free_monthly', plan_handle: 'free', billing_period: 'monthly', segment_handle: null, price_amount: 0, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
      { handle: 'developer_annual', plan_handle: 'developer', billing_period: 'annual', segment_handle: null, price_amount: 22800, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
      { handle: 'developer_monthly', plan_handle: 'developer', billing_period: 'monthly', segment_handle: null, price_amount: 1900, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
      { handle: 'team_annual', plan_handle: 'team', billing_period: 'annual', segment_handle: null, price_amount: 99000, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
      { handle: 'team_monthly', plan_handle: 'team', billing_period: 'monthly', segment_handle: null, price_amount: 9900, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
    ],
    addons: [],
    addon_variations: [],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

const AUTHORED_BODY =
  'Upgrade to {{recommended_plan_name}} for {{upgrade_plan_price}} — you are on {{plan_name}} at {{plan_price}}.';

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_bl0121',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    locale: 'en-US',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: {
      exportedConfig: config(),
      resolvers: {
        getPlacementDecision: async (input) => ({
          placementId: input.placementId,
          requestId: `rid_${input.placementId}`,
          visible: true,
          decisionSource: 'cache',
          reasonCodes: [],
          content: {
            header: 'Unlock {{recommended_plan_name}}',
            body: AUTHORED_BODY,
            cta_label: 'Get {{recommended_plan_name}}',
          },
        }),
      },
    },
    ...over,
  });
  // Seed the placement record under the literal id so the decision path
  // resolves it (same private-map seed the cap-enforcement suite uses).
  const placements = (sdk as unknown as {
    placements: Map<string, { id: string; name: string; route: string }>;
  }).placements;
  placements.set('pl_gate', { id: 'pl_gate', name: 'pl_gate', route: '/' });
  return sdk;
}

describe('BL-0121 defect 1 — recommended_plan_* substitution in decision content', () => {
  it('substitutes {{recommended_plan_name}} into header, body and cta_label', async () => {
    const sdk = makeSdk();
    sdk.identify('user_free', { plan_handle: 'free' });

    const decision = await sdk.getPlacementDecision({ placementId: 'pl_gate', userId: 'user_free' });

    expect(decision.content.header).toBe('Unlock Developer');
    expect(decision.content.cta_label).toBe('Get Developer');
    expect(decision.content.body).toContain('Upgrade to Developer');
  });

  it('leaves no raw {{...}} token in the rendered content', async () => {
    const sdk = makeSdk();
    sdk.identify('user_free', { plan_handle: 'free' });

    const decision = await sdk.getPlacementDecision({ placementId: 'pl_gate', userId: 'user_free' });

    for (const field of ['header', 'body', 'cta_label'] as const) {
      expect(decision.content[field], `${field} still carries a raw token`).not.toMatch(/\{\{/);
    }
  });

  it('resolves to an empty string (not a raw token) at the top of the ladder', async () => {
    const sdk = makeSdk();
    sdk.identify('user_team', { plan_handle: 'team' });

    const decision = await sdk.getPlacementDecision({ placementId: 'pl_gate', userId: 'user_team' });

    expect(decision.content.header).toBe('Unlock ');
    expect(decision.content.header).not.toMatch(/\{\{/);
  });
});

describe('BL-0121 — plan_name is substituted from the Playbook, not left raw', () => {
  it('fills {{plan_name}} with the configured plan name', async () => {
    const sdk = makeSdk();
    sdk.identify('user_dev', { plan_handle: 'developer' });

    const decision = await sdk.getPlacementDecision({ placementId: 'pl_gate', userId: 'user_dev' });

    expect(decision.content.body).toContain('you are on Developer');
  });
});

describe('BL-0121 — tokens the SDK does not own are left verbatim', () => {
  it('passes an unknown token through for the render lane to resolve', async () => {
    const sdk = makeSdk({
      localRuntime: {
        exportedConfig: config(),
        resolvers: {
          getPlacementDecision: async (input) => ({
            placementId: input.placementId,
            requestId: 'rid',
            visible: true,
            decisionSource: 'cache' as const,
            reasonCodes: [],
            content: {
              header: '{{usage_percent}}% used, upgrade to {{recommended_plan_name}}',
              body: '',
              cta_label: '',
            },
          }),
        },
      },
    });
    sdk.identify('user_free', { plan_handle: 'free' });

    const decision = await sdk.getPlacementDecision({ placementId: 'pl_gate', userId: 'user_free' });

    // `usage_percent` belongs to the render lane — still a live token here.
    expect(decision.content.header).toBe('{{usage_percent}}% used, upgrade to Developer');
  });

  it('does not treat an Object.prototype key as a token', async () => {
    const sdk = makeSdk({
      localRuntime: {
        exportedConfig: config(),
        resolvers: {
          getPlacementDecision: async (input) => ({
            placementId: input.placementId,
            requestId: 'rid',
            visible: true,
            decisionSource: 'cache' as const,
            reasonCodes: [],
            content: { header: '{{constructor}}/{{toString}}', body: '', cta_label: '' },
          }),
        },
      },
    });
    sdk.identify('user_free', { plan_handle: 'free' });

    const decision = await sdk.getPlacementDecision({ placementId: 'pl_gate', userId: 'user_free' });

    expect(decision.content.header).toBe('{{constructor}}/{{toString}}');
  });
});

/**
 * NOT FIXED HERE — `{{upgrade_plan_price}}` rendering the annual total.
 *
 * `priceTokensForProviders` prefers the variation matching
 * `providers.plan.billingPeriod`, but nothing can populate that on the web
 * SDK: `billing_period` is absent from `UserContextSchema`
 * (scaffold `src/user/models/schema.ts`) and from both
 * `RECOGNIZED_IDENTIFY_KEYS` and `RECOGNIZED_UPDATE_KEYS`, so an app has no
 * supported way to tell the SDK its user's cadence. Selection therefore always
 * falls through to `candidates[0]`, and `getEligiblePlans` breaks intra-plan
 * ties on `variationHandle.localeCompare`, so `<plan>_annual` always wins.
 *
 * Closing it needs two calls this change is not entitled to make: a schema
 * field for the user's billing cadence, and a contract for which period the
 * token reflects when the cadence is unknown (the live specs are silent —
 * placement-studio-ui.md says only "Recommended upgrade plan price"). Both are
 * reported on BL-0121 for a ruling; no test here pins the current arbitrary
 * behavior, so a fix will not have to fight a golden.
 */
