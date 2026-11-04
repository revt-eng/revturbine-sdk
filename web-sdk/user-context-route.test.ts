/**
 * ST-1447 (BUG-1185) — hosted mode makes no request to a route the server lacks.
 *
 * The control plane has only the server-key `POST /api/sdk/user-contexts`
 * (plural) upsert; the singular `/api/sdk/user-context` the SDK used to call on
 * every identify() and update() answers 404. The call now happens only when the
 * integrator points `custom_endpoints.userContext` at a real endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk, type RevTurbineInitOptions } from './customer-side';

let urls: string[];

beforeEach(() => {
  urls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return {
      ok: true,
      status: 202,
      headers: new Headers(),
      json: async () => ({ segment_ids: [] }),
      text: async () => '',
    } as unknown as Response;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_user_context',
    publicKey: 'rtk_public_test',
    endpoint: 'https://edge.example.com',
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

const userContextCalls = (): string[] => urls.filter((url) => /\/api\/sdk\/user-context(?!s)/.test(url));

describe('hosted mode and the singular user-context route', () => {
  it('identify() and update({ usage }) make no request to /api/sdk/user-context', async () => {
    const sdk = makeSdk();
    sdk.identify('user_1');
    sdk.update({ usage: { ai_credits_used: 42 } });
    await sdk.fetchUserContext('user_1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(userContextCalls()).toEqual([]);
    sdk.dispose();
  });

  it('fetchUserContext() returns an empty context without a request by default', async () => {
    const sdk = makeSdk({ user: { id: 'user_1' } });
    const context = await sdk.fetchUserContext('user_1');

    expect(context).toEqual({ userId: 'user_1', segmentIds: [], traits: {} });
    expect(userContextCalls()).toEqual([]);
    sdk.dispose();
  });

  it('calls the route when custom_endpoints.userContext names one', async () => {
    const sdk = makeSdk({
      user: { id: 'user_1' },
      runtimeMode: 'custom_endpoints',
      endpointOverrides: { userContext: '/custom/user-context' },
    });
    await sdk.fetchUserContext('user_1');

    expect(urls.some((url) => url.endsWith('/custom/user-context'))).toBe(true);
    sdk.dispose();
  });
});
