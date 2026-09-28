/**
 * BL-0335 — `tenantId` is optional on a browser init when a `publicKey` is
 * present.
 *
 * The public key is bound to exactly one tenant, so the control plane resolves
 * the tenant from the key alone (and, since web #927, ignores a tenant id that
 * differs from it, with a warning — D-49). The SDK therefore:
 *
 *   - sends no `x-tenant-id` when the integration configured none, and still
 *     sends the configured one when it did (backward compatible for 0.11.13
 *     integrations);
 *   - reads the tenant from the key-authenticated Playbook delivery — the
 *     signed manifest's `tenant_id` and the Playbook's own `tenant_id`;
 *   - on a configured tenant that DISAGREES with that delivery, warns once per
 *     init and adopts the key's tenant (D-49: the key is the sole arbiter);
 *   - keys local state by the configured tenant when there is one (every
 *     existing persisted key unchanged), else by a stable hash of the key;
 *   - still requires a tenant id in `local_only` (no key round trip there),
 *     and refuses an init with neither a key nor a tenant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildManifest, sha256Hex, type BundleManifest } from '@revt-eng/core/bundle';
import { InMemoryStorage } from './storage';
import { RevTurbineCustomerSdk, initRevTurbine, type RevTurbineInitOptions } from './customer-side';
import { loadTheme } from './theme/theme-loader';

const KEY_TENANT = 'tn_key_tenant';
const ENDPOINT = 'https://edge.example.com';

/** A launched Playbook as the control plane serves it: stamped with the key's tenant. */
const LAUNCHED = {
  version: '1.0.0',
  tenant_id: KEY_TENANT,
  bundle_schema_version: 16,
  plans: [{ unique_handle: 'starter', name: 'Starter', tier_position: 0, sort_order: 0 }],
  entitlements: [{ unique_handle: 'generations', name: 'Generations', type: 'usage_limit', unit: 'images' }],
  entitlement_rules: [{
    id: 'r_starter',
    entitlement_id: 'generations',
    targets: [{ kind: 'plan', id: 'starter' }],
    segment_ids: [],
    kind: 'usage_limit',
    limit_value: 30,
    unit: 'images',
    period_scope: 'per_month',
    enforcement: 'hard_block',
  }],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [],
};

interface Recorded {
  url: string;
  headers: Headers;
}

async function manifestFor(body: string, tenantId: string, nowMs: number): Promise<BundleManifest> {
  const bytes = new TextEncoder().encode(body);
  const sha256 = await sha256Hex(bytes);
  return buildManifest({
    tenantId,
    configVersion: 'cfg-v1',
    active: { url: `/api/bundles/${tenantId}/${sha256}.json?e=9999999999&s=test`, sha256, byte_length: bytes.byteLength },
    notBefore: new Date(nowMs),
    expiresAt: new Date(nowMs + 60 * 60_000),
    now: new Date(nowMs),
  });
}

/** Routes the SDK's control-plane calls; `bootstrap: null` forces the legacy `/api/sdk/config` lane. */
function router(requests: Recorded[], opts: { manifest: BundleManifest | null; body: string }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url.endsWith('/api/sdk/bootstrap')) {
      if (!opts.manifest) return new Response('not found', { status: 404 });
      return Response.json({ manifest_url: '/api/config/manifest/x', trusted_key_ids: [], manifest: opts.manifest });
    }
    if (url.includes('/api/bundles/')) return new Response(opts.body, { status: 200 });
    if (url.endsWith('/api/sdk/config')) return new Response(opts.body, { status: 200 });
    return new Response('{}', { status: 202 });
  });
}

function sdk(overrides: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  const client = new RevTurbineCustomerSdk({
    publicKey: 'rtk_public_key_a',
    endpoint: ENDPOINT,
    mode: 'snippet',
    runtimeMode: 'revturbine_server',
    analytics: false,
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...overrides,
  });
  client.setUserContext({ id: 'user_1', plan: { handle: 'starter', name: 'Starter' } });
  return client;
}

