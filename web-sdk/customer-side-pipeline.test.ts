/**
 * Plan 144 TASK-7 — telemetry delivery pipeline, wired into the SDK.
 *
 * Covers the end-to-end guarantees the standalone `telemetry/` unit tests can't
 * see from inside `sendEvents`:
 *   - AC-6:  every wire row carries a sortable, unique `event_id`;
 *   - AC-23: a transient ingest failure is retried with the byte-identical row,
 *            so storage-layer dedup collapses it to exactly one row;
 *   - AC-17: a throwing mirror never blocks RevTurbine ingest, and an ingest
 *            failure never blocks a configured mirror;
 *   - AC-21: `event_id` is additive — the existing wire shape is undisturbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import { createAnalyticsProvider } from './analytics';
import type { EventConsumerProvider } from '@revt-eng/core';

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
  fetchImpl = () => Promise.resolve(okResponse());
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return fetchImpl(String(url), init ?? {});
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
    apiKey: 'sk_secret_key',
    ingestPublicKey: 'pub_ingest_key',
    environmentId: 'prod',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

const trackPosts = (): FetchCall[] => calls.filter((c) => c.url.endsWith('/api/track'));

function rowsOf(call: FetchCall): Array<Record<string, unknown>> {
  const body = JSON.parse(String(call.init.body)) as { events: Array<Record<string, unknown>> };
  return body.events;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('telemetry pipeline — event_id, retry, fan-out isolation', () => {
  it('stamps a sortable, unique event_id on every wire row (AC-6)', async () => {
    const sdk = makeSdk();
    await sdk.capture('a_happened', {}, { immediate: true });
    await sdk.capture('b_happened', {}, { immediate: true });

    const first = rowsOf(trackPosts()[0])[0];
    const second = rowsOf(trackPosts()[1])[0];
    expect(String(first.event_id)).toMatch(ULID_RE);
    expect(String(second.event_id)).toMatch(ULID_RE);
    // Sortable: a later event's id compares greater.
    expect(String(second.event_id) > String(first.event_id)).toBe(true);
  });

  it('retries a transient ingest failure with the byte-identical row → one row (AC-23, AC-6)', async () => {
    let attempt = 0;
    fetchImpl = (url) => {
      if (url.endsWith('/api/track')) {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error('flaky network'));
      }
      return Promise.resolve(okResponse());
    };

    const sdk = makeSdk();
    await sdk.capture('feature_used', { plan: 'pro' }, { immediate: true });

    const posts = trackPosts();
    expect(posts).toHaveLength(2); // original + one retry

    const rowA = rowsOf(posts[0])[0];
    const rowB = rowsOf(posts[1])[0];
    // The retry resends the SAME bytes, so the dedup keys are preserved.
    expect(posts[0].init.body).toBe(posts[1].init.body);
    expect(rowB.request_id).toBe(rowA.request_id);
    expect(rowB.event_id).toBe(rowA.event_id);

    // Storage (ReplacingMergeTree) dedups on request_id. The retry resent the
    // same rows, so the distinct request_ids across BOTH deliveries equal the
    // count in ONE delivery — the re-delivery adds zero rows. (A rebuilt retry
    // would mint fresh request_ids and double the count.)
    const perDelivery = rowsOf(posts[0]).length;
    const stored = new Set<string>();
    for (const post of posts) for (const ev of rowsOf(post)) stored.add(String(ev.request_id));
    expect(stored.size).toBe(perDelivery);
  });

  it('a throwing event consumer never blocks RevTurbine ingest (AC-17)', async () => {
    const explodingMirror: EventConsumerProvider = {
      domain: 'events',
      resolve: () => ({
        consumers: [
          {
            name: 'exploding-mirror',
            consume() {
              throw new Error('mirror exploded');
            },
          },
        ],
      }),
    };

    const sdk = makeSdk({ domainProviders: [explodingMirror] });
    await expect(sdk.capture('feature_used', {}, { immediate: true })).resolves.toBeUndefined();
    expect(trackPosts()).toHaveLength(1); // ingest happened despite the throw
  });

  it('an ingest network failure never blocks a configured mirror (AC-17)', async () => {
    fetchImpl = (url) =>
      url.endsWith('/api/track')
        ? Promise.reject(new Error('ingest down'))
        : Promise.resolve(okResponse());

    const seen: string[] = [];
    const mirror = createAnalyticsProvider({ handler: (name) => seen.push(name) });
    const sdk = makeSdk({ domainProviders: [mirror] });

    await sdk.capture('feature_used', {}, { immediate: true });
    // The mirror runs before ingest, so an ingest failure can't strip it.
    await vi.waitFor(() => expect(seen).toContain('feature_used'));
  });

  it('adds event_id without disturbing the existing wire shape (AC-21 additive)', async () => {
    const sdk = makeSdk();
    await sdk.capture('feature_used', { plan: 'pro' }, { immediate: true });

    const row = rowsOf(trackPosts()[0])[0];
    expect(row.event_name).toBe('feature_used');
    expect(row.environment_id).toBe('prod');
    expect(row).toHaveProperty('request_id');
    expect(row).toHaveProperty('event_id');
    expect(typeof row.properties).toBe('string'); // still the serialized bag
  });
});
