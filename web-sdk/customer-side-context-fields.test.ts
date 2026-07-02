/**
 * Plan 114 TASK-4 — user-context field-names signal.
 *
 * On identify / setUserContext the SDK emits a reserved `user_context_observed`
 * clickstream event carrying only the NAMES of the custom fields set — never
 * their values (AC-4, AC-9 / PII-safe). The tenant-scoped `user_context_fields`
 * pipe (TASK-5) reads these for per-`(tenant_id, field_name)` last-seen.
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

/** All clickstream events flushed to /api/track across every POST. */
function trackedEvents(): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.url.endsWith('/api/track'))
    .flatMap((c) => (JSON.parse(String(c.init.body)) as { events: Array<Record<string, unknown>> }).events);
}

/** The single reserved field-names event, with its payload field names + parsed props. */
function contextFieldsEvent() {
  const ev = trackedEvents().find((e) => e.event_name === 'user_context_observed');
  expect(ev, 'expected a user_context_observed event').toBeDefined();
  const props = JSON.parse(String(ev!.properties)) as {
    payload?: { context_fields?: unknown };
    traits?: Record<string, unknown> | null;
  };
  return { ev: ev!, props, fields: props.payload?.context_fields as string[] | undefined };
}

describe('web-SDK user-context field-names signal → /api/track', () => {
  it('identify emits the custom field NAMES under user_context_observed (AC-4)', async () => {
    const sdk = makeSdk();
    sdk.identify('end_user_1', { custom: { plan_tier: 'gold', seat_count: 12 } });
    await sdk.flushEvents();

    const { fields } = contextFieldsEvent();
    expect(fields).toEqual(['plan_tier', 'seat_count']); // sorted, names only
  });

  it('the signal event carries names only — no field VALUES, no traits (AC-9 / PII-safe)', async () => {
    const sdk = makeSdk();
    sdk.identify('end_user_1', {
      custom: { plan_tier: 'PLATINUM_SECRET_VALUE', api_token: 'TKN_9f8e7d_secret' },
    });
    await sdk.flushEvents();

    const { ev, props, fields } = contextFieldsEvent();
    expect(fields).toEqual(['api_token', 'plan_tier']);
    // The signal suppresses the custom-value traits every other event carries.
    expect(props.traits).toEqual({});
    // The distinctive VALUES must appear nowhere in the serialized signal event.
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain('PLATINUM_SECRET_VALUE');
    expect(serialized).not.toContain('TKN_9f8e7d_secret');
  });

  it('setUserContext emits the custom field NAMES too', async () => {
    const sdk = makeSdk();
    sdk.setUserContext({ id: 'u1', custom: { theme: 'dark', locale: 'en-US' } } as never);
    await sdk.flushEvents();

    const { fields } = contextFieldsEvent();
    expect(fields).toEqual(['locale', 'theme']);
  });

  it('maps legacy identify(userId, traits) field names into the signal', async () => {
    const sdk = makeSdk();
    sdk.identify('u1', { role: 'editor', department: 'growth' });
    await sdk.flushEvents();

    const { fields } = contextFieldsEvent();
    expect(fields).toEqual(['department', 'role']);
  });

  it('emits nothing when no custom fields are set', async () => {
    const sdk = makeSdk();
    sdk.identify('u1', { plan: 'pro' }); // canonical field, no custom bag
    await sdk.flushEvents();

    expect(trackedEvents().some((e) => e.event_name === 'user_context_observed')).toBe(false);
  });
});