const byPath = (requests: Recorded[], path: string) => requests.filter(({ url }) => url.includes(path));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('key-only browser init — the tenant comes from the key', () => {
  it('signed-manifest lane: sends no tenant header and adopts the manifest/Playbook tenant', async () => {
    const now = Date.UTC(2026, 8, 27, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const body = JSON.stringify(LAUNCHED);
    const requests: Recorded[] = [];
    vi.stubGlobal('fetch', router(requests, { manifest: await manifestFor(body, KEY_TENANT, now), body }));

    const client = sdk();
    // Before any Playbook has loaded, the tenant is simply not known yet.
    expect(client.getUserContext().tenant_id).toBe('');

    expect((await client.checkEntitlement('generations')).allowed).toBe(true);
    const [bootstrap] = byPath(requests, '/api/sdk/bootstrap');
    expect(bootstrap?.headers.get('authorization')).toBe('Bearer rtk_public_key_a');
    expect(bootstrap?.headers.get('x-tenant-id')).toBeNull();
    expect(byPath(requests, '/api/sdk/config')).toHaveLength(0);
    expect(client.getUserContext().tenant_id).toBe(KEY_TENANT);
  });

  it('legacy /api/sdk/config lane: sends no tenant header and adopts the Playbook tenant_id', async () => {
    const body = JSON.stringify(LAUNCHED);
    const requests: Recorded[] = [];
    vi.stubGlobal('fetch', router(requests, { manifest: null, body }));

    const client = sdk();
    expect((await client.checkEntitlement('generations')).allowed).toBe(true);
    const [config] = byPath(requests, '/api/sdk/config');
    expect(config?.headers.get('x-tenant-id')).toBeNull();
    expect(client.getUserContext().tenant_id).toBe(KEY_TENANT);
  });
});

describe('configured tenantId — unchanged for 0.11.13 integrations', () => {
  it('still sends the configured tenant on the legacy config fetch', async () => {
    const body = JSON.stringify(LAUNCHED);
    const requests: Recorded[] = [];
    vi.stubGlobal('fetch', router(requests, { manifest: null, body }));

    const client = sdk({ tenantId: KEY_TENANT });
    expect((await client.checkEntitlement('generations')).allowed).toBe(true);
    expect(byPath(requests, '/api/sdk/config')[0]?.headers.get('x-tenant-id')).toBe(KEY_TENANT);
    expect(client.getUserContext().tenant_id).toBe(KEY_TENANT);
  });

});

describe("configured tenantId that disagrees with the key's tenant — warn once and adopt (D-49)", () => {
  const WRONG = 'tn_configured_wrong';
  const expectedWarning =
    `[RevTurbine] tenantId ${WRONG} does not match the key's tenant ${KEY_TENANT}; using ${KEY_TENANT}`;
  const mismatchWarnings = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('does not match the key'));

  it("signed-manifest lane: activates the key's manifest, adopts its tenant, warns once", async () => {
    const now = Date.UTC(2026, 8, 27, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = JSON.stringify(LAUNCHED);
    const requests: Recorded[] = [];
    vi.stubGlobal('fetch', router(requests, { manifest: await manifestFor(body, KEY_TENANT, now), body }));

    const client = sdk({ tenantId: WRONG });
    expect((await client.checkEntitlement('generations')).allowed).toBe(true);
    // The manifest is NOT refused: the bundle is fetched, no legacy fallback.
    expect(byPath(requests, '/api/bundles/')).toHaveLength(1);
    expect(byPath(requests, '/api/sdk/config')).toHaveLength(0);
    expect(client.getUserContext().tenant_id).toBe(KEY_TENANT);
    expect(mismatchWarnings(warn)).toEqual([expectedWarning]);
  });

  it("legacy /api/sdk/config lane: adopts the Playbook's tenant, warns once, then sends the key's tenant", async () => {
    let now = Date.UTC(2026, 8, 27, 12);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = JSON.stringify(LAUNCHED);
    const requests: Recorded[] = [];
    vi.stubGlobal('fetch', router(requests, { manifest: null, body }));

    const client = sdk({ tenantId: WRONG });
    expect((await client.checkEntitlement('generations')).allowed).toBe(true);
    expect(client.getUserContext().tenant_id).toBe(KEY_TENANT);
    expect(mismatchWarnings(warn)).toEqual([expectedWarning]);

    // The first fetch carried the configured (wrong) id — the control plane
    // ignores it. Once adopted, the next refetch carries the key's tenant,
    // and a repeat load does not warn again (once per init).
    expect(byPath(requests, '/api/sdk/config')[0]?.headers.get('x-tenant-id')).toBe(WRONG);
    now += 61_000;
    await client.checkEntitlement('generations');
    await vi.waitFor(() => expect(byPath(requests, '/api/sdk/config').length).toBeGreaterThan(1));
    expect(byPath(requests, '/api/sdk/config').at(-1)?.headers.get('x-tenant-id')).toBe(KEY_TENANT);
    expect(mismatchWarnings(warn)).toHaveLength(1);
  });

  it('a matching configured tenant never warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = JSON.stringify(LAUNCHED);
    vi.stubGlobal('fetch', router([], { manifest: null, body }));

    const client = sdk({ tenantId: KEY_TENANT });
    expect((await client.checkEntitlement('generations')).allowed).toBe(true);
    expect(mismatchWarnings(warn)).toEqual([]);
  });
});

