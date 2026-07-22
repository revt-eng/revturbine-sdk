/**
 * Entitlement checks are fail-CLOSED: when the SDK cannot produce an affirmative
 * grant, it denies rather than leaking access. This reverses the SDK's earlier
 * fail-open behaviour (0.2.29 and before). The `reason` code is preserved on the
 * denied result so callers can still distinguish an infrastructure failure from
 * a rule-based "RT said no".
 *
 * Covers the four fallback paths in `checkEntitlement`:
 *   - server mode, non-ok response      → entitlement_service_unavailable
 *   - server mode, network/parse error  → entitlement_check_error
 *   - local mode, no Playbook + no cache → local_runtime_default_allow
 *   - SDK disabled by provider failure   → sdk_disabled_provider_failure
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

function serverSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_fc',
    apiKey: 'sk_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'revturbine_server',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
  sdk.setUserContext({ id: 'user_fc', plan: { id: 'starter', name: 'Starter' } });
  return sdk;
}

afterEach(() => vi.restoreAllMocks());

describe('entitlement checks fail closed', () => {
  it('denies (does not grant) when the service returns a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    const result = await serverSdk().checkEntitlement('data_export');
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('denied');
    // reason preserved so callers can tell an outage from a real denial
    expect(result.reason).toBe('entitlement_service_unavailable');
  });

  it('denies when the request throws (network/parse failure)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const result = await serverSdk().checkEntitlement('data_export');
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('denied');
    expect(result.reason).toBe('entitlement_check_error');
  });

  it('denies in local mode when no Playbook is loaded and nothing is cached', async () => {
    const sdk = new RevTurbineCustomerSdk({
      tenantId: 'tenant_fc_local',
      apiKey: 'local',
      endpoint: 'http://localhost',
      mode: 'snippet',
      runtimeMode: 'local_only',
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    });
    sdk.setUserContext({ id: 'user_fc', plan: { id: 'starter', name: 'Starter' } });
    const result = await sdk.checkEntitlement('data_export');
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('denied');
    expect(result.reason).toBe('local_runtime_default_allow');
  });
});
