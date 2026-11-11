/**
 * Plan 114 TASK-2 — web-SDK treatment-interaction path.
 *
 * `trackTreatmentInteraction` reports the interaction as ONE
 * `placement_interaction` clickstream event in the `/api/track` batch (EP-1692:
 * the separate `/api/events/interactions` POST lane is gone), carrying the
 * presentation context — `surface_slot_id` / `surface_template_id` /
 * `payload_id` — so slot/payload discovery + health analytics are complete.
 * The wire columns `surface_slot_id` / `payload_id` / `placement_id` /
 * `experiment_id` / `variant_key` lift from the same payload.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];

function okResponse(): Response {
  return { ok: true, status: 202, json: async () => ({ accepted: 1 }), text: async () => '' } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(okResponse());
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    user: { id: 'u_test' },
    tenantId: 'tenant_abc',
    apiKey: 'sk_secret_key',
    publicKey: 'pub_ingest_key',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

/**
 * Flush the batch, then read the `placement_interaction` event the SDK put in
 * the `/api/track` body: its payload (the record) and its wire row (the lifted
 * columns).
 */
async function interactionCall(sdk: RevTurbineCustomerSdk) {
  await sdk.flushEvents();
  const track = calls.filter((c) => c.url.endsWith('/api/track'));
  const events = track.flatMap((c) => (JSON.parse(String(c.init.body)) as { events: Array<Record<string, unknown>> }).events);
  const hit = events.filter((e) => e.event_name === 'placement_interaction');
  expect(hit, 'expected a placement_interaction event in the /api/track batch').toHaveLength(1);
  const wire = hit[0];
  const row = (JSON.parse(String(wire.properties)) as { payload: Record<string, unknown> }).payload;
  return { url: track[0].url, init: track[0].init, row, wire };
}

describe('web-SDK treatment interactions → one placement_interaction event on /api/track', () => {
  it('carries the presentation context (surface_slot_id / surface_template_id / payload_id)', async () => {
    const sdk = makeSdk();
    await sdk.trackTreatmentInteraction({
      userId: 'end_user_1',
      placementId: 'pl_upgrade',
      interactionType: 'impression',
      surfaceSlotId: 'dashboard_promo',
      surfaceTemplateId: 'banner_v1',
      payloadId: 'payload_9',
    });

    const { url, init, row, wire } = await interactionCall(sdk);
    expect(url).toBe('https://edge.example.com/api/track');
    expect(init.method).toBe('POST');
    expect(row).toMatchObject({
      user_id: 'end_user_1',
      placement_id: 'pl_upgrade',
      interaction_type: 'impression',
      surface_slot_id: 'dashboard_promo',
      surface_template_id: 'banner_v1',
      payload_id: 'payload_9',
    });
    // The lifted wire columns come from the same payload.
    expect(wire).toMatchObject({
      placement_id: 'pl_upgrade',
      surface_slot_id: 'dashboard_promo',
      payload_id: 'payload_9',
    });
  });

  it('reports each interaction once and never posts to a second lane', async () => {
    const sdk = makeSdk();
    await sdk.trackTreatmentInteraction({ userId: 'u', placementId: 'p', interactionType: 'dismiss' });
    await interactionCall(sdk);

    expect(calls.some((c) => c.url.endsWith('/api/touchpoints/transition'))).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/api/events/interactions'))).toBe(false);
  });
});

describe('experiment attribution on interactions (plan 183 TASK-6 / AC-4)', () => {
  it('carries experiment_id + variant_key onto the presentation row', async () => {
    const sdk = makeSdk();
    await sdk.trackTreatmentInteraction({
      userId: 'end_user_1',
      placementId: 'pl_upgrade',
      interactionType: 'impression',
      payloadId: 'payload_9',
      experimentId: 'pricing_test',
      variantKey: 'variant_b',
    });

    const { row, wire } = await interactionCall(sdk);
    expect(row).toMatchObject({
      placement_id: 'pl_upgrade',
      experiment_id: 'pricing_test',
      variant_key: 'variant_b',
    });
    // Lifted to the wire columns the experiment pipes group by.
    expect(wire).toMatchObject({ experiment_id: 'pricing_test', variant_key: 'variant_b' });
  });

  it('reports a control assignment — control is enrollment, not absence', async () => {
    const sdk = makeSdk();
    await sdk.trackTreatmentInteraction({
      userId: 'u', placementId: 'p', interactionType: 'impression',
      experimentId: 'pricing_test', variantKey: 'control',
    });

    expect((await interactionCall(sdk)).row).toMatchObject({
      experiment_id: 'pricing_test',
      variant_key: 'control',
    });
  });

  it('omits both keys entirely for a user who is not enrolled', async () => {
    // Absence must not become an empty string or null: `experiment_perf` keys on
    // this, and a blank arm would collapse the unenrolled into a real cohort.
    const sdk = makeSdk();
    await sdk.trackTreatmentInteraction({
      userId: 'u', placementId: 'p', interactionType: 'impression',
    });

    const { row, wire } = await interactionCall(sdk);
    expect(row).not.toHaveProperty('experiment_id');
    expect(row).not.toHaveProperty('variant_key');
    // The wire columns stay null, never an empty arm.
    expect(wire.experiment_id).toBeNull();
    expect(wire.variant_key).toBeNull();
  });

  it('carries attribution on a conversion, not just an impression', async () => {
    const sdk = makeSdk();
    await sdk.trackTreatmentInteraction({
      userId: 'u', placementId: 'p', interactionType: 'cta_completed',
      experimentId: 'pricing_test', variantKey: 'variant_b',
    });

    expect((await interactionCall(sdk)).row).toMatchObject({
      interaction_type: 'cta_completed',
      experiment_id: 'pricing_test',
      variant_key: 'variant_b',
    });
  });
});
