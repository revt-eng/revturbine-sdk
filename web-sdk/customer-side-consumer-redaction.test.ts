/**
 * Plan 143 TASK-4/TASK-5 — external-destination delivery path.
 *
 * Redaction used to run only inside the `/api/track` mapping, while registered
 * `EventConsumer` adapters were dispatched the raw envelope at the top of
 * `sendEvents`. A PostHog or Segment mirror therefore received emails and card
 * numbers that RevTurbine's own pipeline scrubbed.
 *
 * These pin the fixed ordering:
 *   - AC-1: a consumer sees exactly what /api/track sees — redacted;
 *   - AC-4: a customer property named `tenant_id` cannot displace the
 *     canonical value in an external destination.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
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

/** Captured `(eventName, properties)` pairs from a registered consumer. */
type Captured = Array<{ name: string; props: Record<string, unknown> }>;

function makeSdk(captured: Captured, over: Partial<RevTurbineInitOptions> = {}) {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_abc',
    apiKey: 'sk_secret_key',
    ingestPublicKey: 'pub_ingest_key',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    domainProviders: [
      createAnalyticsProvider({
        handler: (name, props) => captured.push({ name, props: props as Record<string, unknown> }),
      }),
    ],
    ...over,
  });
}

/**
 * Wait for a named event to reach the consumer and return its properties. A
 * `capture()` can emit more than one envelope — a payload/page-context issue
 * also queues an `sdk_validation_warning` — so select by name, not by index.
 */
async function awaitCaptured(captured: Captured, name: string): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(captured.some((c) => c.name === name)).toBe(true));
  return captured.find((c) => c.name === name)!.props;
}

/** The parsed `/api/track` body, which carries `properties` as a JSON string. */
function trackProperties(): Record<string, unknown> {
  const hit = calls.find((c) => c.url.endsWith('/api/track'));
  expect(hit, 'expected a POST to /api/track').toBeDefined();
  const body = JSON.parse(String(hit!.init.body)) as {
    events: Array<{ properties: string }>;
  };
  return JSON.parse(body.events[0].properties) as Record<string, unknown>;
}

describe('external-destination delivery', () => {
  it('redacts before consumer fan-out — a mirror never sees raw PII', async () => {
    const captured: Captured = [];
    const sdk = makeSdk(captured);

    await sdk.capture(
      'support_ticket_opened',
      { reporter: 'jane.doe@acme.com', card: '4242 4242 4242 4242' },
      { immediate: true },
    );

    const consumerProps = await awaitCaptured(captured, 'support_ticket_opened');
    const serialized = JSON.stringify(consumerProps);
    expect(serialized).not.toContain('jane.doe@acme.com');
    expect(serialized).not.toContain('4242 4242 4242 4242');
    expect(serialized).toContain('[REDACTED]');

    // And the same values are redacted on the RevTurbine path — one sanitized
    // envelope, every destination.
    expect(JSON.stringify(trackProperties())).not.toContain('jane.doe@acme.com');
  });

  it('hashes an email-shaped user_id before it reaches a consumer', async () => {
    const captured: Captured = [];
    const sdk = makeSdk(captured);
    sdk.identify('jane.doe@acme.com');

    await sdk.capture('plan_viewed', {}, { immediate: true });
    const props = await awaitCaptured(captured, 'plan_viewed');

    expect(props.user_id).not.toBe('jane.doe@acme.com');
    expect(String(props.user_id)).toMatch(/^eml_[0-9a-f]{16}$/);
  });

  it('keeps canonical identity when a customer property collides', async () => {
    const captured: Captured = [];
    const sdk = makeSdk(captured);

    await sdk.capture(
      'workspace_created',
      { tenant_id: 'customer-supplied', user_id: 'spoofed', plan: 'pro' },
      { immediate: true },
    );
    const props = await awaitCaptured(captured, 'workspace_created');
    expect(props.tenant_id).toBe('tenant_abc');
    expect(props.user_id).not.toBe('spoofed');
    // Displaced, not discarded.
    expect(props.rt_prop_tenant_id).toBe('customer-supplied');
    expect(props.rt_prop_user_id).toBe('spoofed');
  });

  it('leaves non-colliding customer properties untouched', async () => {
    const captured: Captured = [];
    const sdk = makeSdk(captured);

    await sdk.capture('workspace_created', { plan: 'pro', seats: 12 }, { immediate: true });
    const props = await awaitCaptured(captured, 'workspace_created');

    expect(props.plan).toBe('pro');
    expect(props.seats).toBe(12);
    expect(props.rt_prop_plan).toBeUndefined();
  });
});
