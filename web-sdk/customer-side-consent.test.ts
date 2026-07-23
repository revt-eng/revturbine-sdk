/**
 * Plan 144 TASK-8 — telemetry consent gate + pipeline counters (REQ-11, REQ-12,
 * AC-3).
 *
 * `telemetry.consent` gates event CREATION ahead of every destination: `denied`
 * and `pending` mean nothing reaches ingest, a registered consumer, or an
 * integration. A runtime `setTelemetryConsent` flip takes effect with no
 * remount. Default (`telemetry` omitted) stays `granted`, so an integration
 * that never set the option is unchanged (AC-21).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import { createAnalyticsProvider } from './analytics';

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

function makeSdk(
  captured: string[],
  over: Partial<RevTurbineInitOptions> = {},
): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_abc',
    apiKey: 'sk_secret_key',
    ingestPublicKey: 'pub_ingest_key',
    environmentId: 'prod',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    domainProviders: [createAnalyticsProvider({ handler: (name) => captured.push(name) })],
    ...over,
  });
}

const trackCalls = (): FetchCall[] => calls.filter((c) => c.url.endsWith('/api/track'));

describe('telemetry consent gate', () => {
  it('consent: denied creates zero events and reaches no destination (AC-3)', async () => {
    const captured: string[] = [];
    const sdk = makeSdk(captured, { telemetry: { consent: 'denied' } });

    await sdk.capture('feature_used', { plan: 'pro' }, { immediate: true });
    await Promise.resolve(); // let any async dispatch settle

    expect(trackCalls()).toHaveLength(0); // no ingest
    expect(captured).toHaveLength(0); // no consumer / integration
    expect(sdk.getTelemetryCounters().created).toBe(0); // never built
    expect(sdk.getTelemetryCounters().dropped).toBeGreaterThan(0);
  });

  it('consent: pending drops events just like denied (REQ-11)', async () => {
    const captured: string[] = [];
    const sdk = makeSdk(captured, { telemetry: { consent: 'pending' } });

    await sdk.capture('feature_used', {}, { immediate: true });
    await Promise.resolve();

    expect(trackCalls()).toHaveLength(0);
    expect(captured).toHaveLength(0);
    expect(sdk.getTelemetryCounters().created).toBe(0);
  });

  it('flipping consent denied → granted resumes emission without a remount (AC-3, REQ-12)', async () => {
    const captured: string[] = [];
    const sdk = makeSdk(captured, { telemetry: { consent: 'denied' } });

    await sdk.capture('feature_used', {}, { immediate: true });
    expect(trackCalls()).toHaveLength(0);

    sdk.setTelemetryConsent('granted'); // same instance — no remount
    await sdk.capture('feature_used', {}, { immediate: true });

    expect(trackCalls().length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(captured).toContain('feature_used'));
    expect(sdk.getTelemetryConsent()).toBe('granted');
  });

  it('flipping consent granted → denied stops emission mid-session', async () => {
    const captured: string[] = [];
    const sdk = makeSdk(captured); // default granted

    await sdk.capture('first', {}, { immediate: true });
    const afterFirst = trackCalls().length;
    expect(afterFirst).toBeGreaterThan(0);

    sdk.setTelemetryConsent('denied');
    await sdk.capture('second', {}, { immediate: true });

    expect(trackCalls().length).toBe(afterFirst); // no new ingest
  });

  it('no telemetry option defaults to granted and emits (AC-21)', async () => {
    const captured: string[] = [];
    const sdk = makeSdk(captured); // no `telemetry` key at all

    expect(sdk.getTelemetryConsent()).toBe('granted');
    await sdk.capture('feature_used', {}, { immediate: true });
    expect(trackCalls().length).toBeGreaterThan(0);
  });
});

describe('telemetry pipeline counters', () => {
  it('tallies created / queued / sent on the happy path', async () => {
    const captured: string[] = [];
    const sdk = makeSdk(captured);

    await sdk.capture('feature_used', {}, { immediate: true });
    const snap = sdk.getTelemetryCounters();
    expect(snap.created).toBeGreaterThan(0);
    expect(snap.sent).toBeGreaterThan(0);
    expect(snap.failed).toBe(0);
    expect(snap.dropped).toBe(0);
  });

  it('counts a queued (non-immediate) capture separately from a sent one', async () => {
    const captured: string[] = [];
    const sdk = makeSdk(captured, { eventBatching: { flushIntervalMs: 0 } });

    await sdk.capture('buffered', {}); // not immediate → queued
    expect(sdk.getTelemetryCounters().queued).toBeGreaterThan(0);
    expect(trackCalls()).toHaveLength(0);
  });

  it('returns an immutable snapshot — mutating it never touches live tallies', async () => {
    const captured: string[] = [];
    const sdk = makeSdk(captured);
    await sdk.capture('feature_used', {}, { immediate: true });

    const snap = sdk.getTelemetryCounters();
    snap.created = 999;
    expect(sdk.getTelemetryCounters().created).not.toBe(999);
  });
});
