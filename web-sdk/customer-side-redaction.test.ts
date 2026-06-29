/**
 * Plan 106 TASK-2/TASK-3 — web-SDK PII redaction + analytics opt-out.
 *
 * Asserts the client-side, defense-in-depth behavior:
 *   - AC-5: emails / Luhn-valid cards in event properties are redacted, and
 *     an email-shaped user_id is hashed, in the outgoing /api/track body;
 *   - AC-6: a one-time console.warn fires when (and only when) redaction
 *     happened — never per-event, never for a clean batch;
 *   - AC-7: the `analytics: false` opt-out suppresses ALL /api/track
 *     emission and any redaction warning.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
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
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

function trackBody(): { events: Array<Record<string, unknown>> } {
  const hit = calls.find((c) => c.url.endsWith('/api/track'));
  expect(hit, 'expected a POST to /api/track').toBeDefined();
  return JSON.parse(String(hit!.init.body));
}

describe('web-SDK PII redaction before send (plan 106)', () => {
  it('AC-5: redacts emails/cards in properties and hashes an email-shaped user_id', async () => {
    const sdk = makeSdk();
    sdk.identify('user@example.com');
    await sdk.capture(
      'feature_used',
      { contact: 'buyer@example.com', card: '4111111111111111', plan: 'pro' },
      { immediate: true },
    );

    const ev = trackBody().events.find((e) => e.event_name === 'feature_used')!;
    // email-shaped user_id is hashed (deterministic, matches the corpus), not raw
    expect(ev.user_id).toBe('eml_b4c9a289323b21a0');
    expect(String(ev.user_id)).not.toContain('@');

    // No raw PII anywhere in the serialized event.
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain('buyer@example.com');
    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).toContain('[REDACTED]');

    // The customer payload values are redacted but structure preserved.
    const props = JSON.parse(ev.properties as string);
    expect(props.payload).toMatchObject({ contact: '[REDACTED]', card: '[REDACTED]', plan: 'pro' });
  });

  it('AC-6: warns exactly once across multiple PII captures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = makeSdk();
    await sdk.capture('feature_used', { email: 'a@b.com' }, { immediate: true });
    await sdk.capture('feature_used', { email: 'c@d.com' }, { immediate: true });

    const piiWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes('redacted PII-shaped values'),
    );
    expect(piiWarnings).toHaveLength(1);
  });

  it('AC-6: does not warn for a clean batch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = makeSdk();
    await sdk.capture('feature_used', { plan: 'pro' }, { immediate: true });

    const piiWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes('redacted PII-shaped values'),
    );
    expect(piiWarnings).toHaveLength(0);
  });
});

describe('web-SDK analytics opt-out (plan 106 REQ-8)', () => {
  it('AC-7: analytics:false suppresses all /api/track emission and the warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = makeSdk({ analytics: false });
    await sdk.capture('feature_used', { email: 'a@b.com' }, { immediate: true });

    expect(calls.some((c) => c.url.endsWith('/api/track'))).toBe(false);
    const piiWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes('redacted PII-shaped values'),
    );
    expect(piiWarnings).toHaveLength(0);
  });

  it('default (analytics unset) still emits to /api/track', async () => {
    const sdk = makeSdk();
    await sdk.capture('feature_used', {}, { immediate: true });
    expect(calls.some((c) => c.url.endsWith('/api/track'))).toBe(true);
  });
});
