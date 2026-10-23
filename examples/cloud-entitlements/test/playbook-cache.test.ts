import assert from 'node:assert/strict';
import test from 'node:test';
import fixture from './fixtures/playbook.json' with { type: 'json' };
import { createPlaybookCache } from '../src/playbook-cache.ts';

const CONTROL = 'https://control.example.test';
const CDN = 'https://cdn.example.test';

async function artifact(payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return { bytes, sha256 };
}

async function harness(payload: unknown = fixture) {
  const state: {
    now: number; artifact: Awaited<ReturnType<typeof artifact>>; bootstrapStatus: number;
    inlineManifest: boolean; relativeUrls: boolean; manifestOverrides: Record<string, unknown>;
    bundleOverride: Uint8Array<ArrayBuffer> | undefined; bundleElapsedMs: number; metadataPadding: string;
  } = {
    now: Date.parse('2026-10-23T12:00:00Z'),
    artifact: await artifact(payload),
    bootstrapStatus: 200,
    inlineManifest: true,
    relativeUrls: false,
    manifestOverrides: {},
    bundleOverride: undefined,
    bundleElapsedMs: 0,
    metadataPadding: '',
  };
  const requests: { url: URL; init: RequestInit }[] = [];
  function makeManifest() {
    return {
      manifest_version: '1.0.0', tenant_id: 'tn_example', config_version: '1.0.0',
      schema_version: 18, runtime_abi: 2,
      active: {
        url: `${state.relativeUrls ? '' : CDN}/api/bundles/tn_example/${state.artifact.sha256}.json`,
        sha256: state.artifact.sha256, byte_length: state.artifact.bytes.byteLength,
      },
      not_before: new Date(state.now).toISOString(),
      expires_at: new Date(state.now + 3_600_000).toISOString(),
      ...state.manifestOverrides,
    };
  }
  let issued = makeManifest();
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push({ url, init });
    if (url.pathname === '/app/api/sdk/bootstrap') {
      if (state.bootstrapStatus !== 200) return new Response(null, { status: state.bootstrapStatus });
      issued = makeManifest();
      return Response.json({
        padding: state.metadataPadding,
        manifest_url: '/api/manifests/current.json',
        ...(state.inlineManifest ? { manifest: issued } : {}),
      });
    }
    if (url.pathname === '/app/api/manifests/current.json') return Response.json(issued);
    if (url.pathname.includes('/api/bundles/')) {
      state.now += state.bundleElapsedMs;
      return new Response(state.bundleOverride ?? state.artifact.bytes);
    }
    throw new Error(`Unexpected mocked fetch: ${url}`);
  };
  const cache = createPlaybookCache({
    endpoint: `${CONTROL}/app`, apiKey: 'server-key-for-tests',
    tenantId: 'tn_example', environmentId: 'production',
    allowedCdnOrigins: [CONTROL, CDN], fetch: fetcher, now: () => state.now,
  });
  return {
    cache, state, requests,
    bootstrapCount: () => requests.filter(r => r.url.pathname.endsWith('/sdk/bootstrap')).length,
    bundleCount: () => requests.filter(r => r.url.pathname.includes('/api/bundles/')).length,
  };
}

test('concurrent cold calls share a load, warm hits reuse the immutable Playbook, and CDN gets no bearer', async () => {
  const h = await harness();
  const snapshots = await Promise.all(Array.from({ length: 10 }, () => h.cache.get()));
  assert.ok(snapshots.every(s => s === snapshots[0]));
  assert.equal(h.bootstrapCount(), 1);
  assert.equal(h.bundleCount(), 1);
  assert.ok(Object.isFrozen(snapshots[0].playbook));
  assert.ok(Object.isFrozen(snapshots[0].playbook.entitlements));
  assert.equal(await h.cache.get(), snapshots[0]);
  assert.equal(h.requests.length, 2);
  for (const { url, init } of h.requests) {
    const authorization = new Headers(init.headers).get('authorization');
    assert.equal(authorization, url.origin === CONTROL ? 'Bearer server-key-for-tests' : null);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
  }
});

test('refresh with the same digest skips download and parse; a changed digest replaces the snapshot', async () => {
  const h = await harness();
  const first = await h.cache.get();
  h.state.now = first.refreshAt;
  const unchanged = await h.cache.get();
  assert.equal(unchanged.playbook, first.playbook);
  assert.equal(h.bootstrapCount(), 2);
  assert.equal(h.bundleCount(), 1);
  h.state.artifact = await artifact({ ...fixture, playbook_version_id: 'pv_next' });
  h.state.now = unchanged.refreshAt;
  const changed = await h.cache.get();
  assert.notEqual(changed.sha256, first.sha256);
  assert.notEqual(changed.playbook, first.playbook);
  assert.equal(changed.playbook.playbook_version_id, 'pv_next');
  assert.equal(first.playbook.playbook_version_id, 'pv_example');
  assert.equal(h.bundleCount(), 2);
});

test('corrupted bytes are refused before normalization or evaluation', async () => {
  const h = await harness();
  h.state.bundleOverride = h.state.artifact.bytes.slice();
  h.state.bundleOverride[0] ^= 1; // Keep byte length constant, change the digest.
  await assert.rejects(h.cache.get(), /integrity mismatch/);
});

