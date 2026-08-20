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
 *   - local mode, no Playbook + no cache                 → entitlement_not_in_playbook
 *   - SDK disabled by provider failure                   → sdk_disabled_provider_failure
 * and the happy path: server mode fetches the Playbook and grants locally.
 *
 * Plan 194 REQ-1 footnote: this file's own fixture used to build its user with
 * `plan: { id: 'starter' }` — the shape retired in 0.3.0 — and the happy-path
 * tests still passed, because an unresolvable plan identity GRANTED. That is
 * the fail-open this suite exists to rule out, reproduced inside the suite
 * itself. With the identity now failing closed, the fixture had to start
 * supplying a real handle for those tests to mean anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlaybookPayload, sha256Hex, SCHEMA_VERSION } from '@revt-eng/core/bundle';
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
  sdk.setUserContext({ id: 'user_fc', plan: { handle: 'starter', name: 'Starter' } });
  return sdk;
}

// A launched Playbook that grants `generations` (usage_limit, under limit) to
// the `starter` plan the test user is on — mirrors the known-good usage-limit
// fixture shape.
const LAUNCHED_CONFIG = {
  version: '1.0.0',
  // A real launched Playbook always carries the payload version envelope —
  // web's build-exported-config stamps it — and since plan 177 TASK-5 the
  // SDK refuses an unversioned payload rather than partially applying it.
  bundle_schema_version: SCHEMA_VERSION,
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
    sdk.setUserContext({ id: 'user_fc', plan: { handle: 'starter', name: 'Starter' } });
    const result = await sdk.checkEntitlement('data_export');
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('denied');
    expect(result.reason).toBe('entitlement_not_in_playbook');
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

  it('server mode: consumes the canonical payload artifact, integrity-verified, and grants via LOCAL eval (plan 177 TASK-5)', async () => {
    // The exact artifact the control plane serves post plan 177: canonical
    // bytes off the payload compiler, content address in x-bundle-sha256.
    const { canonical, bytes } = buildPlaybookPayload(
      {
        ...LAUNCHED_CONFIG,
        format_version: '1.0.0',
        tenant_id: 'tenant_fc',
        environment_id: 'env_live',
        playbook_handle: 'default',
      } as never,
      { tenantId: 'tenant_fc', clock: () => 1_700_000_000_000 },
    );
    const sha = await sha256Hex(bytes);
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/sdk/config')) {
        return new Response(canonical, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            ETag: `"${sha}"`,
            'x-bundle-sha256': sha,
          },
        });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await serverSdk().checkEntitlement('generations');
    expect(result.allowed).toBe(true);
    expect(result.status).not.toBe('denied');

    const configCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/sdk/config'));
    expect(configCall).toBeTruthy();
    // Plain JSON — the octet-stream negotiation is gone.
    const sentHeaders = (configCall![1] as RequestInit).headers as Record<string, string>;
    expect(sentHeaders.accept).toBe('application/json');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/sdk/check-entitlement'))).toBe(false);
  });

  it('denies (config_unavailable) when the payload bytes do not hash to the advertised content address', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/sdk/config')) {
        return new Response(JSON.stringify(LAUNCHED_CONFIG), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-bundle-sha256': 'f'.repeat(64), // wrong address — tampered or corrupted
          },
        });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await serverSdk().checkEntitlement('generations');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('config_unavailable');
  });

  it('denies (config_unavailable) rather than partially applying a payload from a newer schema (plan 177 AC-3)', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/sdk/config')) {
        return new Response(
          JSON.stringify({ ...LAUNCHED_CONFIG, bundle_schema_version: SCHEMA_VERSION + 10 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await serverSdk().checkEntitlement('generations');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('config_unavailable');
  });

  it('denies (config_unavailable) for an UNVERSIONED payload — refusal needs a version to trust', async () => {
    const { bundle_schema_version: _dropped, ...unversioned } = LAUNCHED_CONFIG;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/sdk/config')) {
        return new Response(JSON.stringify(unversioned), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await serverSdk().checkEntitlement('generations');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('config_unavailable');
  });

  it('preserves a runtime-discovered trigger.slot_id through the payload path (plan 177 AC-6, SDK half)', async () => {
    // `header_upgrade_cta` is deliberately NOT declared anywhere — the class
    // of reference the FlatBuffer path destroyed (stored as an index into an
    // empty slots table). The JSON payload carries it by value.
    const withSlotRef = {
      ...LAUNCHED_CONFIG,
      format_version: '1.0.0',
      tenant_id: 'tenant_fc',
      environment_id: 'env_live',
      playbook_handle: 'default',
      placements: [
        {
          id: 'pl_header_upgrade',
          name: 'Header upgrade CTA',
          category: 'fixed',
          trigger: { type: 'surface_render', slot_id: 'header_upgrade_cta' },
          order: 0,
          payloads: [],
        },
      ],
    };
    const { canonical, payload } = buildPlaybookPayload(withSlotRef as never, {
      tenantId: 'tenant_fc',
      clock: () => 1_700_000_000_000,
    });
    // By value in the artifact itself…
    expect(canonical).toContain('"slot_id":"header_upgrade_cta"');
    const placements = payload.placements as Array<{ trigger: Record<string, unknown> }>;
    expect(placements[0]!.trigger.slot_id).toBe('header_upgrade_cta');

    // …and the SDK consumes that artifact without error (the FB path threw
    // in toPlaybook() here and silently failed every check closed).
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/api/sdk/config')) {
        return new Response(canonical, {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await serverSdk().checkEntitlement('generations');
    expect(result.allowed).toBe(true);
  });
});
