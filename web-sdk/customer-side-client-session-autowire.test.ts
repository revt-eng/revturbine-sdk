/**
 * Plan 191 TASK-4 / AC-5 — the client-context loop wires itself.
 *
 * Status item A8: `fetchClientContext` existed, was tested, and had ZERO
 * production callers — no init option seeded its token and no docs page
 * mentioned it. So "a purchase updates client decisions without app code"
 * was only true if the app called an undocumented method. The `clientSession`
 * minter closes that loop; these cases pin it end to end, including the
 * short-TTL re-mint that made a callback (not a token value) the right shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

// A Playbook granting `batch_export` to `pro` only — so which plan the SDK
// believes the user is on is observable through a real decision.
const LOCAL_CONFIG = {
  version: '1.0.0',
  plans: [
    { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
    { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 1 },
  ],
  entitlements: [{ unique_handle: 'batch_export', name: 'Batch Export', type: 'feature' }],
  entitlement_rules: [
    {
      id: 'r_free', entitlement_id: 'batch_export', targets: [{ kind: 'plan', id: 'free' }],
      segment_ids: [], kind: 'feature', enabled: false,
    },
    {
      id: 'r_pro', entitlement_id: 'batch_export', targets: [{ kind: 'plan', id: 'pro' }],
      segment_ids: [], kind: 'feature', enabled: true,
    },
  ],
  segments: [], content_ui_paths: [], surface_templates: [], placements: [],
} as unknown as RevTurbineInitOptions['localRuntime'] extends { playbook?: infer P } ? P : never;

const CLIENT_CTX = { plan: { handle: 'pro', name: 'Pro' } };

let fetchCalls: Array<{ url: string; auth?: string }>;

/** Responds to client-context with `handler`; everything else 404s. */
function stubFetch(handler: (auth: string | undefined, call: number) => { status: number; body?: unknown }): void {
  let call = 0;
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    const auth = init?.headers?.authorization;
    fetchCalls.push({ url, auth });
    if (!url.includes('/api/sdk/client-context')) {
      return new Response('{}', { status: 404 });
    }
    call += 1;
    const { status, body } = handler(auth, call);
    return new Response(JSON.stringify(body ?? {}), { status });
  }) as typeof fetch;
}

function makeSdk(overrides: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tn_test',
    apiKey: 'k',
    endpoint: 'https://cp.example.com',
    mode: 'headless',
    runtimeMode: 'local_only',
    localRuntime: { playbook: LOCAL_CONFIG },
    anonymousTelemetry: false,
    analytics: false,
    user: { id: 'u_1', plan_handle: 'free' },
    ...overrides,
  } as RevTurbineInitOptions);
}

/** The auto-wire is fire-and-forget; let its microtasks settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const realFetch = globalThis.fetch;
beforeEach(() => {
  fetchCalls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const clientContextCalls = () => fetchCalls.filter((c) => c.url.includes('/api/sdk/client-context'));

describe('clientSession auto-wire (plan 191 REQ-5 / AC-5)', () => {
  it('fetches client context and applies the server plan with no app call', async () => {
    stubFetch(() => ({ status: 200, body: CLIENT_CTX }));
    const mint = vi.fn(async () => 'rt_client_minted');

    const sdk = makeSdk({ clientSession: mint });
    // The app declared the user as `free`; the server (Stripe webhook truth)
    // says `pro`. Nothing below calls fetchClientContext().
    await settle();

    expect(mint).toHaveBeenCalledTimes(1);
    expect(clientContextCalls()).toHaveLength(1);
    expect(clientContextCalls()[0].auth).toBe('Bearer rt_client_minted');

    // The decision moves: `batch_export` is denied on free, allowed on pro.
    const result = await sdk.checkEntitlement('batch_export');
    expect(result.allowed).toBe(true);
  });

  it('does nothing when no minter is configured (A8 status quo stays opt-in)', async () => {
    stubFetch(() => ({ status: 200, body: CLIENT_CTX }));
    const sdk = makeSdk();
    await settle();

    expect(clientContextCalls()).toHaveLength(0);
    const result = await sdk.checkEntitlement('batch_export');
    expect(result.allowed).toBe(false); // still the app-supplied `free`
  });

  it('re-mints and retries once when the control plane rejects an expired token', async () => {
    // First token is stale (401) — the ~10-minute TTL in practice; the second
    // succeeds. This is why the option is a callback, not a token value.
    stubFetch((_auth, call) => (call === 1 ? { status: 401 } : { status: 200, body: CLIENT_CTX }));
    let minted = 0;
    const mint = vi.fn(async () => `rt_client_${(minted += 1)}`);

    const sdk = makeSdk({ clientSession: mint });
    await settle();

    expect(mint).toHaveBeenCalledTimes(2);
    expect(clientContextCalls().map((c) => c.auth)).toEqual([
      'Bearer rt_client_1',
      'Bearer rt_client_2',
    ]);
    expect((await sdk.checkEntitlement('batch_export')).allowed).toBe(true);
  });

  it('stops after one re-mint when the backend keeps minting rejected tokens', async () => {
    stubFetch(() => ({ status: 401 }));
    const mint = vi.fn(async () => 'rt_client_always_bad');

    makeSdk({ clientSession: mint });
    await settle();

    // Bounded: no request loop against a misconfigured backend.
    expect(clientContextCalls().length).toBeLessThanOrEqual(2);
    expect(mint.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('re-mints for a new identity so one user never enriches from another user token', async () => {
    stubFetch(() => ({ status: 200, body: CLIENT_CTX }));
    const mint = vi.fn(async () => `rt_client_for_${mint.mock.calls.length}`);

    const sdk = makeSdk({ clientSession: mint });
    await settle();
    const afterInit = clientContextCalls().length;

    sdk.identify('u_2', { plan_handle: 'free' });
    await settle();

    expect(clientContextCalls().length).toBeGreaterThan(afterInit);
    expect(mint.mock.calls.length).toBeGreaterThan(1);
  });

  it('survives a minter that rejects — enrichment is best-effort, never fatal', async () => {
    stubFetch(() => ({ status: 200, body: CLIENT_CTX }));
    const mint = vi.fn(async () => {
      throw new Error('session endpoint down');
    });

    const sdk = makeSdk({ clientSession: mint });
    await settle();

    expect(clientContextCalls()).toHaveLength(0); // no token → no fetch
    // The SDK still answers from app-supplied context.
    expect((await sdk.checkEntitlement('batch_export')).allowed).toBe(false);
  });

  it('never logs or persists the token', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(() => ({ status: 200, body: CLIENT_CTX }));

    makeSdk({ clientSession: async () => 'rt_client_secret_value' });
    await settle();

    const logged = [...log.mock.calls, ...warn.mock.calls].flat().map(String).join('\n');
    expect(logged).not.toContain('rt_client_secret_value');
    // Held in memory only — nothing about the token reaches storage.
    const stored = JSON.stringify(globalThis.localStorage ?? {});
    expect(stored).not.toContain('rt_client_secret_value');
  });
});
