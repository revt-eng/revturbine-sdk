/**
 * Plan 144 TASK-6 — one canonical extraction path for lifted clickstream
 * fields.
 *
 * `capture` (flat properties) and `emitSemantic` (nested `{ semantic, payload }`)
 * both feed the same `pickClickstreamField` / `CLICKSTREAM_LIFTED_FIELDS`
 * extraction, so a lifted field resolves identically regardless of shape and a
 * new lifted field is added in ONE place. These assert the extraction is
 * unified and byte-identical on the wire — the guard behind AC-21.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];

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
    ingestPublicKey: 'pub',
    environmentId: 'prod',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

/** The first `/api/track` event row the SDK POSTed. */
function trackedEvent(): Record<string, unknown> {
  const hit = calls.find((c) => c.url.endsWith('/api/track'));
  expect(hit, 'expected a POST to /api/track').toBeDefined();
  const body = JSON.parse(String(hit!.init.body)) as { events: Array<Record<string, unknown>> };
  return body.events[0];
}

describe('lifted clickstream fields — one canonical extraction path', () => {
  it('lifts a field carried FLAT at the top level', async () => {
    const sdk = makeSdk();
    await sdk.capture(
      'thing_happened',
      { placement_id: 'pl_flat', surface_slot_id: 'slot_flat' },
      { immediate: true },
    );
    const ev = trackedEvent();
    expect(ev.placement_id).toBe('pl_flat');
    expect(ev.surface_slot_id).toBe('slot_flat');
  });

  it('lifts the SAME field carried NESTED under `payload`', async () => {
    const sdk = makeSdk();
    // The shape emitSemantic produces, and that some capture callers pass.
    await sdk.capture(
      'thing_happened',
      { payload: { placement_id: 'pl_nested', surface_slot_id: 'slot_nested' } },
      { immediate: true },
    );
    const ev = trackedEvent();
    expect(ev.placement_id).toBe('pl_nested');
    expect(ev.surface_slot_id).toBe('slot_nested');
  });

  it('lifts every canonical field from emitSemantic output', async () => {
    const sdk = makeSdk();
    await sdk.emitSemantic(
      'placement_interaction',
      { placement_id: 'pl_9', payload_id: 'pay_9', experiment_id: 'exp_1', variant_key: 'B' },
      { immediate: true },
    );
    const ev = trackedEvent();
    expect(ev).toMatchObject({
      placement_id: 'pl_9',
      payload_id: 'pay_9',
      experiment_id: 'exp_1',
      variant_key: 'B',
    });
  });

  it('top-level wins over nested for the same field (precedence unchanged)', async () => {
    const sdk = makeSdk();
    await sdk.capture(
      'thing_happened',
      { placement_id: 'pl_top', payload: { placement_id: 'pl_nested' } },
      { immediate: true },
    );
    expect(trackedEvent().placement_id).toBe('pl_top');
  });

  it('leaves the lifted columns null when the field is absent', async () => {
    const sdk = makeSdk();
    await sdk.capture('thing_happened', { unrelated: 'x' }, { immediate: true });
    const ev = trackedEvent();
    expect(ev.placement_id).toBeNull();
    expect(ev.experiment_id).toBeNull();
    expect(ev.variant_key).toBeNull();
  });
});
