/**
 * Automatic trial/usage transition-to-wire regressions (plan 250 TASK-3 /
 * AC-3, REQ-3, REQ-4).
 *
 * `evaluateTrialLifecycleTriggers` and `evaluateUsageThresholdCrossings` are
 * private — this file never calls them directly. It drives the actual PUBLIC
 * update APIs a customer calls (`setTrialInstances`, `updateUsage`) through a
 * real `RevTurbineCustomerSdk` instance, the same stubbed-`fetch` transport
 * harness `platform-emit-lanes.test.ts` uses, and asserts the exact wire
 * `type` recorded in `/api/track` batches after `flushEvents()`. Nothing here
 * mocks `capture`, `emitTrigger`, or reconstructs the wire carrier by hand.
 *
 * Wire names pinned here match the matrix in
 * `docs/specs/scaffold/event-contracts.md` § "Dogfood and trigger
 * wire/consumer matrix":
 *   - trial_midpoint, trial_expiring          -> raw
 *   - trial expiry                             -> clickstream_trial_expired (collision)
 *   - usage_limit_approaching/_reached         -> raw
 *   - explicit feature_gated/payment_failed    -> clickstream_* (collision, negative control)
 *
 * Plan 231's generic-trigger ruling is unchanged by this file: it only adds
 * coverage through the automatic emitters, never renames a trigger, and never
 * implements metering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import { DOGFOOD_CLIENT_EVENT_NAMES } from '@revt-eng/schema';
import type { RevTurbineConfig, TrialInstance } from '@revt-eng/schema';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];
/** Mutable "backend" usage snapshot returned by the mocked `/api/sdk/user-context`. */
let backendUsage: Record<string, number>;

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  backendUsage = {};
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const u = String(url);
      if (u.endsWith('/api/sdk/user-context')) {
        return Promise.resolve(okJson({ segment_ids: [], usage: backendUsage }));
      }
      // /api/track and anything else: accept.
      return Promise.resolve(okJson({ accepted: 1 }));
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** A usage-limit config: one plan, one `generations` entitlement capped at 100. */
function usageConfig(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [{ unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 }],
    entitlements: [
      { unique_handle: 'generations', name: 'Generations', type: 'usage_limit', unit: 'images' },
    ],
    entitlement_rules: [
      { id: 'r_free', entitlement_id: 'generations', targets: [{ kind: 'plan', id: 'free' }], segment_ids: [],
        kind: 'usage_limit', limit_value: 100, unit: 'images', period_scope: 'per_month', enforcement: 'allow_overage' },
    ],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_trigger_wire',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'staging',
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
const countOf = (name: string) => wireNames().filter((n) => n === name).length;

/** The event's nested carrier payload — `properties.payload`, per the matrix. */
function payloadOf(event: WireEvent | undefined): Record<string, unknown> {
  if (!event?.properties) return {};
  const props = JSON.parse(event.properties) as { payload?: Record<string, unknown> };
  return props.payload ?? {};
}

/** A 10-day free-trial instance, active the whole window; nowIso moves the derived stage. */
function tenDayTrialInstance(): TrialInstance {
  return {
    id: 'ti_1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    tenant_id: 'tenant_trigger_wire',
    customer_id: 'cust_1',
    rule_id: 'rule_unused',
    rule_type: 'free_trial',
    status: 'active',
    started_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-01-11T00:00:00.000Z',
    trial_limit_type: 'time',
  } as unknown as TrialInstance;
}

/** The dogfood mirror's actual match rule (matrix): exact-name Set membership. */
const dogfoodMirrorWouldCapture = (name: string): boolean =>
  new Set<string>(DOGFOOD_CLIENT_EVENT_NAMES).has(name);

describe('automatic trial-lifecycle triggers reach the wire under the ruled names (AC-3)', () => {
  it('setTrialInstances at day 5 (midpoint) emits raw trial_midpoint', async () => {
    const sdk = makeSdk({ placementBehavior: { enableTrialAutoTriggers: true } });
    await sdk.setTrialInstances([tenDayTrialInstance()], { nowIso: '2026-01-06T00:00:00.000Z' });
    await sdk.flushEvents();

    expect(wireNames()).toContain('trial_midpoint');
    expect(wireNames()).not.toContain('clickstream_trial_midpoint');
    const evt = wireEvents().find((e) => e.event_name === 'trial_midpoint');
    expect(payloadOf(evt).days_remaining).toBe(5);
    expect(payloadOf(evt).user_id).toBeDefined();
  });

  it('setTrialInstances at day 8 (expiring, <= 3 days remaining) emits raw trial_expiring', async () => {
    const sdk = makeSdk({ placementBehavior: { enableTrialAutoTriggers: true } });
    await sdk.setTrialInstances([tenDayTrialInstance()], { nowIso: '2026-01-09T00:00:00.000Z' });
    await sdk.flushEvents();

    expect(wireNames()).toContain('trial_expiring');
    expect(wireNames()).not.toContain('clickstream_trial_expiring');
  });

  it('setTrialInstances past expiry emits the namespaced clickstream_trial_expired (REQ-3 collision)', async () => {
    // A lazily-expired trial the SDK never observed as active does not
    // manufacture an "expired" transition (`deriveTrialTriggerStage` only
    // reports 'expired' out of a KNOWN prior stage) — so first observe the
    // trial mid-flight, then cross expiry.
    const sdk = makeSdk({ placementBehavior: { enableTrialAutoTriggers: true } });
    const instance = tenDayTrialInstance();
    await sdk.setTrialInstances([instance], { nowIso: '2026-01-06T00:00:00.000Z' }); // midpoint
    await sdk.setTrialInstances([instance], { nowIso: '2026-01-12T00:00:00.000Z' }); // past expiry
    await sdk.flushEvents();

    expect(wireNames()).toContain('clickstream_trial_expired');
    // The raw platform name must never appear from this automatic path — that
    // would be an unforgeable billing fact minted from a local observation.
    expect(wireNames()).not.toContain('trial_expired');
  });

  it('repeated calls at the same derived stage do not reemit', async () => {
    const sdk = makeSdk({ placementBehavior: { enableTrialAutoTriggers: true } });
    const instance = tenDayTrialInstance();
    await sdk.setTrialInstances([instance], { nowIso: '2026-01-06T00:00:00.000Z' });
    await sdk.setTrialInstances([instance], { nowIso: '2026-01-06T00:00:01.000Z' }); // still midpoint
    await sdk.flushEvents();

    expect(countOf('trial_midpoint')).toBe(1);
  });

  it('enableTrialAutoTriggers: false prevents every trial signal across the full lifecycle', async () => {
    const sdk = makeSdk({ placementBehavior: { enableTrialAutoTriggers: false } });
    const instance = tenDayTrialInstance();
    await sdk.setTrialInstances([instance], { nowIso: '2026-01-06T00:00:00.000Z' }); // would be midpoint
    await sdk.setTrialInstances([instance], { nowIso: '2026-01-09T00:00:00.000Z' }); // would be expiring
    await sdk.setTrialInstances([instance], { nowIso: '2026-01-12T00:00:00.000Z' }); // would be expired
    await sdk.flushEvents();

    const names = wireNames();
    expect(names).not.toContain('trial_midpoint');
    expect(names).not.toContain('trial_expiring');
    expect(names).not.toContain('clickstream_trial_expired');
    expect(names).not.toContain('trial_expired');
  });
});

function makeUsageSdk(): RevTurbineCustomerSdk {
  return makeSdk({ localRuntime: { playbook: usageConfig() } });
}

/**
 * `updateUsage()` fires its threshold evaluation without awaiting it (a
 * fire-and-forget `void this.evaluateUserSegmentsAndUsage(...)`), which reads
 * `prevUsage` from the mocked `/api/sdk/user-context` twice per call (a
 * prev-context read and a next-context read). Rather than assume a fixed
 * microtask depth, wait for those network calls to land — the same
 * wait-on-observable-effect pattern `customer-side-pipeline.test.ts` uses for
 * other fire-and-forget SDK paths — before flushing the event queue.
 */
async function waitForUserContextFetches(min: number): Promise<void> {
  await vi.waitFor(() =>
    expect(calls.filter((c) => c.url.endsWith('/api/sdk/user-context')).length).toBeGreaterThanOrEqual(min),
  );
}

describe('automatic usage-threshold crossings reach the wire under the ruled names (AC-3)', () => {
  it('crossing the 80% warning line emits raw usage_limit_approaching, then reaching 100% emits raw usage_limit_reached', async () => {
    const sdk = makeUsageSdk();
    sdk.identify('u_usage', { plan_handle: 'free' });

    // No prior usage on record: 0 -> 85 crosses the 80% warning line.
    sdk.updateUsage({ generations: 85 });
    await waitForUserContextFetches(2);

    // The backend now reflects 85 (simulates the control plane catching up to
    // the balance just reported) before the next update is evaluated.
    backendUsage = { generations: 85 };
    sdk.updateUsage({ generations: 100 });
    await waitForUserContextFetches(4);

    await sdk.flushEvents();

    expect(wireNames()).toContain('usage_limit_approaching');
    expect(wireNames()).toContain('usage_limit_reached');
    expect(wireNames()).not.toContain('clickstream_usage_limit_approaching');
    expect(wireNames()).not.toContain('clickstream_usage_limit_reached');

    const approaching = wireEvents().find((e) => e.event_name === 'usage_limit_approaching');
    expect(payloadOf(approaching).entitlement_handle).toBe('generations');
    expect(payloadOf(approaching).usage_limit).toBe(100);
  });

  it('a repeated, unchanged usage report does not reemit a crossing', async () => {
    const sdk = makeUsageSdk();
    sdk.identify('u_usage_repeat', { plan_handle: 'free' });

    sdk.updateUsage({ generations: 85 });
    await waitForUserContextFetches(2);
    backendUsage = { generations: 85 };

    // Same value reported again — the backend already reflects it, so this is
    // a no-op report, not new growth.
    sdk.updateUsage({ generations: 85 });
    await waitForUserContextFetches(4);

    await sdk.flushEvents();
    expect(countOf('usage_limit_approaching')).toBe(1);
    expect(countOf('usage_limit_reached')).toBe(0);
  });
});

describe('explicit generic-lane collisions stay namespaced (negative control)', () => {
  it('emitTrigger("feature_gated") and emitTrigger("payment_failed") land clickstream_*, never raw', async () => {
    const sdk = makeSdk();
    await sdk.emitTrigger('feature_gated', { feature: 'advanced_automation' } as never);
    await sdk.emitTrigger('payment_failed', { billing_ref: 'acc_1:pay:1' } as never);
    await sdk.flushEvents();

    const names = wireNames();
    expect(names).toContain('clickstream_feature_gated');
    expect(names).toContain('clickstream_payment_failed');
    expect(names).not.toContain('feature_gated');
    expect(names).not.toContain('payment_failed');
  });
});

describe('the dogfood PostHog mirror filter never matches a generic-lane wire name', () => {
  it('none of the automatic-trigger or explicit-collision wire names pass the exact-match dogfood filter', async () => {
    const sdk = makeSdk({ placementBehavior: { enableTrialAutoTriggers: true } });
    await sdk.setTrialInstances([tenDayTrialInstance()], { nowIso: '2026-01-06T00:00:00.000Z' }); // trial_midpoint
    await sdk.setTrialInstances([tenDayTrialInstance()], { nowIso: '2026-01-12T00:00:00.000Z' }); // clickstream_trial_expired
    await sdk.emitTrigger('feature_gated', { feature: 'x' } as never);
    await sdk.emitTrigger('payment_failed', { billing_ref: 'r' } as never);
    await sdk.flushEvents();

    const names = wireNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(dogfoodMirrorWouldCapture(name), `${name} must not pass the dogfood exact-name filter`).toBe(false);
    }
    // Sanity: the filter DOES match the two names it exists to protect —
    // otherwise the assertion above would be vacuous.
    expect(dogfoodMirrorWouldCapture('area_viewed')).toBe(true);
    expect(dogfoodMirrorWouldCapture('feature_gated')).toBe(true);
  });
});
