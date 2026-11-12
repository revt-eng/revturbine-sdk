/**
 * @vitest-environment jsdom
 *
 * ST-1696 (SDK 0.16.0) — anonymous SDK init and error telemetry:
 *
 *   - the missing-user `sdk_error` is the one request an unidentified SDK makes
 *     (connected modes only), with a fixed-vocabulary message;
 *   - it, and every other meta-lane event, is independent of `analytics` and
 *     `telemetry.consent`; only `anonymousTelemetry` turns RevTurbine's copy off;
 *   - `sdkTelemetryProviders` receive the same events alongside or instead of
 *     RevTurbine, a failing provider never affects anything else, and a
 *     provider never sees the public key;
 *   - with a PUBLIC key the RevTurbine request carries it as a bearer (tenant
 *     attribution only); never a server key; no key, no header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk, RuntimeMode, createHttpSdkTelemetryProvider } from './customer-side';
import type { RevTurbineInitOptions, SdkTelemetryProvider } from './customer-side';
import type { SdkMetaEvent } from './generated';
import { InMemoryStorage } from './storage';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];
const sdks: RevTurbineCustomerSdk[] = [];
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response);
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  for (const sdk of sdks.splice(0)) sdk.dispose();
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function build(over: Record<string, unknown> = {}): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    mode: 'snippet',
    runtimeMode: RuntimeMode.Server,
    tenantId: 't_1',
    publicKey: 'pub_attrib_key',
    environmentId: 'production',
    endpoint: 'https://edge.example.com',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    persistentStorage: new InMemoryStorage(),
    sessionStorage: new InMemoryStorage(),
    ...over,
  } as unknown as RevTurbineInitOptions);
  sdks.push(sdk);
  return sdk;
}

const meta = (): FetchCall[] => calls.filter((c) => c.url.endsWith('/api/sdk/meta'));
const eventsOf = (call: FetchCall): Array<Record<string, unknown>> =>
  (JSON.parse(String(call.init.body)) as { events: Array<Record<string, unknown>> }).events;
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 30); });

function recordingProvider(name = 'p'): SdkTelemetryProvider & { received: SdkMetaEvent[] } {
  const received: SdkMetaEvent[] = [];
  return { name, received, send(events) { received.push(...events); } };
}

describe('the unidentified sdk_error', () => {
  it('goes to RevTurbine with the public key as a bearer and a fixed message, in connected mode', async () => {
    build({ user: null });
    await vi.waitFor(() => expect(meta()).toHaveLength(1));
    const headers = meta()[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer pub_attrib_key');
    expect(eventsOf(meta()[0])).toHaveLength(1);
    expect(eventsOf(meta()[0])[0]).toMatchObject({ event_type: 'sdk_error', reason: 'user_id_required', message: 'user_id_required at init' });
    // Nothing identifiable in the body.
    for (const forbidden of ['user_id', 'account_id', 'tenant_id', 'traits', 'public_key']) {
      expect(forbidden in eventsOf(meta()[0])[0]).toBe(false);
    }
    expect(String(meta()[0].init.body)).not.toContain('pub_attrib_key');
  });

  it('names the entry point for identify() and setUserContext()', async () => {
    const sdk = build({ user: { id: 'u1' } });
    sdk.identify('');
    sdk.setUserContext({ id: '' });
    await vi.waitFor(() => expect(meta().filter((c) => String(c.init.body).includes('sdk_error'))).toHaveLength(2));
    const messages = meta().flatMap(eventsOf).filter((e) => e.event_type === 'sdk_error').map((e) => e.message);
    expect(messages).toEqual(expect.arrayContaining(['user_id_required at identify', 'user_id_required at setUserContext']));
  });

  it('is deduped per context for the session', async () => {
    const sdk = build({ user: { id: 'u1' } });
    sdk.identify('');
    sdk.identify('  ');
    await settle();
    expect(meta().filter((c) => String(c.init.body).includes('at identify'))).toHaveLength(1);
  });

  it('is not sent to RevTurbine in local_only mode', async () => {
    build({ user: null, runtimeMode: RuntimeMode.LocalOnly, publicKey: undefined });
    await settle();
    expect(meta().filter((c) => String(c.init.body).includes('sdk_error'))).toHaveLength(0);
  });

  it('is sent whatever analytics and telemetry.consent say', async () => {
    build({ user: null, analytics: false, telemetry: { consent: 'denied' } });
    await vi.waitFor(() => expect(meta()).toHaveLength(1));
  });

  it('is not sent when anonymousTelemetry is false and there are no providers', async () => {
    build({ user: null, anonymousTelemetry: false });
    await settle();
    expect(calls).toEqual([]);
  });

  it('is not sent for a preview render', async () => {
    build({ user: null, previewMode: true });
    await settle();
    expect(meta()).toHaveLength(0);
  });
});

describe('the Authorization header on the meta lane', () => {
  it('a keyless install sends none', async () => {
    build({ user: null, publicKey: undefined });
    await vi.waitFor(() => expect(meta()).toHaveLength(1));
    expect('authorization' in ((meta()[0].init.headers ?? {}) as Record<string, string>)).toBe(false);
  });

  it('a server key is never sent (public key absent)', async () => {
    build({ user: null, publicKey: undefined, apiKey: 'sk_server_secret' });
    await vi.waitFor(() => expect(meta()).toHaveLength(1));
    expect(JSON.stringify(meta()[0].init)).not.toContain('sk_server_secret');
  });

  it('never carries cookies: credentials is omit on RevTurbine\'s request', async () => {
    build({ user: null });
    await vi.waitFor(() => expect(meta()).toHaveLength(1));
    expect(meta()[0].init.credentials).toBe('omit');
  });

  it('is sent on sdk_init for an identified keyed install', async () => {
    build({ user: { id: 'u1' } });
    await vi.waitFor(() => expect(meta().some((c) => String(c.init.body).includes('sdk_init'))).toBe(true));
    const init = meta().find((c) => String(c.init.body).includes('sdk_init'))!;
    expect((init.init.headers as Record<string, string>).authorization).toBe('Bearer pub_attrib_key');
  });
});

describe('sdkTelemetryProviders', () => {
  it('alongside: providers and RevTurbine both receive the event, and the provider never sees the key', async () => {
    const provider = recordingProvider();
    build({ user: null, sdkTelemetryProviders: [provider] });
    await vi.waitFor(() => expect(meta()).toHaveLength(1));
    expect(provider.received).toHaveLength(1);
    expect(provider.received[0]).toMatchObject({ event_type: 'sdk_error', reason: 'user_id_required', message: 'user_id_required at init' });
    expect(JSON.stringify(provider.received)).not.toContain('pub_attrib_key');
  });

  it('instead of: anonymousTelemetry false sends only to the providers', async () => {
    const provider = recordingProvider();
    build({ user: null, anonymousTelemetry: false, sdkTelemetryProviders: [provider] });
    await vi.waitFor(() => expect(provider.received).toHaveLength(1));
    await settle();
    expect(meta()).toHaveLength(0);
  });

  it('receives sdk_init for an identified user, and providers also get events in local_only mode', async () => {
    const provider = recordingProvider();
    build({ user: { id: 'u1' }, runtimeMode: RuntimeMode.LocalOnly, publicKey: undefined, anonymousTelemetry: false, sdkTelemetryProviders: [provider], localRuntime: { playbook: { artifact_type: 'playbook', format_version: '1.0.0', playbook_handle: 'd', playbook_version_id: null, tenant_id: 't_1', environment_id: 'production', plans: [], entitlements: [], entitlement_rules: [], segments: [], content_ui_paths: [], surface_templates: [], placements: [] } } });
    await vi.waitFor(() => expect(provider.received.some((e) => e.event_type === 'sdk_init')).toBe(true));
    expect(meta()).toHaveLength(0);
  });

  it('a local_only unidentified sdk_error reaches the provider but not RevTurbine', async () => {
    const provider = recordingProvider();
    build({ user: null, runtimeMode: RuntimeMode.LocalOnly, publicKey: undefined, sdkTelemetryProviders: [provider] });
    await vi.waitFor(() => expect(provider.received).toHaveLength(1));
    await settle();
    expect(meta().filter((c) => String(c.init.body).includes('sdk_error'))).toHaveLength(0);
  });

  it('a provider that throws, or rejects, never affects the SDK or the other destinations, and warns once', async () => {
    const good = recordingProvider('good');
    const thrower: SdkTelemetryProvider = { name: 'thrower', send() { throw new Error('boom'); } };
    const rejecter: SdkTelemetryProvider = { name: 'rejecter', send: () => Promise.reject(new Error('nope')) };
    const sdk = build({ user: { id: 'u1' }, sdkTelemetryProviders: [thrower, rejecter, good] });
    sdk.identify('');
    sdk.setUserContext({ id: '' });
    await vi.waitFor(() => expect(good.received.length).toBeGreaterThanOrEqual(2));
    await settle();
    expect(meta().length).toBeGreaterThanOrEqual(2);
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((m) => m.includes('"thrower"'))).toHaveLength(1);
    expect(warnings.filter((m) => m.includes('"rejecter"'))).toHaveLength(1);
  });

  it('with no providers and anonymousTelemetry: false nothing is emitted anywhere', async () => {
    const sdk = build({ user: { id: 'u1' }, anonymousTelemetry: false });
    sdk.identify('');
    await settle();
    expect(meta()).toHaveLength(0);
  });

  it('createHttpSdkTelemetryProvider POSTs { events } with only the headers the app gave it', async () => {
    const provider = createHttpSdkTelemetryProvider({ url: 'https://sink.example.com/sdk', headers: { 'x-app': '1' } });
    build({ user: null, anonymousTelemetry: false, sdkTelemetryProviders: [provider] });
    await vi.waitFor(() => expect(calls.some((c) => c.url === 'https://sink.example.com/sdk')).toBe(true));
    const hit = calls.find((c) => c.url === 'https://sink.example.com/sdk')!;
    expect(hit.init.method).toBe('POST');
    expect(hit.init.keepalive).toBe(true);
    expect(hit.init.credentials).toBe('omit');
    const headers = hit.init.headers as Record<string, string>;
    expect(headers['x-app']).toBe('1');
    expect('authorization' in headers).toBe(false);
    expect(JSON.stringify(hit.init)).not.toContain('pub_attrib_key');
    expect((JSON.parse(String(hit.init.body)) as { events: unknown[] }).events).toHaveLength(1);
  });
});
