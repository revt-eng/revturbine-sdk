/**
 * Plan 164 TASK-4 — caller-declared test traffic.
 *
 * `init({ test: true })` stamps `test: true` on every emitted event — the
 * clickstream wire rows (`POST /api/track`), treatment interactions included
 * (they are `placement_interaction` rows there; the separate interactions POST
 * lane was removed in 0.15.0) — so analytics can default-exclude test traffic. Omitted or `false` leaves the wire shape
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

function trackedRows(): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.url.endsWith('/api/track'))
    .flatMap((c) => (JSON.parse(String(c.init.body)) as { events: Array<Record<string, unknown>> }).events);
}

/** The `placement_interaction` wire row in the `/api/track` batch (flushed first). */
async function interactionRow(sdk: RevTurbineCustomerSdk): Promise<Record<string, unknown>> {
  await sdk.flushEvents();
  const hit = trackedRows().filter((row) => row.event_name === 'placement_interaction');
  expect(hit, 'expected one placement_interaction row in /api/track').toHaveLength(1);
  return hit[0];
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
  it('stamps test: true on the placement_interaction wire row', async () => {
    const sdk = makeSdk({ test: true });
    await sdk.trackTreatmentInteraction({
      userId: 'u-1',
      placementId: 'pl-1',
      interactionType: 'impression',
      surfaceSlotId: 'slot-1',
    });

    expect((await interactionRow(sdk)).test).toBe(true);
  });

  it('omits the test key when the option is absent', async () => {
    const sdk = makeSdk();
    await sdk.trackTreatmentInteraction({
      userId: 'u-1',
      placementId: 'pl-1',
      interactionType: 'impression',
      surfaceSlotId: 'slot-1',
    });

    expect('test' in (await interactionRow(sdk))).toBe(false);
  });
});
