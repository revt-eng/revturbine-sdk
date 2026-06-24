/**
 * Plan 43 TASK-14 — `cap.v1` enforcement in getPlacementDecision.
 *
 * Pins the wiring: when `enableClientCapsEnforcement` is true and a
 * placement's output carries a `max_per_period: { count: 1, period:
 * 'lifetime' }` policy, the FIRST decision returns visible:true and the
 * subsequent calls return visible:false with a `cap_exceeded` reason.
 *
 * The AC scenario in the plan: 3 trial_progress placements with
 * `max_per_period: 1 lifetime`, walk a user through 25→50→70%, assert
 * exactly one placement fires per step + no re-fires on subsequent
 * decisions for the same placement. Each placement has its own cap key
 * (output.output_id differs), so they're independent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import type { PlacementOutput } from '@revt-eng/core';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function outputWithLifetimeCap(outputId: string, ruleId: string): PlacementOutput {
  return {
    output_id: outputId,
    rule_id: ruleId,
    decision_id: `dec_${outputId}`,
    config_version: 'v1',
    category: 'trials',
    surface: { type: 'modal', template: 'modal_overlay', slot_id: 'slot_trial' },
    content: {},
    cta_path: {},
    present_upsell: false,
    // The cap-rule extractor walks the output's root + its content/payload/
    // surface looking for a `caps.max_per_period`. Putting it at the root
    // matches scaffold's PlacementOutput shape.
    caps: { max_per_period: { count: 1, period: 'lifetime' } },
  } as unknown as PlacementOutput;
}

function makeSdk(
  decisionsByPlacement: Record<string, PlacementOutput>,
  over: Partial<RevTurbineInitOptions> = {},
): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_cap_test',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    placementBehavior: { enableClientCapsEnforcement: true },
    localRuntime: {
      resolvers: {
        getPlacementDecision: async (input) => {
          const output = decisionsByPlacement[input.placementId];
          if (!output) {
            return {
              placementId: input.placementId,
              requestId: 'rid_missing',
              visible: false,
              decisionSource: 'fallback',
              reasonCodes: ['placement_not_in_test_dataset'],
              content: { header: '', body: '', cta_label: '' },
            };
          }
          return {
            placementId: input.placementId,
            requestId: `rid_${input.placementId}`,
            visible: true,
            decisionSource: 'cache',
            reasonCodes: [],
            content: { header: 'Milestone', body: '', cta_label: 'Upgrade' },
            output,
          };
        },
      },
    },
    ...over,
  });
  // Bypass the generatePlacementId hashing path that `registerPlacement`
  // applies — these tests need the placement record keyed by the literal
  // input id so `getPlacementDecision({ placementId: 'pl_trial_50' })`
  // finds it. Casting through `unknown` is the path of least disruption
  // for a private-map seed in a unit test.
  const placements = (sdk as unknown as { placements: Map<string, { id: string; name: string; route: string }> }).placements;
  for (const placementId of Object.keys(decisionsByPlacement)) {
    placements.set(placementId, { id: placementId, name: placementId, route: '/' });
  }
  return sdk;
}

describe('Plan 43 TASK-14 — cap.v1 enforcement in getPlacementDecision', () => {
  it('first decision allows; second returns visible:false with cap_exceeded reason', async () => {
    const sdk = makeSdk({
      pl_trial_50: outputWithLifetimeCap('pay_50', 'pl_trial_50'),
    });

    const first = await sdk.getPlacementDecision({ placementId: 'pl_trial_50', userId: 'u1' });
    expect(first.visible, 'first call should fire').toBe(true);

    const second = await sdk.getPlacementDecision({ placementId: 'pl_trial_50', userId: 'u1' });
    expect(second.visible, 'second call should be suppressed by cap').toBe(false);
    expect(second.reasonCodes).toEqual(expect.arrayContaining([expect.stringContaining('cap')]));
  });

  it('walks 25 → 50 → 70 milestones with one fire per step and no re-fires', async () => {
    const sdk = makeSdk({
      pl_trial_25: outputWithLifetimeCap('pay_25', 'pl_trial_25'),
      pl_trial_50: outputWithLifetimeCap('pay_50', 'pl_trial_50'),
      pl_trial_70: outputWithLifetimeCap('pay_70', 'pl_trial_70'),
    });

    // Step 1 — 25% milestone: only pl_trial_25 is asked for in real flow,
    // but we exercise the cap-state isolation between siblings by walking
    // all three and asserting each fires exactly once on first ask.
    const d25_a = await sdk.getPlacementDecision({ placementId: 'pl_trial_25', userId: 'u1' });
    const d50_a = await sdk.getPlacementDecision({ placementId: 'pl_trial_50', userId: 'u1' });
    const d70_a = await sdk.getPlacementDecision({ placementId: 'pl_trial_70', userId: 'u1' });
    expect(d25_a.visible).toBe(true);
    expect(d50_a.visible).toBe(true);
    expect(d70_a.visible).toBe(true);

    // Step 2 — repeat: all three should now be capped (lifetime=1 each).
    const d25_b = await sdk.getPlacementDecision({ placementId: 'pl_trial_25', userId: 'u1' });
    const d50_b = await sdk.getPlacementDecision({ placementId: 'pl_trial_50', userId: 'u1' });
    const d70_b = await sdk.getPlacementDecision({ placementId: 'pl_trial_70', userId: 'u1' });
    expect(d25_b.visible).toBe(false);
    expect(d50_b.visible).toBe(false);
    expect(d70_b.visible).toBe(false);
  });

  it('does NOT enforce caps when enableClientCapsEnforcement is false (the default)', async () => {
    const sdk = makeSdk(
      { pl_trial_50: outputWithLifetimeCap('pay_50', 'pl_trial_50') },
      { placementBehavior: { enableClientCapsEnforcement: false } },
    );

    const first = await sdk.getPlacementDecision({ placementId: 'pl_trial_50', userId: 'u1' });
    const second = await sdk.getPlacementDecision({ placementId: 'pl_trial_50', userId: 'u1' });
    expect(first.visible).toBe(true);
    expect(second.visible).toBe(true);
  });
});
