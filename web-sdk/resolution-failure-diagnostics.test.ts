/**
 * @vitest-environment jsdom
 *
 * Plan 144 TASK-21 (absorbed plan-124 TASK-2) — `resolution_failure`
 * diagnostics on the keyless meta channel:
 *
 *   - KEYED installs emit (124 Q-7: the emit is decoupled from the
 *     `!ingestPublicKey` gate the adoption beacon keeps).
 *   - BOTH opt-outs govern (124 Q-6, Kent 2026-08-12): either
 *     `anonymousTelemetry: false` or `analytics: false` silences diagnostics.
 *   - Session dedup per `(reason, primary handle)` + a session cap (Q-4).
 *   - v1 scope (Q-3): placement fallback sites + the entitlement
 *     infrastructure denials; local mode's default deny does NOT emit.
 *   - Bodies carry only the TASK-20 allow-list — handles and reason codes.
 *
 * jsdom is required: the channel is browser-only (`isBrowser()`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import type { RevTurbineConfig } from '@revt-eng/schema';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];
let rejectNonMeta = false;

function okResponse(): Response {
  return {
    ok: true,
    status: 202,
    json: async () => ({ accepted: 1 }),
    text: async () => '',
  } as unknown as Response;
}

function makeConfig(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [{ id: 'plan_free', unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 }],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

beforeEach(() => {
  calls = [];
  rejectNonMeta = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/sdk/meta')) {
        calls.push({ url: u, init: init ?? {} });
        return Promise.resolve(okResponse());
      }
      if (rejectNonMeta) return Promise.reject(new Error('config fetch down'));
      return Promise.resolve(okResponse());
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = () => new Promise((r) => setTimeout(r, 30));

const metaBodies = () =>
  calls.map((c) => JSON.parse(String(c.init.body)) as { events: Array<Record<string, unknown>> });

/** A KEYED local-only install — the adoption beacon stays silent (keyless-only), diagnostics do not. */
function makeKeyedSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_diag',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: makeConfig() },
    ...over,
  });
}

describe('resolution_failure diagnostics — keyed installs emit (124 Q-7)', () => {
  it('an unregistered placement decision emits one allow-listed diagnostic', async () => {
    const sdk = makeKeyedSdk();
    await sdk.getPlacementDecision({ placementId: 'ghost_upsell', userId: 'u1' });
    await settle();
    expect(calls).toHaveLength(1);
    const [body] = metaBodies();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      event_type: 'resolution_failure',
      reason: 'placement_not_registered',
      placement_handle: 'ghost_upsell',
    });
    // Allow-list posture: no user context on the wire.
    expect(body.events[0].user_id).toBeUndefined();
    expect(body.events[0].tenant_id).toBeUndefined();
  });

  it('dedupes per (reason, handle) for the session; a distinct handle emits again', async () => {
    const sdk = makeKeyedSdk();
    await sdk.getPlacementDecision({ placementId: 'ghost_a', userId: 'u1' });
    await settle();
    await sdk.getPlacementDecision({ placementId: 'ghost_a', userId: 'u1' });
    await settle();
    expect(calls).toHaveLength(1);
    await sdk.getPlacementDecision({ placementId: 'ghost_b', userId: 'u1' });
    await settle();
    expect(calls).toHaveLength(2);
  });

  it('caps diagnostics per session', async () => {
    const sdk = makeKeyedSdk();
    for (let i = 0; i < 25; i += 1) {
      await sdk.getPlacementDecision({ placementId: `ghost_${i}`, userId: 'u1' });
    }
    await settle();
    expect(calls.length).toBeLessThanOrEqual(20);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('resolution_failure diagnostics — both opt-outs govern (124 Q-6)', () => {
  it('analytics: false silences diagnostics', async () => {
    const sdk = makeKeyedSdk({ analytics: false } as Partial<RevTurbineInitOptions>);
    await sdk.getPlacementDecision({ placementId: 'ghost', userId: 'u1' });
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('anonymousTelemetry: false silences diagnostics', async () => {
    const sdk = makeKeyedSdk({ anonymousTelemetry: false } as Partial<RevTurbineInitOptions>);
    await sdk.getPlacementDecision({ placementId: 'ghost', userId: 'u1' });
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe('resolution_failure diagnostics — entitlement infra-denials (Q-3 scope)', () => {
  it('server mode with an unreachable config emits config_unavailable with the entitlement handle', async () => {
    rejectNonMeta = true;
    const sdk = new RevTurbineCustomerSdk({
      tenantId: 'tenant_diag',
      apiKey: 'sk_test',
      ingestPublicKey: 'pub_test',
      endpoint: 'https://edge.example.com',
      mode: 'snippet',
      runtimeMode: 'revturbine_server',
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    });
    sdk.identify('u1', { plan_handle: 'free' });
    const res = await sdk.checkEntitlement('generations');
    await settle();
    expect(res.status).toBe('denied');
    const diag = metaBodies()
      .flatMap((b) => b.events)
      .find((e) => e.reason === 'config_unavailable');
    expect(diag).toMatchObject({
      event_type: 'resolution_failure',
      entitlement_handle: 'generations',
      plan_handle: 'free',
    });
  });

  it("local mode's default deny does NOT emit (a configuration choice, not infrastructure)", async () => {
    const sdk = new RevTurbineCustomerSdk({
      tenantId: 'tenant_diag',
      apiKey: 'sk_test',
      ingestPublicKey: 'pub_test',
      endpoint: 'https://edge.example.com',
      mode: 'snippet',
      runtimeMode: 'local_only',
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    });
    await sdk.checkEntitlement('generations');
    await settle();
    expect(calls).toHaveLength(0);
  });
});
