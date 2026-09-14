/**
 * Plan 233 TASK-14 / AC-14 — `convert()` retires the placement permanently.
 *
 * This is plan 167's own follow-up #2, written down 2026-08-10 and never filed.
 * Plan 167 AC-2 established that a confirmed conversion retires a placement for
 * good. The public `convert()` API never participated in that: it emitted a
 * `placement_interaction` platform event with `interaction_type: 'cta_completed'`
 * and stopped. It never called `recordConversion`, never routed through
 * `trackTreatmentInteraction`, and so never wrote the terminal state. A user who
 * converted through `convert()` kept being shown the upsell they already paid for.
 *
 * TWO defects sit behind AC-14, and the second is not the one the plan named.
 *
 *   1. `convert(outputId)` wrote no terminal state at all — it emitted and stopped.
 *   2. Nothing in the decision path ever READ a terminal state.
 *      `getPlacementDecision` gates only on `suppressionForState`, which checks a
 *      `suppressedUntil` timestamp — a window, never a permanent flag.
 *      `impressionHistory.isRetired` exists, is written by `recordConversion`, and
 *      had no caller anywhere in web-sdk. The 5-minute transient window written by
 *      `updateInteractionState` for `cta_completed` was the ONLY thing hiding a
 *      converted placement, and its own comment said permanent retirement was
 *      "owned by the impression history" — which was never consulted.
 *
 * So the upsell came back five minutes after checkout even through the controller
 * path, which does call `recordConversion`. Fixing only (1) would leave that
 * intact while every test went green — the same trap that let plan 167 close with
 * AC-2 marked shipped.
 *
 * The resolver below always answers `visible: true`. That is deliberate: it makes
 * the SDK's own suppression/retirement gate the only thing that can hide the
 * placement, so a passing assertion cannot be explained by the decision source
 * having lost interest for some unrelated reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import type { PlacementOutput } from '@revt-eng/core';
import type { RevTurbineStorage } from './storage';

const SLOT = 'slot_upgrade';
const OTHER_SLOT = 'slot_other';

/** A minimal in-memory store so two SDK instances can share persisted state. */
function createSharedStorage(): RevTurbineStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

function outputFor(slotId: string): PlacementOutput {
  return {
    output_id: `payload_${slotId}`,
    rule_id: `rule_${slotId}`,
    decision_id: `dec_${slotId}`,
    config_version: 'v1',
    category: 'gated',
    surface: { type: 'banner', template: 'banner_placement', slot_id: slotId },
    content: { header: 'Upgrade Now', body: 'Get dashboard access', cta_label: 'View Plans' },
    cta_path: {},
    present_upsell: true,
  } as unknown as PlacementOutput;
}

function makeSdk(
  persistentStorage: RevTurbineStorage,
  over: Partial<RevTurbineInitOptions> = {},
): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_convert_test',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    persistentStorage,
    user: { id: 'user_1' },
    localRuntime: {
      resolvers: {
        getPlacementDecision: async (input) => ({
          placementId: input.placementId,
          requestId: `rid_${input.placementId}`,
          visible: true,
          decisionSource: 'local' as const,
          reasonCodes: [],
          content: { header: 'Upgrade Now', body: 'Get dashboard access', cta_label: 'View Plans' },
          output: outputFor(input.placementId),
        }),
      },
    },
    ...over,
  } as unknown as RevTurbineInitOptions);
}

function makeRegisteredSdk(
  persistentStorage: RevTurbineStorage,
  over: Partial<RevTurbineInitOptions> = {},
): RevTurbineCustomerSdk {
  const sdk = makeSdk(persistentStorage, over);
  // Seed the private registry directly, as `customer-side-cap-enforcement`
  // does: `registerPlacement` hashes the id, and these tests need the record
  // keyed by the literal slot id so `getPlacementDecision({ placementId })`
  // finds it.
  const placements = (sdk as unknown as {
    placements: Map<string, { id: string; name: string; route: string }>;
  }).placements;
  for (const slotId of [SLOT, OTHER_SLOT]) {
    placements.set(slotId, { id: slotId, name: slotId, route: '/' });
  }
  return sdk;
}

function decide(sdk: RevTurbineCustomerSdk, placementId: string) {
  return sdk.getPlacementDecision({ placementId, userId: 'user_1' });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('AC-14 — convert() retires the placement permanently', () => {
  it('retires the placement for the rest of the session', async () => {
    const sdk = makeRegisteredSdk(createSharedStorage());

    const before = await decide(sdk, SLOT);
    // Assert the placement is genuinely visible FIRST. Without this the test
    // would pass identically against a build where nothing renders at all.
    expect(before.visible).toBe(true);
    const outputId = before.output?.output_id;
    expect(typeof outputId).toBe('string');

    await sdk.convert(String(outputId));

    const after = await decide(sdk, SLOT);
    expect(after.visible).toBe(false);
  });

  it('keeps the placement retired after the transient conversion window elapses', async () => {
    // The load-bearing case, and the one that separates a real retirement from
    // the 5-minute `suppressedUntil` that `cta_completed` already wrote. A fix
    // that only routed convert() into the interaction path would pass the test
    // above and fail this one.
    const sdk = makeRegisteredSdk(createSharedStorage());

    const before = await decide(sdk, SLOT);
    expect(before.visible).toBe(true);
    await sdk.convert(String(before.output?.output_id));

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));

    const after = await decide(sdk, SLOT);
    expect(after.visible).toBe(false);
  });

  it('survives a reload — a second instance on the same storage still refuses', async () => {
    const storage = createSharedStorage();
    const first = makeRegisteredSdk(storage);

    const before = await decide(first, SLOT);
    expect(before.visible).toBe(true);
    await first.convert(String(before.output?.output_id));

    const second = makeRegisteredSdk(storage);
    const after = await decide(second, SLOT);
    expect(after.visible).toBe(false);
  });

  it('leaves an unrelated placement alone', async () => {
    // Retirement is keyed per placement. A conversion that retired everything
    // would satisfy every assertion above without being correct.
    const sdk = makeRegisteredSdk(createSharedStorage());

    const before = await decide(sdk, SLOT);
    expect(before.visible).toBe(true);
    await sdk.convert(String(before.output?.output_id));

    const other = await decide(sdk, OTHER_SLOT);
    expect(other.visible).toBe(true);
  });

  it('reports the placement as retired rather than merely cooled down', async () => {
    // dismiss and convert both end in `visible: false`, so the reason code is
    // the only thing that distinguishes "come back in a week" from "never
    // again". A host rendering a fallback needs to tell them apart.
    const sdk = makeRegisteredSdk(createSharedStorage());

    const before = await decide(sdk, SLOT);
    expect(before.visible).toBe(true);
    await sdk.convert(String(before.output?.output_id));

    const after = await decide(sdk, SLOT);
    expect(after.visible).toBe(false);
    expect(after.suppressionReason).toBe('retired_by_conversion');
  });
});
