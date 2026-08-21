/**
 * Plan 159 TASK-4 — Server-mode placement decisions resolve LOCALLY against
 * the fetched launched Playbook; the remote per-decision endpoints
 * (`/api/sdk/decide-context`, `/api/sdk/decide`, `/api/sdk/get-placement`,
 * `/api/sdk/bootstrap-context`) are RETIRED, mirroring TASK-3's
 * checkEntitlement contract:
 *   - config fetched → the config-driven static resolver decides, no
 *     placement POST ever leaves the SDK;
 *   - config unfetchable → fail-closed `config_unavailable` decision
 *     (not cached) + the config fetch is kicked for the next call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '@revt-eng/core/bundle';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

const RETIRED = ['/api/sdk/decide-context', '/api/sdk/decide', '/api/sdk/get-placement', '/api/sdk/bootstrap-context'];

function serverSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_t4',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'revturbine_server',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
  sdk.setUserContext({ id: 'user_t4', plan: { handle: 'starter', name: 'Starter' } });
  return sdk;
}

// A launched Playbook with a placement whose payload targets the starter plan
// — the static resolver should surface it without any network decision.
const LAUNCHED_CONFIG = {
  version: '1.0.0',
  // Plan 177 TASK-5: the SDK refuses an unversioned payload; a real launched
  // Playbook always carries the envelope (web stamps it).
  bundle_schema_version: SCHEMA_VERSION,
  plans: [{ unique_handle: 'starter', name: 'Starter', tier_position: 0, sort_order: 0 }],
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [
    {
      id: 'pl_upsell',
      name: 'Upsell banner',
      category: 'monetization',
      payloads: [
        {
          payload_id: 'pay_upsell_1',
          target: { plan_ids: ['starter'], segment_chips: [] },
          content_link: null,
          surfaces: [],
          surface_slot_ids: [],
        },
      ],
    },
  ],
};

function stubConfigFetch(status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/api/sdk/config')) {
      return status === 200
        ? new Response(JSON.stringify(LAUNCHED_CONFIG), {
            status: 200,
            headers: { 'content-type': 'application/json', ETag: '"t4"' },
          })
        : new Response('nope', { status });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Server-mode placement decisions are local (plan 159 TASK-4)', () => {
  it('decides from the fetched config; no retired endpoint is ever POSTed', async () => {
    const fetchMock = stubConfigFetch();
    const sdk = serverSdk();
    // Warm the config exactly as checkEntitlement does.
    await sdk.checkEntitlement('anything');
    const placementId = await sdk.registerPlacement({ name: 'Upsell banner' });
    const decision = await sdk.getPlacementDecision({ placementId, userId: 'user_t4' });

    expect(decision.reasonCodes ?? []).not.toContain('config_unavailable');
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    for (const retired of RETIRED) {
      expect(urls.some((u) => u.includes(retired))).toBe(false);
    }
    expect(urls.some((u) => u.includes('/api/sdk/config'))).toBe(true);
  });

  it('fails closed (config_unavailable, uncached) when the config is unfetchable — and kicks the fetch', async () => {
    const fetchMock = stubConfigFetch(503);
    const sdk = serverSdk();
    const placementId = await sdk.registerPlacement({ name: 'Upsell banner' });
    const decision = await sdk.getPlacementDecision({ placementId, userId: 'user_t4' });

    expect(decision.visible).toBe(false);
    expect(decision.reasonCodes).toContain('config_unavailable');
    // The fetch was kicked (fire-and-forget) so a later call can resolve.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/sdk/config'))).toBe(true);
    // No retired endpoint was consulted as a fallback.
    for (const retired of RETIRED) {
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes(retired))).toBe(false);
    }
  });

  it('getPlacement never POSTs get-placement; configless Server mode returns null and kicks the fetch', async () => {
    const fetchMock = stubConfigFetch(503);
    const sdk = serverSdk();
    const result = await sdk.getPlacement({ placementHandle: 'upsell' });
    expect(result).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/sdk/get-placement'))).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/sdk/config'))).toBe(true);
  });
});
