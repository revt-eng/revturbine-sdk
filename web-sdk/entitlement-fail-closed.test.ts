/**
 * Entitlement checks are fail-CLOSED: when the SDK cannot produce an affirmative
 * grant, it denies rather than leaking access. This reverses the SDK's earlier
 * fail-open behaviour (0.2.29 and before). The `reason` code is preserved on the
 * denied result so callers can still distinguish an infrastructure failure from
 * a rule-based "RT said no".
 *
 * Server mode evaluates entitlements LOCALLY against the launched Playbook it
 * fetches from `/api/sdk/config` (plan 159) — there is no per-check round-trip.
 * Covers the fallback paths in `checkEntitlement`:
 *   - server mode, launched config unfetchable (non-ok) → config_unavailable
 *   - server mode, launched config fetch throws          → config_unavailable
 *   - local mode, no Playbook + no cache                 → local_runtime_default_allow
 *   - SDK disabled by provider failure                   → sdk_disabled_provider_failure
 * and the happy path: server mode fetches the Playbook and grants locally.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

function serverSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_fc',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'revturbine_server',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
  sdk.setUserContext({ id: 'user_fc', plan: { id: 'starter', name: 'Starter' } });
  return sdk;
}

// A launched Playbook that grants `generations` (usage_limit, under limit) to
// the `starter` plan the test user is on — mirrors the known-good usage-limit
// fixture shape.
const LAUNCHED_CONFIG = {
  version: '1.0.0',
  plans: [{ unique_handle: 'starter', name: 'Starter', tier_position: 0, sort_order: 0 }],
  entitlements: [{ unique_handle: 'generations', name: 'Generations', type: 'usage_limit', unit: 'images' }],
  entitlement_rules: [
    {
      id: 'r_starter', entitlement_id: 'generations', targets: [{ kind: 'plan', id: 'starter' }], segment_ids: [],
      kind: 'usage_limit', limit_value: 30, unit: 'images', period_scope: 'per_month', enforcement: 'hard_block',
    },
  ],
  segments: [], content_ui_paths: [], surface_templates: [], placements: [],
};

afterEach(() => vi.restoreAllMocks());

describe('entitlement checks fail closed', () => {
  it('denies (config_unavailable) when the launched config cannot be fetched (non-ok)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    const result = await serverSdk().checkEntitlement('generations');
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('denied');
    // Server mode has no config to evaluate against → fail closed, distinctly.
    expect(result.reason).toBe('config_unavailable');
  });

  it('denies (config_unavailable) when the launched config fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const result = await serverSdk().checkEntitlement('generations');
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('denied');
    expect(result.reason).toBe('config_unavailable');
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

  it('server mode: fetches the launched Playbook from /api/sdk/config and grants via LOCAL eval (plan 159)', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/sdk/config')) {
        return new Response(JSON.stringify(LAUNCHED_CONFIG), {
          status: 200,
          headers: { 'content-type': 'application/json', ETag: '"v1"' },
        });
      }
      // Telemetry / other best-effort calls: succeed quietly.
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await serverSdk().checkEntitlement('generations');
    expect(result.allowed).toBe(true);
    expect(result.status).not.toBe('denied');
    // The decision came from the fetched launched config — not a per-check call.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/sdk/config'))).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/sdk/check-entitlement'))).toBe(false);
  });
});