test('delivery size and byte-length guards reject oversized and mismatched responses', async t => {
  await t.test('byte length mismatch', async () => {
    const h = await harness(); h.state.bundleOverride = h.state.artifact.bytes.slice(1);
    await assert.rejects(h.cache.get(), /byte length mismatch/);
  });
  await t.test('metadata larger than 128 KiB', async () => {
    const h = await harness(); h.state.metadataPadding = 'x'.repeat(128 * 1024);
    await assert.rejects(h.cache.get(), /size limit exceeded/);
    assert.equal(h.bundleCount(), 0);
  });
  await t.test('actual streamed bundle exceeds 5 MiB despite a smaller declared size', async () => {
    const h = await harness(); h.state.bundleOverride = new Uint8Array(5 * 1024 * 1024 + 1);
    await assert.rejects(h.cache.get(), /size limit exceeded/);
  });
  await t.test('manifest declares an oversized bundle before download', async () => {
    const h = await harness(); h.state.manifestOverrides = { active: { url: `${CDN}/api/bundles/large.json`, sha256: h.state.artifact.sha256, byte_length: 5 * 1024 * 1024 + 1 } };
    await assert.rejects(h.cache.get(), /exceeds size limit/);
    assert.equal(h.bundleCount(), 0);
  });
});

test('failed refresh never serves stale policy and briefly coalesces retries before recovering', async () => {
  const h = await harness();
  const first = await h.cache.get();
  h.state.now = first.refreshAt;
  h.state.bootstrapStatus = 503;
  await assert.rejects(h.cache.get(), /HTTP 503/);
  await assert.rejects(h.cache.get(), /HTTP 503/);
  assert.equal(h.bootstrapCount(), 2);
  h.state.now += 1_000;
  h.state.bootstrapStatus = 200;
  const recovered = await h.cache.get();
  assert.equal(recovered.playbook, first.playbook);
  assert.equal(h.bootstrapCount(), 3);
  assert.equal(h.bundleCount(), 1);
});

test('manifest expiration caps the cache TTL and cannot be crossed during a bundle download', async t => {
  await t.test('cached policy expires before the normal 60-second deadline', async () => {
    const h = await harness();
    const expiration = h.state.now + 10_000;
    h.state.manifestOverrides = { expires_at: new Date(expiration).toISOString() };
    const snapshot = await h.cache.get();
    assert.equal(snapshot.refreshAt, expiration);
    h.state.now = expiration;
    await assert.rejects(h.cache.get(), /validity window/);
    assert.equal(h.bootstrapCount(), 2);
  });
  await t.test('a manifest that expires while fetching is not activated', async () => {
    const h = await harness();
    h.state.manifestOverrides = { expires_at: new Date(h.state.now + 1_000).toISOString() };
    h.state.bundleElapsedMs = 1_001;
    await assert.rejects(h.cache.get(), /validity window/);
  });
});

test('the manifest and artifact must match the configured application scope', async t => {
  await t.test('manifest tenant mismatch stops before the CDN request', async () => {
    const h = await harness();
    h.state.manifestOverrides = { tenant_id: 'tn_other' };
    await assert.rejects(h.cache.get(), /manifest tenant mismatch/);
    assert.equal(h.bundleCount(), 0);
  });
  for (const patch of [{ tenant_id: 'tn_other' }, { environment_id: 'staging' }]) {
    await t.test(`payload mismatch: ${Object.keys(patch)[0]}`, async () => {
      const h = await harness({ ...fixture, ...patch });
      await assert.rejects(h.cache.get(), /payload scope mismatch/);
    });
  }
});

test('unsupported payload schema versions and malformed version floors are refused', async t => {
  for (const patch of [
    { bundle_schema_version: 19 },
    { bundle_schema_version: 10 },
    { bundle_min_readable_schema_version: 19 },
    { bundle_schema_version: undefined },
  ]) {
    await t.test(JSON.stringify(patch), async () => {
      const h = await harness({ ...fixture, ...patch });
      await assert.rejects(h.cache.get());
    });
  }
});

test('manifest URL fallback preserves the /app prefix without forwarding the bootstrap key', async () => {
  const h = await harness();
  h.state.inlineManifest = false;
  h.state.relativeUrls = true;
  await h.cache.get();
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests.every(r => r.url.pathname.startsWith('/app/api/')));
  assert.equal(new Headers(h.requests[0].init.headers).get('authorization'), 'Bearer server-key-for-tests');
  assert.ok(h.requests.slice(1).every(r => new Headers(r.init.headers).get('authorization') === null));
});

test('the public reader rejects unknown mandatory extensions but admits optional extensions', async () => {
  const optional = await harness({ ...fixture, extension_rules: [{ kind: 'geo.v1', must_understand: false }] });
  assert.ok((await optional.cache.get()).playbook);
  const mandatory = await harness({ ...fixture, extension_rules: [{ kind: 'geo.v1', must_understand: true }] });
  await assert.rejects(mandatory.cache.get(), /unsupported mandatory extension/);
});

test('an unapproved CDN origin is rejected before it receives a request', async () => {
  const h = await harness();
  h.state.manifestOverrides = {
    active: { url: 'https://unapproved.example.test/playbook.json',
      sha256: h.state.artifact.sha256, byte_length: h.state.artifact.bytes.byteLength },
  };
  await assert.rejects(h.cache.get(), /Unapproved Playbook delivery origin/);
  assert.equal(h.requests.length, 1);
});
