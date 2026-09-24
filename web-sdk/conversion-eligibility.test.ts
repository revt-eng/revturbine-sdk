/** Plan 254 TASK-3: conversions emit analytics without changing eligibility. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import type { PlacementOutput } from '@revt-eng/core';
import type { RevTurbineStorage } from './storage';

const SLOT = 'slot_upgrade';
const OTHER_SLOT = 'slot_other';

/** A minimal in-memory store so two SDK instances can share persisted state. */
function createSharedStorage(map = new Map<string, string>()): RevTurbineStorage {
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

function outputFor(slotId: string, category: string = 'gated'): PlacementOutput {
  return {
    output_id: `payload_${slotId}`,
    rule_id: `rule_${slotId}`,
    decision_id: `dec_${slotId}`,
    config_version: 'v1',
    category,
    surface: { type: 'banner', template: 'banner_placement', slot_id: slotId },
    content: { header: 'Upgrade Now', body: 'Get dashboard access', cta_label: 'View Plans' },
    cta_path: {},
    present_upsell: true,
  } as unknown as PlacementOutput;
}

function makeSdk(
  persistentStorage: RevTurbineStorage,
  over: Partial<RevTurbineInitOptions> = {},
  category: string = 'gated',
): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_convert_test',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
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
          output: outputFor(input.placementId, category),
        }),
      },
    },
    ...over,
  } as unknown as RevTurbineInitOptions);
}

function makeRegisteredSdk(
  persistentStorage: RevTurbineStorage,
  over: Partial<RevTurbineInitOptions> = {},
  category: string = 'gated',
): RevTurbineCustomerSdk {
  const sdk = makeSdk(persistentStorage, over, category);
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

describe.each(['fixed', 'gated', 'upsell', 'usage', 'trials', 'retention'])('%s interaction eligibility', (category) => {
  it('keeps conversion analytics and remains eligible immediately and after reload', async () => {
    const storage = createSharedStorage();
    const sdk = makeRegisteredSdk(storage, {}, category);
    const emit = vi.spyOn(sdk, 'emitPlatformEvent');
    const before = await decide(sdk, SLOT);
    expect(before.visible).toBe(true);
    await sdk.convert(String(before.output?.output_id));
    expect(emit.mock.calls.filter(([event, payload]) => event === 'placement_interaction'
      && payload.interaction_type === 'cta_completed')).toHaveLength(1);
    expect((await sdk.impressionHistory.queryHistory({ outcomes: ['cta_completed'] }))).toHaveLength(1);
    expect((await decide(sdk, SLOT)).visible).toBe(true);
    const second = makeRegisteredSdk(storage, {}, category);
    expect((await decide(second, SLOT)).visible).toBe(true);
    expect((await decide(second, OTHER_SLOT)).visible).toBe(true);
  });

  it.each(['dismiss', 'remind_me_later', 'cta_clicked'] as const)('%s follows the resolved category, including reload', async (interactionType) => {
    const storage = createSharedStorage();
    const sdk = makeRegisteredSdk(storage, {}, category);
    const before = await decide(sdk, SLOT);
    expect(before.visible).toBe(true);
    await sdk.trackTreatmentInteraction({
      placementId: SLOT, userId: 'user_1', payloadId: before.output?.output_id, interactionType,
    });
    const exempt = category === 'fixed' || category === 'gated';
    expect((await decide(sdk, SLOT)).visible).toBe(exempt);
    expect((await decide(makeRegisteredSdk(storage, {}, category), SLOT)).visible).toBe(exempt);
    expect((await decide(sdk, OTHER_SLOT)).visible).toBe(true);
  });

  it('ignores a legacy conversion window through reload and later impressions', async () => {
    const values = new Map<string, string>();
    const storage = createSharedStorage(values);
    const first = makeRegisteredSdk(storage, {}, category);
    const before = await decide(first, SLOT);
    await first.convert(String(before.output?.output_id));
    const persisted = [...values].find(([key]) => key.startsWith('revturbine:interaction-state:'));
    expect(persisted).toBeDefined();
    const states: Record<string, { suppressedUntil?: number }> = JSON.parse(persisted![1]);
    for (const state of Object.values(states)) state.suppressedUntil = Date.now() + 300_000;
    storage.setItem(persisted![0], JSON.stringify(states));
    const second = makeRegisteredSdk(storage, {}, category);
    expect((await decide(second, SLOT)).visible).toBe(true);
    await second.trackTreatmentInteraction({ placementId: SLOT, userId: 'user_1', interactionType: 'impression' });
    expect((await decide(makeRegisteredSdk(storage, {}, category), SLOT)).visible).toBe(true);
  });

  it.each([[1000, 60], [60000, 1]])('preserves independent suppression %i ms and reminder %i seconds', async (explicitMs, remindSeconds) => {
    const storage = createSharedStorage();
    const first = makeRegisteredSdk(storage, {}, category);
    const before = await decide(first, SLOT);
    const input = { placementId: SLOT, userId: 'user_1', payloadId: before.output?.output_id };
    await first.trackTreatmentInteraction({ ...input, interactionType: 'suppress', metadata: { suppress_duration_ms: explicitMs } });
    await first.trackTreatmentInteraction({ ...input, interactionType: 'remind_me_later', metadata: { remind_after_seconds: remindSeconds } });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2000);
    const second = makeRegisteredSdk(storage, {}, category);
    expect((await decide(second, SLOT)).visible).toBe(explicitMs < 2000 && (category === 'fixed' || category === 'gated'));
  });

  it('preserves explicit suppression through later interactions and reload', async () => {
    const storage = createSharedStorage();
    const sdk = makeRegisteredSdk(storage, {}, category);
    const before = await decide(sdk, SLOT);
    const input = { placementId: SLOT, userId: 'user_1', payloadId: before.output?.output_id };
    await sdk.trackTreatmentInteraction({ ...input, interactionType: 'suppress', metadata: { suppress_duration_ms: 60000 } });
    for (const interactionType of ['impression', 'dismiss', 'remind_me_later', 'cta_clicked', 'cta_completed'] as const) {
      await sdk.trackTreatmentInteraction({ ...input, interactionType });
      expect((await decide(sdk, SLOT)).visible).toBe(false);
    }
    expect((await decide(makeRegisteredSdk(storage, {}, category), SLOT)).visible).toBe(false);
  });
});
