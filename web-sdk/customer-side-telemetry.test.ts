/**
 * @vitest-environment jsdom
 *
 * Plan 95 TASK-6 (SDK auto-emit + batching) and TASK-7 (keyless anonymous
 * init-telemetry + opt-out + console notice).
 *
 * TASK-6 / AC-1, AC-2:
 *   - buffered clickstream flushes to /api/track on the interval timer, on a
 *     page-unload (`pagehide`) signal, and at the configurable size threshold,
 *   - so a low-volume session still delivers its events,
 *   - authed with the public ingest key.
 *
 * TASK-7 / AC-4, AC-5, AC-5b:
 *   - when NO ingest key is set, the SDK posts a single anonymous `sdk_init`
 *     to /api/sdk/meta with config-shape COUNTS + a one-way hashed config id,
 *     no auth header, and no user/tenant/PII fields,
 *   - the `anonymousTelemetry: false` opt-out disables it entirely,
 *   - a one-time info console notice names the opt-out flag,
 *   - a keyed install does NOT use the keyless beacon, and local_only never
 *     emits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineConfig, RevTurbineInitOptions } from './customer-side';

type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[];
const instances: RevTurbineCustomerSdk[] = [];

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
});

afterEach(() => {
  // Release each SDK's flush timer + page-unload listeners.
  for (const sdk of instances.splice(0)) sdk.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeConfig(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [
      { id: 'plan_free', unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
      { id: 'plan_pro', unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 0 },
    ],
    entitlements: [
      { id: 'ent_gen', unique_handle: 'generations', name: 'Generations', type: 'usage_limit', unit: 'images' },
    ],
    entitlement_rules: [
      { id: 'r_free', entitlement_id: 'ent_gen', targets: [{ kind: 'plan', id: 'plan_free' }], segment_ids: [],
        type_fields: { kind: 'usage_limit', limit_value: 30, unit: 'images', period: 'per_month', enforcement: 'hard_block' } },
    ],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_abc',
    apiKey: 'sk_secret_key',
    ingestPublicKey: 'pub_ingest_key',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
  instances.push(sdk);
  return sdk;
}

function trackCalls(): FetchCall[] {
  return calls.filter((c) => c.url.endsWith('/api/track'));
}
function metaCalls(): FetchCall[] {
  return calls.filter((c) => c.url.endsWith('/api/sdk/meta'));
}
function metaBody(): { events: Array<Record<string, unknown>> } {
  const hit = metaCalls()[0];
  expect(hit, 'expected a POST to /api/sdk/meta').toBeDefined();
  return JSON.parse(String(hit.init.body));
}

describe('TASK-6 — clickstream batching flush policy', () => {
  it('flushes buffered events to /api/track on the interval timer', async () => {
    vi.useFakeTimers();
    // Keyed install: no keyless beacon, so /api/track is the only sink.
    makeSdk({ eventBatching: { flushIntervalMs: 5_000 } });
    // The constructor buffered a `page_view` but hasn't flushed (below the
    // size threshold, timer not yet elapsed).
    expect(trackCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(trackCalls().length).toBeGreaterThan(0);
    const headers = trackCalls()[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer pub_ingest_key'); // AC-1
  });

  it('flushes buffered events on a page-unload (pagehide) signal', async () => {
    makeSdk({ eventBatching: { flushIntervalMs: 0 } }); // timer disabled
    expect(trackCalls()).toHaveLength(0);

    window.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(trackCalls().length).toBeGreaterThan(0));
  });

  it('auto-flushes once the configurable size threshold is reached', async () => {
    // maxBatchSize 1 → each capture flushes immediately. (The construct-time
    // page_view can buffer a variable number of envelopes depending on page
    // context, so drain first, then assert the threshold triggers a flush.)
    const sdk = makeSdk({ eventBatching: { maxBatchSize: 1, flushIntervalMs: 0 } });
    await sdk.flushEvents();
    const before = trackCalls().length;

    await sdk.capture('feature_used', {});
    expect(trackCalls().length).toBeGreaterThan(before);
  });

  it('flushEvents() is a no-op when the buffer is empty', async () => {
    const sdk = makeSdk({ eventBatching: { flushIntervalMs: 0 } });
    await sdk.flushEvents(); // drains the construct-time page_view
    const after = trackCalls().length;
    await sdk.flushEvents(); // nothing buffered now
    expect(trackCalls().length).toBe(after);
  });
});

describe('TASK-7 — keyless anonymous init telemetry', () => {
  it('posts a single anonymous sdk_init to /api/sdk/meta with counts, hashed id, and no PII', async () => {
    makeSdk({ ingestPublicKey: undefined, localRuntime: { exportedConfig: makeConfig() } });

    await vi.waitFor(() => expect(metaCalls().length).toBe(1));

    const { init } = metaCalls()[0];
    // Keyless: no Authorization header (AC-6 client side).
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect('authorization' in headers).toBe(false);

    const body = metaBody();
    expect(body.events).toHaveLength(1);
    const ev = body.events[0];
    expect(ev.event_type).toBe('sdk_init');
    expect(typeof ev.config_hash_id).toBe('string');
    expect((ev.config_hash_id as string).length).toBeGreaterThan(0);
    expect((ev.config_hash_id as string).length).toBeLessThanOrEqual(64);
    expect(typeof ev.sdk_version).toBe('string');
    expect(ev.runtime_mode).toBe('revturbine_server');

    // Config-shape COUNTS only (AC-4).
    expect(ev.config_shape).toEqual({
      plans: 2,
      entitlements: 1,
      entitlement_rules: 1,
      segments: 0,
      placements: 0,
      placement_payloads: 0,
      content_ui_paths: 0,
      surface_templates: 0,
    });

    // No user/account/tenant/PII fields anywhere in the event (REQ-6/REQ-9).
    for (const forbidden of ['user_id', 'account_id', 'anonymous_id', 'tenant_id', 'traits']) {
      expect(forbidden in ev).toBe(false);
    }
  });

  it('logs the one-time opt-out notice naming the flag', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    makeSdk({ ingestPublicKey: undefined });

    await vi.waitFor(() => expect(metaCalls().length).toBe(1));
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain('anonymousTelemetry');
  });

  it('sends nothing and logs nothing when anonymousTelemetry is false (AC-5)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    makeSdk({ ingestPublicKey: undefined, anonymousTelemetry: false });

    // Give any stray async beacon a chance to (not) fire.
    await Promise.resolve();
    await Promise.resolve();
    expect(metaCalls()).toHaveLength(0);
    expect(info).not.toHaveBeenCalled();
  });

  it('does NOT use the keyless beacon when an ingest key is configured', async () => {
    makeSdk({ ingestPublicKey: 'pub_ingest_key' });
    await Promise.resolve();
    await Promise.resolve();
    expect(metaCalls()).toHaveLength(0);
  });

  it('does NOT emit keyless telemetry in local_only mode', async () => {
    makeSdk({
      ingestPublicKey: undefined,
      runtimeMode: 'local_only',
      localRuntime: { exportedConfig: makeConfig() },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(metaCalls()).toHaveLength(0);
  });
});
