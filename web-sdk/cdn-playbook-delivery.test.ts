import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildManifest,
  sha256Hex,
  signManifest,
  type BundleManifest,
  type TrustedKey,
} from '@revt-eng/core/bundle';
import { RevTurbineCustomerSdk, type RevTurbineInitOptions } from './customer-side';

const TENANT = 'tenant_fc';
const ENDPOINT = 'https://edge.example.com';

const LAUNCHED_CONFIG = {
  version: '1.0.0',
  bundle_schema_version: 16,
  plans: [{ unique_handle: 'starter', name: 'Starter', tier_position: 0, sort_order: 0 }],
  entitlements: [{
    unique_handle: 'generations',
    name: 'Generations',
    type: 'usage_limit',
    unit: 'images',
  }],
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

interface DeliveryFixture {
  body: string;
  bytes: Uint8Array;
  manifest: BundleManifest;
}

interface RecordedRequest {
  url: string;
  headers: Headers;
}

async function deliveryFixture(
  nowMs: number,
  window: { notBeforeMs: number; expiresAtMs: number } = {
    notBeforeMs: nowMs,
    expiresAtMs: nowMs + 60 * 60_000,
  },
): Promise<DeliveryFixture> {
  const body = JSON.stringify(LAUNCHED_CONFIG);
  const bytes = new TextEncoder().encode(body);
  const sha256 = await sha256Hex(bytes);
  const manifest = await buildManifest({
    tenantId: TENANT,
    configVersion: 'cfg-v1',
    active: {
      url: `/api/bundles/${TENANT}/${sha256}.json?e=9999999999&s=test`,
      sha256,
      byte_length: bytes.byteLength,
    },
    notBefore: new Date(window.notBeforeMs),
    expiresAt: new Date(window.expiresAtMs),
    now: new Date(nowMs),
  });
  return { body, bytes, manifest };
}

function sdk(overrides: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  const client = new RevTurbineCustomerSdk({
    tenantId: TENANT,
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    endpoint: ENDPOINT,
    mode: 'snippet',
    runtimeMode: 'revturbine_server',
    analytics: false,
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...overrides,
  });
  client.setUserContext({ id: 'user_fc', plan: { handle: 'starter', name: 'Starter' } });
  return client;
}

function responseRouter(args: {
  inlineManifest: BundleManifest;
  fetchedManifest?: BundleManifest;
  bundleBody: string;
  legacy?: Response;
  requests: RecordedRequest[];
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    args.requests.push({ url, headers: new Headers(init?.headers) });
    if (url.endsWith('/api/sdk/bootstrap')) {
      return Response.json({
        manifest_url: `/api/config/manifest/${TENANT}?e=9999999999&s=test`,
        trusted_key_ids: [],
        manifest: args.inlineManifest,
      });
    }
    if (url.includes('/api/config/manifest/')) {
      return Response.json(args.fetchedManifest ?? args.inlineManifest);
    }
    if (url.includes('/api/bundles/')) {
      return new Response(args.bundleBody, { status: 200 });
    }
    if (url.endsWith('/api/sdk/config')) {
      return args.legacy ?? new Response('unavailable', { status: 503 });
    }
    return new Response('{}', { status: 200 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('hosted CDN Playbook delivery', () => {
  it('uses a fresh inline manifest, verifies bundle bytes, and skips the manifest hop', async () => {
    const now = Date.UTC(2026, 7, 30, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fixture = await deliveryFixture(now);
    const requests: RecordedRequest[] = [];
    vi.stubGlobal('fetch', responseRouter({
      inlineManifest: fixture.manifest,
      bundleBody: fixture.body,
      requests,
    }));

    const result = await sdk().checkEntitlement('generations');
    expect(result.allowed).toBe(true);
    const deliveryRequests = requests.filter(({ url }) =>
      url.includes('/api/sdk/bootstrap')
      || url.includes('/api/config/manifest/')
      || url.includes('/api/bundles/')
      || url.includes('/api/sdk/config'),
    );
    expect(deliveryRequests.map(({ url }) => url)).toEqual([
      `${ENDPOINT}/api/sdk/bootstrap`,
      expect.stringContaining('/api/bundles/'),
    ]);
    expect(deliveryRequests[0]?.headers.get('authorization')).toBe('Bearer pub_test');
    expect(deliveryRequests[1]?.headers.get('authorization')).toBeNull();
  });

  it('refetches an expired inline manifest before activating a bundle', async () => {
    const now = Date.UTC(2026, 7, 30, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const expired = await deliveryFixture(now, {
      notBeforeMs: now - 2 * 60 * 60_000,
      expiresAtMs: now - 60 * 60_000,
    });
    const fresh = await deliveryFixture(now);
    const requests: RecordedRequest[] = [];
    vi.stubGlobal('fetch', responseRouter({
      inlineManifest: expired.manifest,
      fetchedManifest: fresh.manifest,
      bundleBody: fresh.body,
      requests,
    }));

    expect((await sdk().checkEntitlement('generations')).allowed).toBe(true);
    expect(requests.some(({ url }) => url.includes('/api/config/manifest/'))).toBe(true);
    expect(requests.some(({ url }) => url.includes('/api/bundles/'))).toBe(true);
  });

  it.each(['bootstrap', 'manifest', 'bundle'])(
    'falls back without throwing when the %s hop returns an error',
    async (failedHop) => {
      const now = Date.UTC(2026, 7, 30, 12);
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const fresh = await deliveryFixture(now);
      const expired = await deliveryFixture(now, {
        notBeforeMs: now - 2 * 60 * 60_000,
        expiresAtMs: now - 60 * 60_000,
      });
      const requests: RecordedRequest[] = [];
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });
        if (url.endsWith('/api/sdk/bootstrap')) {
          if (failedHop === 'bootstrap') return new Response('unavailable', { status: 503 });
          return Response.json({
            manifest_url: `/api/config/manifest/${TENANT}?e=9999999999&s=test`,
            manifest: failedHop === 'manifest' ? expired.manifest : fresh.manifest,
          });
        }
        if (url.includes('/api/config/manifest/')) {
          return failedHop === 'manifest'
            ? new Response('unavailable', { status: 503 })
            : Response.json(fresh.manifest);
        }
        if (url.includes('/api/bundles/')) {
          return failedHop === 'bundle'
            ? new Response('unavailable', { status: 503 })
            : new Response(fresh.body, { status: 200 });
        }
        if (url.endsWith('/api/sdk/config')) {
          return new Response(fresh.body, { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }));

      const result = await sdk().checkEntitlement('generations');
      expect(result.allowed).toBe(true);
      expect(requests.some(({ url }) => url.endsWith('/api/sdk/config'))).toBe(true);
    },
  );

  it.each([false, true])(
    'rejects expired inline and fetched manifests with signature verification=%s, then falls back',
    async (verifySignatures) => {
      const now = Date.UTC(2026, 7, 30, 12);
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const expired = await deliveryFixture(now, {
        notBeforeMs: now - 2 * 60 * 60_000,
        expiresAtMs: now - 60 * 60_000,
      });
      let manifest = expired.manifest;
      let trustedManifestKeys: readonly TrustedKey[] | undefined;
      if (verifySignatures) {
        const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
        manifest = await signManifest({ manifest, privateKey: keys.privateKey, keyId: 'test-key' });
        trustedManifestKeys = [{ key_id: 'test-key', publicKey: keys.publicKey }];
      }
      const requests: RecordedRequest[] = [];
      vi.stubGlobal('fetch', responseRouter({
        inlineManifest: manifest,
        fetchedManifest: manifest,
        bundleBody: expired.body,
        legacy: new Response(expired.body, { status: 200 }),
        requests,
      }));

      expect((await sdk({ trustedManifestKeys }).checkEntitlement('generations')).allowed).toBe(true);
      expect(requests.some(({ url }) => url.endsWith('/api/sdk/config'))).toBe(true);
      expect(requests.some(({ url }) => url.includes('/api/bundles/'))).toBe(false);
    },
  );

  it('falls back when bundle integrity fails and retains last-known-good on later outages', async () => {
    const now = Date.UTC(2026, 7, 30, 12);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fixture = await deliveryFixture(now);
    const requests: RecordedRequest[] = [];
    const fetchMock = responseRouter({
      inlineManifest: fixture.manifest,
      bundleBody: fixture.body,
      requests,
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = sdk();
    expect((await client.checkEntitlement('generations')).allowed).toBe(true);

    clock.mockReturnValue(now + 61_000);
    const failedRefreshRequests: RecordedRequest[] = [];
    const tamperedRefresh = responseRouter({
      inlineManifest: fixture.manifest,
      bundleBody: `${fixture.body}tampered`,
      legacy: new Response('unavailable', { status: 503 }),
      requests: failedRefreshRequests,
    });
    fetchMock.mockImplementation(tamperedRefresh);
    const retained = await client.checkEntitlement('generations');
    expect(retained.allowed).toBe(true);
    expect(failedRefreshRequests.some(({ url }) => url.endsWith('/api/sdk/config'))).toBe(true);
  });

  it('rejects an untrusted manifest signature but accepts the same manifest when verification is disabled', async () => {
    const now = Date.UTC(2026, 7, 30, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fixture = await deliveryFixture(now);
    const signer = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    const stranger = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    const signed = await signManifest({
      manifest: fixture.manifest,
      privateKey: signer.privateKey,
      keyId: 'signer',
    });
    const trustedManifestKeys = [{ key_id: 'stranger', publicKey: stranger.publicKey }];

    const deniedRequests: RecordedRequest[] = [];
    vi.stubGlobal('fetch', responseRouter({
      inlineManifest: signed,
      fetchedManifest: signed,
      bundleBody: fixture.body,
      requests: deniedRequests,
    }));
    const denied = await sdk({ trustedManifestKeys }).checkEntitlement('generations');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('config_unavailable');

    const acceptedRequests: RecordedRequest[] = [];
    vi.stubGlobal('fetch', responseRouter({
      inlineManifest: signed,
      fetchedManifest: signed,
      bundleBody: fixture.body,
      requests: acceptedRequests,
    }));
    expect((await sdk().checkEntitlement('generations')).allowed).toBe(true);
  });
});
