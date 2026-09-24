/**
 * Plan 144 TASK-10 / Q-3 — `placement_interaction` is the ONE canonical
 * placement event, discriminated by `interaction_type`. The standalone
 * `placement_dismissed` / `placement_snoozed` / `placement_converted` events had
 * no consumer anywhere, so `dismiss` / `snooze` / `convert` now route through the
 * canonical event and the standalone names are retired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_abc',
    apiKey: 'sk',
    publicKey: 'pub',
    environmentId: 'production',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

/** Every `/api/track` row across all POSTed batches. */
function trackedRows(): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.url.endsWith('/api/track'))
    .flatMap((c) => (JSON.parse(String(c.init.body)) as { events: Array<Record<string, unknown>> }).events);
}

/**
 * The semantic payload a row carries. The wire mapping nests an envelope's
 * properties under `properties.payload`, and `emitSemantic` passes its fields
 * to `capture` unwrapped, so the authored fields land at
 * `properties.payload.*` — the same place a customer's own `capture()` fields
 * land, and the canonical carrier this SDK documents.
 */
function semanticBag(row: Record<string, unknown>): Record<string, unknown> {
  const props = JSON.parse(String(row.properties)) as { payload?: Record<string, unknown> };
  return props.payload ?? {};
}

describe('canonical placement_interaction (Q-3)', () => {
  it('dismiss emits placement_interaction with interaction_type "dismiss"', async () => {
    const sdk = makeSdk();
    await sdk.dismiss('out_1');
    await sdk.flushEvents();

    const rows = trackedRows();
    const ev = rows.find((r) => r.event_name === 'placement_interaction');
    expect(ev, 'expected a placement_interaction row').toBeDefined();
    expect(ev!.payload_id).toBe('out_1'); // lifted column
    expect(semanticBag(ev!).interaction_type).toBe('dismiss');
  });

  it('snooze maps to interaction_type "remind_me_later"', async () => {
    const sdk = makeSdk();
    await sdk.snooze('out_2', 1800);
    await sdk.flushEvents();

    const ev = trackedRows().find((r) => r.event_name === 'placement_interaction');
    const bag = semanticBag(ev!);
    expect(bag.interaction_type).toBe('remind_me_later');
    expect(bag.remind_after_seconds).toBe(1800);
  });

  it('convert maps to interaction_type "cta_completed"', async () => {
    const sdk = makeSdk();
    await sdk.convert('out_3');
    await sdk.flushEvents();

    const ev = trackedRows().find((r) => r.event_name === 'placement_interaction');
    expect(semanticBag(ev!).interaction_type).toBe('cta_completed');
  });

  it('never emits the retired placement_dismissed / _snoozed / _converted names', async () => {
    const sdk = makeSdk();
    await sdk.dismiss('out_1');
    await sdk.snooze('out_2');
    await sdk.convert('out_3');
    await sdk.flushEvents();

    const names = trackedRows().map((r) => r.event_name);
    expect(names).not.toContain('placement_dismissed');
    expect(names).not.toContain('placement_snoozed');
    expect(names).not.toContain('placement_converted');
    // All three collapsed onto the one canonical event.
    expect(names.filter((n) => n === 'placement_interaction')).toHaveLength(3);
  });

  // A semantic event's fields must sit exactly one level under `payload`, the
  // same depth a customer's own capture() fields sit at. `emitSemantic` used to
  // add a `{semantic, payload}` wrapper of its own, which the wire mapping then
  // nested again — burying every platform event's fields one level deeper than
  // the canonical carrier. Readers that followed the documented shape found
  // nothing, so gate and placement telemetry was emitted correctly and read as
  // empty. Nothing anywhere consumed the `semantic` marker that cost that level.
  it('nests semantic fields at properties.payload, never payload.payload', async () => {
    const sdk = makeSdk();
    await sdk.dismiss('out_1');
    await sdk.flushEvents();

    const ev = trackedRows().find((r) => r.event_name === 'placement_interaction');
    const props = JSON.parse(String(ev!.properties)) as Record<string, unknown>;
    const bag = props.payload as Record<string, unknown>;

    expect(bag.interaction_type).toBe('dismiss');
    expect(bag.payload, 'semantic fields must not be double-wrapped').toBeUndefined();
    expect(bag.semantic, 'the unread `semantic` marker must not come back').toBeUndefined();
  });
});
