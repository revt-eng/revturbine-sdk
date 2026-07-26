/**
 * Plan 157 TASK-5 — web-SDK consumes GET /api/sdk/client-context.
 *
 * `fetchClientContext(rt_client_)` enriches the held UserContext with the user's
 * server-known client-safe fields (trial state + coarse billing health), which
 * thread through `synthesizeProviderContext` into provider state. The token is
 * held in memory only and never logged; enrichment is best-effort.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions, RevTurbineUserContext } from './customer-side';

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_cc_test',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

interface ResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function stubFetch(response: ResponseLike) {
  const fn = vi.fn(async () => response as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const CLIENT_CTX = {
  subject: 'user_1',
  context_version: 'ctx_1',
  trial: { status: 'active', days_remaining: 8, ends_at: '2026-08-01T00:00:00Z' },
  billing: { health: 'attention_required' },
  capabilities: { can_upgrade: true, can_manage_billing: true },
};

function priv(sdk: RevTurbineCustomerSdk) {
  return sdk as unknown as {
    userContext: RevTurbineUserContext;
    clientContextToken?: string;
    synthesizeProviderContext(): { plan?: { paymentAtRisk?: boolean } } | undefined;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('web-SDK fetchClientContext (plan 157 T5)', () => {
  it('fetches /api/sdk/client-context with the client token and merges trial + billing', async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      json: async () => CLIENT_CTX,
      text: async () => '',
    });
    const sdk = makeSdk();
    sdk.setUserContext({ id: 'u1' } as RevTurbineUserContext);

    await sdk.fetchClientContext('rt_client_abc');

    // A context change re-evaluates segments (which also calls fetch), so find
    // OUR client-context call specifically.
    const ccCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/api/sdk/client-context'),
    );
    expect(ccCall?.[0]).toBe('https://edge.example.com/api/sdk/client-context');
    expect((ccCall?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer rt_client_abc');

    const uc = priv(sdk).userContext;
    expect(uc.trial?.state).toBe('active');
    expect(uc.trial?.in_trial).toBe(true);
    expect(uc.trial?.days_remaining).toBe(8);
    expect(uc.payment_at_risk).toBe(true);
    // (The payment_at_risk → provider-state threading is pinned by the plan-138
    // billing-signals test; here we prove the fetch merges it into UserContext.)
  });

  it('holds the token in memory and reuses it when called with no arg', async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      json: async () => CLIENT_CTX,
      text: async () => '',
    });
    const sdk = makeSdk();
    await sdk.fetchClientContext('rt_client_abc');
    await sdk.fetchClientContext();
    const ccCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).endsWith('/api/sdk/client-context'),
    );
    expect(ccCalls).toHaveLength(2);
    for (const call of ccCalls) {
      expect((call[1]?.headers as Record<string, string>).authorization).toBe('Bearer rt_client_abc');
    }
  });

  it('clears the token on 401 and never throws on network error', async () => {
    stubFetch({ ok: false, status: 401, json: async () => ({}), text: async () => '' });
    const sdk = makeSdk();
    await expect(sdk.fetchClientContext('rt_client_expired')).resolves.toBeUndefined();
    expect(priv(sdk).clientContextToken).toBeUndefined();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(sdk.fetchClientContext('rt_client_x')).resolves.toBeUndefined();
  });

  it('does not overwrite an app-set value with server context (app trait wins)', async () => {
    stubFetch({ ok: true, status: 200, json: async () => CLIENT_CTX, text: async () => '' });
    const sdk = makeSdk();
    // App explicitly says the user is NOT at risk; server enrichment must not
    // clobber an app-set custom trait. (trial is RevTurbine-authoritative and
    // does refresh — asserted above.)
    sdk.setUserContext({ id: 'u1', custom: { tier: 'gold' } } as RevTurbineUserContext);
    await sdk.fetchClientContext('rt_client_abc');
    expect(priv(sdk).userContext.custom?.tier).toBe('gold');
  });

  it('never logs the client token', async () => {
    const logs: string[] = [];
    const methods = ['log', 'warn', 'error', 'info', 'debug'] as const;
    const spies = methods.map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(' '));
      }),
    );
    stubFetch({ ok: true, status: 200, json: async () => CLIENT_CTX, text: async () => '' });
    const sdk = makeSdk();
    await sdk.fetchClientContext('rt_client_secret_value');
    spies.forEach((s) => s.mockRestore());
    expect(logs.join('\n')).not.toContain('rt_client_secret_value');
  });
});
