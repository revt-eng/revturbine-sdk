/**
 * Emit-lane semantics (plan 228 TASK-4 / AC-2, AC-3, AC-12).
 *
 * Two lanes, two guarantees:
 *   - GENERIC lane (track / trackEvent / capture / emitSemantic /
 *     emitTrigger): any name colliding with platform vocabulary is namespaced
 *     `clickstream_*` — platform events are unforgeable from untyped paths.
 *   - TYPED lanes (emitPlatformEvent, trackControlPlaneEvent): names land
 *     RAW, payloads are contract-typed, and dev builds validate at emit time.
 *
 * Plus the REQ-11a envelope stamp: effective segment ids ride every event
 * exactly as experiment assignments do.
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
    ingestPublicKey: 'pub',
    environmentId: 'production',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

type WireEvent = { event_name: string; properties?: string };

/** Events across all `/api/track` batches, in wire order. */
function wireEvents(): WireEvent[] {
  return calls
    .filter((c) => c.url.endsWith('/api/track'))
    .flatMap((c) => (JSON.parse(String(c.init.body)) as { events: WireEvent[] }).events);
}
const wireNames = () => wireEvents().map((e) => e.event_name);

/**
 * The event's PAYLOAD as stored: the wire `properties` column is a JSON
 * string whose `payload` key carries what the emit call supplied (the
 * canonical carrier the plan-227 R-10 fix settled).
 */
function payloadOf(event: WireEvent | undefined): Record<string, unknown> {
  if (!event?.properties) return {};
  const props = JSON.parse(event.properties) as { payload?: Record<string, unknown> };
  return props.payload ?? {};
}

describe('generic lane namespaces platform collisions (anti-forgery)', () => {
  it('track() cannot mint platform vocabulary', async () => {
    const sdk = makeSdk();
    await sdk.track('gate_attempted', { entitlement_handle: 'seats' });
    await sdk.track('payment_failed', {});
    await sdk.track('subscription_started', {});
    await sdk.track('account_created', {});
    await sdk.flushEvents();

    const names = wireNames();
    expect(names).toContain('clickstream_gate_attempted');
    expect(names).toContain('clickstream_payment_failed');
    expect(names).toContain('clickstream_subscription_started');
    expect(names).toContain('clickstream_account_created');
    expect(names).not.toContain('gate_attempted');
    expect(names).not.toContain('payment_failed');
    expect(names).not.toContain('subscription_started');
    expect(names).not.toContain('account_created');
  });

  it('leaves genuinely custom names and the page-view alias untouched', async () => {
    const sdk = makeSdk();
    await sdk.track('my_custom_event', { anything: 1 });
    await sdk.track('page_view', {});
    await sdk.flushEvents();

    const names = wireNames();
    expect(names).toContain('my_custom_event');
    // The alias canonicalizes to clickstream_page_view — which IS the
    // declared platform name (wire truth), exempt from double-namespacing.
    expect(names).toContain('clickstream_page_view');
    expect(names).not.toContain('clickstream_clickstream_page_view');
  });

  it('emitSemantic rides the generic lane now', async () => {
    const sdk = makeSdk();
    await sdk.emitSemantic('gate_evaluated', { entitlement_handle: 'seats' });
    await sdk.flushEvents();
    expect(wireNames()).toContain('clickstream_gate_evaluated');
    expect(wireNames()).not.toContain('gate_evaluated');
  });

  it('emitTrigger cannot forge R-2 billing facts (the trial_expired hole)', async () => {
    // `trial_expired` and `payment_failed` are trigger vocabulary AND, since
    // R-2, webhook_derived billing vocabulary. Pre-228, emitTrigger sent
    // trial_expired RAW — a nudge event indistinguishable from a billing
    // fact. The generic lane's namespacing closes that.
    const sdk = makeSdk();
    await sdk.emitTrigger('trial_expired', {});
    await sdk.emitTrigger('usage_limit_approaching', { usage_percent: 85 });
    await sdk.flushEvents();

    const names = wireNames();
    expect(names).toContain('clickstream_trial_expired');
    expect(names).not.toContain('trial_expired');
    // Non-colliding trigger names are unchanged.
    expect(names).toContain('usage_limit_approaching');
  });
});

