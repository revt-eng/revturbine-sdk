/**
 * Plan 164 TASK-4 — caller-declared test traffic.
 *
 * `init({ test: true })` stamps `test: true` on every emitted event — the
 * clickstream wire rows (`POST /api/track`) AND the treatment-interaction
 * payloads (`POST /api/events/interactions`) — so analytics can
 * default-exclude test traffic. Omitted or `false` leaves the wire shape
 * unchanged (no `test` key), keeping pre-164 servers and production
 * instances byte-identical. The flag is a deliberate code-passed option
 * (plan 164 Q-3): nothing here reads NODE_ENV or any environment signal.
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

function trackedRows(): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.url.endsWith('/api/track'))
    .flatMap((c) => (JSON.parse(String(c.init.body)) as { events: Array<Record<string, unknown>> }).events);
}

function interactionRow(): Record<string, unknown> {
  const hit = calls.find((c) => c.url.endsWith('/api/events/interactions'));
  expect(hit, 'expected a POST to /api/events/interactions').toBeDefined();
  const parsed = JSON.parse(String(hit!.init.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

describe('init({ test: true }) — clickstream (plan 164)', () => {
  it('stamps test: true on every /api/track wire row', async () => {
    const sdk = makeSdk({ test: true });
    await sdk.capture('feature_used', { plan: 'pro' });
    await sdk.capture('cta_clicked', {});
    await sdk.flushEvents();

    const rows = trackedRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.test).toBe(true);
  });

  it('omits the test key entirely when the option is absent (wire unchanged)', async () => {
    const sdk = makeSdk();
    await sdk.capture('feature_used', {});
    await sdk.flushEvents();

    const rows = trackedRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) expect('test' in row).toBe(false);
  });

  it('treats test: false the same as absent — no key on the wire', async () => {
    const sdk = makeSdk({ test: false });
    await sdk.capture('feature_used', {});
    await sdk.flushEvents();

    for (const row of trackedRows()) expect('test' in row).toBe(false);
  });
});

describe('init({ test: true }) — treatment interactions (plan 164)', () => {
  it('stamps test: true on the /api/events/interactions payload', async () => {
    const sdk = makeSdk({ test: true });
    await sdk.trackTreatmentInteraction({
      userId: 'u-1',
      placementId: 'pl-1',
      interactionType: 'impression',
      surfaceSlotId: 'slot-1',
    });

    expect(interactionRow().test).toBe(true);
  });

  it('omits the test key when the option is absent', async () => {
    const sdk = makeSdk();
    await sdk.trackTreatmentInteraction({
      userId: 'u-1',
      placementId: 'pl-1',
      interactionType: 'impression',
      surfaceSlotId: 'slot-1',
    });

    expect('test' in interactionRow()).toBe(false);
  });
});