describe('local state namespace', () => {
  function anonKeys(storage: InMemoryStorage): string[] {
    const keys: string[] = [];
    for (const key of ['revturbine:tn_key_tenant:anon']) if (storage.getItem(key) !== null) keys.push(key);
    return keys;
  }

  it('a configured tenant keeps the existing storage keys byte-for-byte', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const storage = new InMemoryStorage();
    sdk({ tenantId: KEY_TENANT, persistentStorage: storage });
    expect(anonKeys(storage)).toEqual(['revturbine:tn_key_tenant:anon']);
  });

  it('a key-only init gets a namespace that is stable per key and distinct across keys', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const setSpy = vi.spyOn(InMemoryStorage.prototype, 'setItem');
    const anonKeyFor = (publicKey: string): string | undefined => {
      setSpy.mockClear();
      sdk({ publicKey, persistentStorage: new InMemoryStorage() });
      return setSpy.mock.calls.map(([key]) => key).find((key) => key.endsWith(':anon'));
    };
    const first = anonKeyFor('rtk_public_key_a');
    expect(first).toMatch(/^revturbine:pk-[0-9a-z]+:anon$/);
    expect(anonKeyFor('rtk_public_key_a')).toBe(first);
    expect(anonKeyFor('rtk_public_key_b')).not.toBe(first);
    // The raw key never lands in a storage key.
    expect(first).not.toContain('rtk_public_key_a');
  });
});

describe('init guards — a tenant must be identifiable', () => {
  it('refuses an init with neither a public key nor a tenant id', () => {
    expect(() => new RevTurbineCustomerSdk({ endpoint: ENDPOINT, runtimeMode: 'revturbine_server' })).toThrow(
      /publicKey.*tenantId/,
    );
  });

  it('still requires tenantId in local_only mode without a local Playbook', () => {
    expect(() => new RevTurbineCustomerSdk({ publicKey: 'rtk_public_key_a', runtimeMode: 'local_only' })).toThrow(
      /`tenantId` is required in `local_only` mode/,
    );
  });

  it('local_only with a local Playbook still defaults the tenant (unchanged)', () => {
    const client = initRevTurbine({
      localRuntime: { playbook: LAUNCHED },
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      anonymousTelemetry: false,
    });
    expect(client.getUserContext().tenant_id).toBe('local');
  });
});

describe('theme loader — no placeholder tenant on the wire', () => {
  it('omits x-tenant-id without a tenant and sends it when configured', async () => {
    const requests: Recorded[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json({});
    }));
    await loadTheme({ endpoint: ENDPOINT, apiKey: 'rtk_public_key_a', storage: new InMemoryStorage() });
    await loadTheme({ tenantId: KEY_TENANT, endpoint: ENDPOINT, apiKey: 'rtk_public_key_a', storage: new InMemoryStorage() });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]?.headers.get('x-tenant-id')).toBeNull();
    expect(requests[1]?.headers.get('x-tenant-id')).toBe(KEY_TENANT);
  });
});
