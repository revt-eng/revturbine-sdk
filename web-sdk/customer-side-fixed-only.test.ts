/**
 * Plan 45 TASK-5 / AC-6 — `fixedOnly` SDK config wiring.
 *
 * Pins the contract: when `rt.getPlacement({ slotId, fixedOnly: true })`
 * is called against a mixed (Fixed + Conversion) candidate set for the
 * same slot, the resolver returns the Fixed candidate. When no Fixed
 * candidate matches, returns null even if other categories do match.
 *
 * Also pins the deprecation of the legacy `enableCategoryPipelineLocalMode`
 * flag (Q-3 (c)): the SDK now always runs the category-aware pipeline
 * in local-only mode, with no opt-in flag.
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

function makeOutput(
  outputId: string,
  category: string,
  slotId: string,
): PlacementOutput {
  return {
    output_id: outputId,
    rule_id: `rule_${outputId}`,
    decision_id: `dec_${outputId}`,
    config_version: 'v1',
    category,
    surface: { type: 'banner', template: 'banner_placement', slot_id: slotId },
    content: {},
    cta_path: {},
    present_upsell: false,
  } as unknown as PlacementOutput;
}

function lookupKey(slotId: string, surfaceType = 'banner'): string {
  // Matches localPlacementLookupKey: slotId::surfaceType::ent::plan::placement
  return [slotId, surfaceType, '', '', ''].join('::');
}

function makeLocalSdk(
  candidates: Record<string, PlacementOutput>,
  over: Partial<RevTurbineInitOptions> = {},
): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_fixed_only',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: {
      initialData: {
        placementsByLookupKey: candidates,
      },
    },
    ...over,
  });
}

describe('rt.getPlacement({ fixedOnly: true })', () => {
  const slotId = 'header_upgrade';

  it('AC-6: returns the Fixed candidate from a mixed (Fixed + Conversion) set', async () => {
    const fixed = makeOutput('out_fixed', 'fixed', slotId);
    const conversion = makeOutput('out_conv', 'conversion', slotId);
    const sdk = makeLocalSdk({
      [lookupKey(slotId)]: fixed,
      // Seed under a slightly different key but matching slot via
      // localOutputMatchesConfig; the candidate-collection loop in
      // localPlacementForConfig walks every entry and matches by slot.
      [`${slotId}::banner::ent_conv::::`]: conversion,
    });

    const result = await sdk.getPlacement({ slotId, surfaceType: 'banner', fixedOnly: true });
    expect(result?.output_id).toBe('out_fixed');
  });

  it('AC-6: returns null when no Fixed candidate matches, even with other categories present', async () => {
    const conversion = makeOutput('out_conv', 'conversion', slotId);
    const retention = makeOutput('out_ret', 'retention', slotId);
    const sdk = makeLocalSdk({
      [lookupKey(slotId)]: conversion,
      [`${slotId}::banner::ent_ret::::`]: retention,
    });

    const result = await sdk.getPlacement({ slotId, surfaceType: 'banner', fixedOnly: true });
    expect(result).toBeNull();
  });

  it('without fixedOnly: returns the highest-priority candidate (Fixed beats Conversion)', async () => {
    const fixed = makeOutput('out_fixed', 'fixed', slotId);
    const conversion = makeOutput('out_conv', 'conversion', slotId);
    const sdk = makeLocalSdk({
      [lookupKey(slotId)]: fixed,
      [`${slotId}::banner::ent_conv::::`]: conversion,
    });

    // Pipeline always runs now (Q-3 (c) deprecated the legacy flag);
    // Fixed (tier 2) outranks Conversion (tier 4).
    const result = await sdk.getPlacement({ slotId, surfaceType: 'banner' });
    expect(result?.output_id).toBe('out_fixed');
  });
});
