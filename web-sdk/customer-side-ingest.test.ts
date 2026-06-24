/**
 * Plan 41 TASK-5 — web-SDK clickstream ingest path.
 *
 * Asserts the re-pointed ingest behavior (REQ-8 / AC-10):
 *   - the batch POSTs to `/api/track` (NOT the retired
 *     `/api/events/ingest` or `/api/telemetry`),
 *   - it is shaped as the canonical scaffold `TrackIngestBatch`
 *     (`{ events: TrackEvent[] }`),
 *   - it authenticates with the `public` ingest key (falling back to
 *     `apiKey` only when unset),
 *   - the tenant is NOT sent as a header (derived from the token —
 *     plan 41 REQ-13),
 *   - `experiment_id` / `variant_key` survive end-to-end (REQ-7),
 *   - there is NO legacy telemetry fallback on failure (Q-3 — the
 *     `/api/telemetry` sink was retired in TASK-4b), and ingest
 *     failures never throw into the customer app.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[];
let fetchImpl: (url: string, init: RequestInit) => Promise<Response>;

function okResponse(): Response {
  return {
    ok: true,
    status: 202,
    json: async () => ({ accepted: 1 }),
    text: async () => '',
  } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  fetchImpl = async () => okResponse();
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return fetchImpl(String(url), init ?? {});
  }));
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

/** The single POST to `/api/track`, with its parsed JSON body. */
function trackCall(): { url: string; init: RequestInit; body: { events: Array<Record<string, unknown>> } } {
  const hit = calls.find((c) => c.url.endsWith('/api/track'));
  expect(hit, 'expected a POST to /api/track').toBeDefined();
  return { ...hit!, body: JSON.parse(String(hit!.init.body)) };
}

describe('web-SDK clickstream ingest → /api/track', () => {
  it('POSTs a TrackIngestBatch to /api/track with the public ingest key', async () => {
    const sdk = makeSdk();
    await sdk.capture(
      'placement_presented',
      { experiment_id: 'exp_1', variant_key: 'B', payload: { placement_id: 'pl_9', surface_slot_id: 'slot_3' } },
      { immediate: true },
    );

    const { url, init, body } = trackCall();
    expect(url).toBe('https://edge.example.com/api/track');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer pub_ingest_key');
    // Tenant is derived from the verified token, never a header (REQ-13).
    expect('x-tenant-id' in headers).toBe(false);

    // TrackIngestBatch shape: { events: TrackEvent[] }.
    expect(Array.isArray(body.events)).toBe(true);
    const ev = body.events.find((e) => e.event_name === 'placement_presented')!;
    expect(ev).toBeDefined();
    expect(ev.environment_id).toBe('staging');
    expect(typeof ev.user_id).toBe('string');
    expect((ev.user_id as string).length).toBeGreaterThan(0);
    expect((ev.account_id as string).length).toBeGreaterThan(0);
    expect(typeof ev.event_ts).toBe('string');
    // REQ-7: experiment_id / variant_key preserved end-to-end.
    expect(ev.experiment_id).toBe('exp_1');
    expect(ev.variant_key).toBe('B');
    // Nested-payload clickstream fields lifted out.
    expect(ev.placement_id).toBe('pl_9');
    expect(ev.surface_slot_id).toBe('slot_3');
    // Raw SDK property bag preserved as the optional JSON string.
    expect(typeof ev.properties).toBe('string');
    expect(JSON.parse(ev.properties as string)).toMatchObject({ source: expect.any(String) });
  });

  it('never calls the retired /api/events/ingest or /api/telemetry routes', async () => {
    const sdk = makeSdk();
    await sdk.capture('feature_used', {}, { immediate: true });
    expect(calls.some((c) => c.url.includes('/api/events/ingest'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/api/telemetry'))).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/api/track'))).toBe(true);
  });

  it('has no legacy fallback and does not throw when /api/track fails (Q-3)', async () => {
    fetchImpl = async (u: string) => {
      if (u.endsWith('/api/track')) throw new Error('network down');
      return okResponse();
    };
    const sdk = makeSdk();
    await expect(sdk.capture('feature_used', {}, { immediate: true })).resolves.toBeUndefined();
    // The retired telemetry sink is never attempted as a fallback.
    expect(calls.some((c) => c.url.includes('/api/telemetry'))).toBe(false);
  });

  it('falls back to apiKey for auth when no ingestPublicKey is configured', async () => {
    const sdk = makeSdk({ ingestPublicKey: undefined });
    await sdk.capture('feature_used', {}, { immediate: true });
    const headers = trackCall().init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk_secret_key');
  });

  it("defaults environment_id to 'default' when environmentId is omitted", async () => {
    const sdk = makeSdk({ environmentId: undefined });
    await sdk.capture('feature_used', {}, { immediate: true });
    const ev = trackCall().body.events.find((e) => e.event_name === 'feature_used')!;
    expect(ev.environment_id).toBe('default');
  });
});
