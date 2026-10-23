/**
 * Hosted Node server SDK (BL-0404 finding, ST-455 ingest half): a
 * `RuntimeMode.Server` / headless instance on a backend authenticates its
 * Playbook delivery and event ingest with the SERVER key (`apiKey`).
 *
 * Before: the SDK read only `publicKey`, so an `apiKey`-only server instance
 * loaded no Playbook (every check `config_unavailable`) and posted events with
 * an empty bearer — and a public key from a backend is refused by the
 * control plane's origin gate anyway.
 *
 * The browser rule is asserted too: in a browser the server key is never
 * sent, whatever was passed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initRevTurbine } from './controllers';
import { resolveSdkDeliveryCredential } from './customer-side';

const ENDPOINT = 'https://edge.example.com';
const SERVER_KEY = 'rtk_server_secret';
const PUBLIC_KEY = 'rtk_public_key';

const PLAYBOOK = {
  version: '1.0.0',
  bundle_schema_version: 16,
  tenant_id: 'tenant_hosted',
  environment_id: 'production',
  plans: [
    { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
    { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 1 },
  ],
  entitlements: [{ unique_handle: 'sso', name: 'SSO', type: 'feature' }],
  entitlement_rules: [
    { id: 'r_sso_pro', entitlement_id: 'sso', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], kind: 'feature', enabled: true },
  ],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [],
};

type Call = { url: string; authorization: string | null };
let calls: Call[] = [];

function stubControlPlane(): void {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get('authorization') });
    if (url.includes('/api/sdk/bootstrap')) {
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as unknown as Response;
    }
    if (url.includes('/api/sdk/config')) {
      const body = JSON.stringify(PLAYBOOK);
      return { ok: true, status: 200, headers: new Headers(), text: async () => body, json: async () => PLAYBOOK } as unknown as Response;
    }
    return { ok: true, status: 202, headers: new Headers(), json: async () => ({}), text: async () => '' } as unknown as Response;
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hosted = {
  endpoint: ENDPOINT,
  anonymousTelemetry: false,
  contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
};

describe('hosted server mode: the server key authenticates delivery and ingest on a backend', () => {
  it('replaces a compatible startup seed with the hosted Playbook', async () => {
    stubControlPlane();
    const session = await initRevTurbine({
      ...hosted, runtimeMode: 'revturbine_server', apiKey: SERVER_KEY, user: { id: 'user_1', plan_handle: 'pro' },
      localRuntime: { playbook: { ...PLAYBOOK, entitlement_rules: [] } },
    });
    expect((await session.sdk.can('sso')).allowed).toBe(true);
    expect(calls.some(({ url }) => url.includes('/api/sdk/config'))).toBe(true);
    session.sdk.dispose();
  });

  it('keeps LocalOnly seeds offline', async () => {
    stubControlPlane();
    const session = await initRevTurbine({
      ...hosted, runtimeMode: 'local_only', apiKey: SERVER_KEY,
      localRuntime: { playbook: PLAYBOOK },
    });
    expect(calls).toHaveLength(0);
    session.sdk.dispose();
  });

  it('an apiKey-only backend instance loads the launched Playbook and decides with it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubControlPlane();
    const session = await initRevTurbine({ ...hosted, apiKey: SERVER_KEY, user: { id: 'user_1', plan_handle: 'pro' } });
    const result = await session.sdk.can('sso');
    expect(result.reason).not.toBe('config_unavailable');
    expect(result.allowed).toBe(true);
    const delivery = calls.filter(({ url }) => url.includes('/api/sdk/'));
    expect(delivery.length).toBeGreaterThan(0);
    for (const call of delivery.filter(({ url }) => /bootstrap|config/.test(url))) {
      expect(call.authorization).toBe(`Bearer ${SERVER_KEY}`);
    }
    expect(session.sdk.getPlaybookLoadFailure()).toBeUndefined();
    session.sdk.dispose();
  });

  it('reports events to /api/track with the server key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubControlPlane();
    const session = await initRevTurbine({ ...hosted, apiKey: SERVER_KEY, user: { id: 'user_1' } });
    await session.sdk.track('report_exported', { format: 'csv' });
    await session.sdk.flushEvents();
    const track = calls.filter(({ url }) => url.includes('/api/track'));
    expect(track.length).toBeGreaterThan(0);
    expect(track.every(({ authorization }) => authorization === `Bearer ${SERVER_KEY}`)).toBe(true);
    session.sdk.dispose();
  });

  it('on a backend with both keys, the server key is used (a public key without an Origin is refused upstream)', () => {
    expect(resolveSdkDeliveryCredential({ apiKey: SERVER_KEY, publicKey: PUBLIC_KEY })).toEqual({ token: SERVER_KEY, kind: 'server' });
  });
});

describe('hosted server mode: a browser never sends the server key', () => {
  function stubBrowser(): void {
    vi.stubGlobal('window', { location: { hostname: 'customer.example.com', href: 'https://customer.example.com/', pathname: '/' } });
    vi.stubGlobal('document', {});
  }

  it('the delivery credential in a browser is the public key, even when apiKey is passed', () => {
    stubBrowser();
    expect(resolveSdkDeliveryCredential({ apiKey: SERVER_KEY, publicKey: PUBLIC_KEY })).toEqual({ token: PUBLIC_KEY, kind: 'public' });
    expect(resolveSdkDeliveryCredential({ apiKey: SERVER_KEY })).toBeUndefined();
  });
});

describe('hosted server mode: a browser Web Worker or service worker never sends the server key', () => {
  // A worker scope has no `window` / `document`, so core's `isServer()` is true
  // there. The credential test must still treat it as a browser.
  class FakeWorkerScope {
    static [Symbol.hasInstance](): boolean {
      return true;
    }
  }

  const workerStubs: Record<string, () => void> = {
    'dedicated Web Worker (WorkerGlobalScope)': () => vi.stubGlobal('WorkerGlobalScope', FakeWorkerScope),
    'service worker (ServiceWorkerGlobalScope)': () => vi.stubGlobal('ServiceWorkerGlobalScope', FakeWorkerScope),
    'classic worker (importScripts only)': () => vi.stubGlobal('importScripts', () => undefined),
  };

  for (const [label, stubWorker] of Object.entries(workerStubs)) {
    it(`${label}: the delivery credential is the public key, and apiKey alone resolves nothing`, () => {
      stubWorker();
      expect(resolveSdkDeliveryCredential({ apiKey: SERVER_KEY, publicKey: PUBLIC_KEY })).toEqual({ token: PUBLIC_KEY, kind: 'public' });
      expect(resolveSdkDeliveryCredential({ apiKey: SERVER_KEY })).toBeUndefined();
    });
  }

  it('end to end in a worker with both keys: every request carries the public key, the secret appears nowhere', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('WorkerGlobalScope', FakeWorkerScope);
    stubControlPlane();
    const session = await initRevTurbine({ ...hosted, publicKey: PUBLIC_KEY, apiKey: SERVER_KEY, user: { id: 'user_1' } });
    await session.sdk.track('report_exported', { format: 'csv' });
    await session.sdk.flushEvents();
    expect(calls.some(({ url }) => /bootstrap|config/.test(url))).toBe(true);
    expect(calls.some(({ url }) => url.includes('/api/track'))).toBe(true);
    for (const call of calls) expect(call.authorization).toBe(`Bearer ${PUBLIC_KEY}`);
    expect(JSON.stringify(calls)).not.toContain(SERVER_KEY);
    session.sdk.dispose();
  });

  it('end to end in a worker with apiKey only: no request carries the secret, and the failure names publicKey', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('ServiceWorkerGlobalScope', FakeWorkerScope);
    stubControlPlane();
    // Without a tenantId the worker init throws (no browser credential names
    // the tenant), exactly as in a window context; with one it runs keyless.
    const session = await initRevTurbine({ ...hosted, tenantId: 'tenant_hosted', apiKey: SERVER_KEY, user: { id: 'user_1' } });
    await session.sdk.track('report_exported', { format: 'csv' });
    await session.sdk.flushEvents();
    expect(JSON.stringify(calls)).not.toContain(SERVER_KEY);
    expect(session.sdk.getPlaybookLoadFailure()?.stage).toBe('credentials');
    session.sdk.dispose();
  });

  it('server runtimes with a worker-style scope (Vercel Edge) still use the server key', () => {
    vi.stubGlobal('WorkerGlobalScope', FakeWorkerScope);
    vi.stubGlobal('EdgeRuntime', 'edge-runtime');
    expect(resolveSdkDeliveryCredential({ apiKey: SERVER_KEY, publicKey: PUBLIC_KEY })).toEqual({ token: SERVER_KEY, kind: 'server' });
  });
});