describe('typed lanes send raw names', () => {
  it('emitPlatformEvent lands the taxonomy name unaltered', async () => {
    const sdk = makeSdk();
    await sdk.emitPlatformEvent('gate_evaluated', {
      entitlement_handle: 'seats',
      outcome: 'denied',
      gated: true,
      reason: 'limit_reached',
      limit: 5,
      used: 5,
      remaining: 0,
    });
    await sdk.emitPlatformEvent('payment_failed', {
      billing_ref: 'acc_1:pay:9',
      plan_handle: 'growth',
    });
    await sdk.flushEvents();

    const names = wireNames();
    expect(names).toContain('gate_evaluated');
    expect(names).toContain('payment_failed');
    expect(names).not.toContain('clickstream_gate_evaluated');
    expect(names).not.toContain('clickstream_payment_failed');
  });

  it('trackControlPlaneEvent lands the renamed playbook_version vocabulary raw', async () => {
    const sdk = makeSdk();
    await sdk.trackControlPlaneEvent('playbook_version_deployed', { playbook_version_id: 'pv_9' });
    await sdk.flushEvents();

    const deployed = wireEvents().find((e) => e.event_name === 'playbook_version_deployed');
    expect(deployed).toBeDefined();
    expect(payloadOf(deployed).control_plane_source).toBe('workflow');
  });

  it('a schema-violating typed payload emits an sdk_validation_warning in dev builds', async () => {
    const sdk = makeSdk();
    // Runtime callers (window.RevTurbine, plain JS) bypass compile checks —
    // that is exactly what emit-time validation exists for.
    await sdk.emitPlatformEvent(
      'gate_evaluated',
      { entitlement_handle: 'seats' } as never,
    );
    await sdk.flushEvents();

    const names = wireNames();
    expect(names).toContain('gate_evaluated'); // still delivered — never dropped
    const warning = wireEvents().find(
      (e) => e.event_name === 'sdk_validation_warning'
        && payloadOf(e).source_event_type === 'gate_evaluated'
        && payloadOf(e).violation === 'schema_violation',
    );
    expect(warning).toBeDefined();
    // The warning conforms to ITS OWN contract: message is required.
    expect(typeof payloadOf(warning).message).toBe('string');
  });

  it('a schema-valid typed payload emits no contract-violation warning', async () => {
    // Scoped to the TYPED lane's verdict: the pre-existing page-context
    // collector still emits its own sdk_validation_warning in a bare test
    // environment (invalid_page_context_url), which is not what this guards.
    const sdk = makeSdk();
    await sdk.emitPlatformEvent('segment_enrolled', { segment_id: 'power_users', user_id: 'u1' });
    await sdk.flushEvents();
    const contractWarnings = wireEvents().filter(
      (e) => e.event_name === 'sdk_validation_warning' && payloadOf(e).violation !== undefined,
    );
    expect(contractWarnings).toEqual([]);
  });
});

describe('segment_ids envelope stamp (REQ-11a)', () => {
  it('stamps effective segment ids exactly as experiment assignments are stamped', async () => {
    const sdk = makeSdk({
      user: { id: 'user_a' },
      domainProviders: [
        {
          domain: 'segments',
          resolve: () => ({ segmentIds: ['power_users', 'beta_cohort'] }),
        },
      ],
    });

    // Force a provider resolution, then emit through the generic lane.
    await sdk.getEffectiveUserContext();
    await sdk.track('custom_thing', {});
    await sdk.flushEvents();

    const custom = wireEvents().find((e) => e.event_name === 'custom_thing');
    expect(payloadOf(custom).segment_ids).toEqual(['power_users', 'beta_cohort']);
  });

  it('omits the stamp entirely when no segments are in effect', async () => {
    const sdk = makeSdk();
    await sdk.track('custom_thing', {});
    await sdk.flushEvents();
    const custom = wireEvents().find((e) => e.event_name === 'custom_thing');
    expect(payloadOf(custom)).not.toHaveProperty('segment_ids');
  });
});
