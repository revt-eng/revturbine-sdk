/**
 * Plan 114 TASK-2 — web-SDK treatment-interaction path.
 *
 * `trackTreatmentInteraction` flushes to `POST /api/events/interactions` (the
 * control-plane route that writes `placement_presentations`), carrying the
 * presentation context — `surface_slot_id` / `surface_template_id` /
 * `payload_id` — so slot/payload discovery + health analytics are complete.
 * Before this the SDK POSTed to `/api/touchpoints/transition`, which never
 * existed, so presentations 404'd into the void.
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
    tenantId: 'tenant_abc',
    apiKey: 'sk_secret_key',
    ingestPublicKey: 'pub_ingest_key',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

/** The interaction queue flush is fire-and-forget — let its microtask settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function interactionCall() {
  const hit = calls.find((c) => c.url.endsWith('/api/events/interactions'));
  expect(hit, 'expected a POST to /api/events/interactions').toBeDefined();
  const parsed = JSON.parse(String(hit!.init.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
  return { ...hit!, row: Array.isArray(parsed) ? parsed[0] : parsed };
}

describe('web-SDK treatment interactions → /api/events/interactions', () => {
  it('POSTs the presentation context (surface_slot_id / surface_template_id / payload_id)', async () => {
    const sdk = makeSdk();
    await sdk.trackTreatmentInteraction({
      userId: 'end_user_1',
      placementId: 'pl_upgrade',
      interactionType: 'impression',
      surfaceSlotId: 'dashboard_promo',
      surfaceTemplateId: 'banner_v1',
      payloadId: 'payload_9',
    });
    await settle();

    const { url, init, row } = interactionCall();
    expect(url).toBe('https://edge.example.com/api/events/interactions');
    expect(init.method).toBe('POST');
    expect(row).toMatchObject({
      user_id: 'end_user_1',
      placement_id: 'pl_upgrade',
      interaction_type: 'impression',
      surface_slot_id: 'dashboard_promo',
      surface_template_id: 'banner_v1',
      payload_id: 'payload_9',
    });
  });

  it('no longer posts to the never-implemented /api/touchpoints/transition route', async () => {
    const sdk = makeSdk();
    await sdk.trackTreatmentInteraction({ userId: 'u', placementId: 'p', interactionType: 'dismiss' });
    await settle();

    expect(calls.some((c) => c.url.endsWith('/api/touchpoints/transition'))).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/api/events/interactions'))).toBe(true);
  });
});
