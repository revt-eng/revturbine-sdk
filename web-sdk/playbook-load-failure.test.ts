/**
 * BL-0012 — a Playbook load failure is distinguishable from "not loaded yet".
 *
 * Before: the hosted fetch swallowed every failure (`catch { return
 * this.cached }`, `if (!bootstrap.ok) return undefined`), `can()` answered
 * `config_unavailable`, and nothing named the endpoint or the credential. An
 * `apiKey`-only init fetched nothing and said nothing. Now the failure is
 * readable through `getPlaybookLoadFailure()` and warned once while no
 * Playbook is loaded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk, type RevTurbineInitOptions } from './customer-side';
import { InMemoryStorage } from './storage';
import { normalizeConfigArtifactOrThrow } from './config-artifact';

const ENDPOINT = 'https://edge.example.com';

const LEGACY_CONFIG = {
  version: '1.0.0',
  bundle_schema_version: 16,
  tenant_id: 'tenant_bl0012',
  environment_id: 'production',
  plans: [{ unique_handle: 'starter', name: 'Starter', tier_position: 0, sort_order: 0 }],
  entitlements: [{ unique_handle: 'sso', name: 'SSO', type: 'feature' }],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Responder = (url: string) => { status: number; body?: string };

function stubFetch(respond: Responder): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes('/api/sdk/bootstrap') && !url.includes('/api/sdk/config')) {
      return { ok: true, status: 202, json: async () => ({}), text: async () => '', headers: new Headers() } as unknown as Response;
    }
    const { status, body = '' } = respond(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => JSON.parse(body || '{}'),
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    } as unknown as Response;
  }));
}

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_bl0012',
    publicKey: 'rtk_public_test',
    endpoint: ENDPOINT,
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

function warnings(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map(([message]) => String(message)).filter((m) => m.includes('The Playbook did not load'));
}

describe('BL-0012: a refused publicKey is named, not silent', () => {
  it.each(['hosted', 'resolver-version', 'resolver-extension'])('an incompatible %s Playbook cannot be bypassed by hydrated entitlements', async (kind) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch((url) => url.includes('/bootstrap') ? { status: 404 } : {
      status: 200, body: JSON.stringify({ ...LEGACY_CONFIG, bundle_schema_version: 999 }),
    });
    const sdk = makeSdk(kind === 'hosted' ? {} : {
      localRuntime: { resolvers: { resolvePlaybook: () => {
        const raw = kind === 'resolver-version'
          ? { ...LEGACY_CONFIG, bundle_schema_version: 999 }
          : { ...LEGACY_CONFIG, bundle_schema_version: 18, extension_rules: [{ kind: 'geo.v1', must_understand: true }] };
        const parsed = normalizeConfigArtifactOrThrow(raw, 'resolver');
        if (!parsed) throw new Error('Missing fixture');
        return parsed;
      } } },
    });
    const placementId = await sdk.registerPlacement({ name: 'Cached upsell' });
    sdk.hydrate({
      version: '1.0.0', request_id: 'hydrated', tenant_id: 'tenant_bl0012',
      evaluated_at: '2026-10-22T00:00:00Z', ttl_seconds: 60, user: { id: 'user_1' },
      entitlements: { sso: { status: 'allowed', allowed: true } },
      decisions: [{ slot_id: placementId, visible: true, output: {
        output_id: 'output', category: 'upsell', surface: { type: 'banner' },
        content: { header: 'Cached grant' }, rule_id: 'rule', decision_id: 'decision',
        config_version: 'old', present_upsell: true,
      } }],
    });
    expect((await sdk.can('sso')).allowed).toBe(false);
    sdk.dispose();
  });

  it.each([false, true])('actual session cache: compatibility refusal=%s', async (refused) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch((url) => url.includes('/bootstrap') || !refused ? { status: 500 } : {
      status: 200, body: JSON.stringify({ ...LEGACY_CONFIG, bundle_schema_version: 999 }),
    });
    const stores = { sessionStorage: new InMemoryStorage(), persistentStorage: new InMemoryStorage() };
    const seed = makeSdk({ ...stores, runtimeMode: 'local_only', user: { id: 'user_1' },
      localRuntime: { resolvers: { getPlacementDecision: (input) => ({
        placementId: input.placementId, requestId: 'seed', visible: true,
        decisionSource: 'local', reasonCodes: [], content: { header: 'Cached', body: '', ctaLabel: '' },
      }) } },
    });
    const placementId = await seed.registerPlacement({ name: 'Cached upsell' });
    expect((await seed.getPlacementDecision({ placementId, userId: 'user_1' })).visible).toBe(true);
    seed.dispose();
    const sdk = makeSdk({ ...stores, user: { id: 'user_1' } });
    expect(await sdk.registerPlacement({ name: 'Cached upsell' })).toBe(placementId);
    const decision = await sdk.getPlacementDecision({ placementId, userId: 'user_1' });
    expect(decision.visible).toBe(!refused);
    if (refused) expect(decision.reasonCodes).toContain('config_unavailable');
    else expect(decision.decisionSource).toBe('cache');
    sdk.dispose();
  });

  it('a 401 on both steps reports the bootstrap refusal, naming the publicKey and the URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(() => ({ status: 401 }));
    const sdk = makeSdk();
    sdk.identify('user_1');

    const result = await sdk.can('sso');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('config_unavailable');

    const failure = sdk.getPlaybookLoadFailure();
    expect(failure).toMatchObject({ stage: 'bootstrap', status: 401, url: `${ENDPOINT}/api/sdk/bootstrap` });
    expect(failure?.message).toContain('publicKey');
    expect(warnings(warn)).toHaveLength(1);
    expect(warnings(warn)[0]).toContain('HTTP 401');
  });

  it('a 500 on the legacy step reports it with the signed delivery\'s reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch((url) => ({ status: url.includes('/bootstrap') ? 404 : 500 }));
    const sdk = makeSdk();
    sdk.identify('user_1');
    await sdk.can('sso');

    const failure = sdk.getPlaybookLoadFailure();
    expect(failure).toMatchObject({ stage: 'config', status: 500, url: `${ENDPOINT}/api/sdk/config` });
    expect(failure?.message).toContain('HTTP 404');
  });

  it('a successful load reports no failure and warns nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch((url) => (url.includes('/bootstrap') ? { status: 404 } : { status: 200, body: JSON.stringify(LEGACY_CONFIG) }));
    const sdk = makeSdk();
    sdk.identify('user_1');
    await sdk.can('sso');

    expect(sdk.getPlaybookLoadState()).toBe('ready');
    expect(sdk.getPlaybookLoadFailure()).toBeUndefined();
    expect(warnings(warn)).toHaveLength(0);
  });
});

describe('BL-0012: an init with no publicKey says why nothing loads', () => {
  it('in a browser, apiKey only: warns at init that apiKey is never sent, and reports a credentials failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(() => ({ status: 500 }));
    // A browser: the server key must never be used here.
    vi.stubGlobal('window', {
      location: { hostname: 'customer.example.com', href: 'https://customer.example.com/', pathname: '/' },
      addEventListener: () => undefined,
    });
    vi.stubGlobal('document', { addEventListener: () => undefined });
    const sdk = makeSdk({ publicKey: undefined, apiKey: 'rtk_server_secret' });

    const failure = sdk.getPlaybookLoadFailure();
    expect(failure?.stage).toBe('credentials');
    expect(failure?.message).toContain('apiKey');
    expect(failure?.message).not.toContain('rtk_server_secret');
    expect(warnings(warn)).toHaveLength(1);
  });

  it('local mode needs no key and reports nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(() => ({ status: 500 }));
    const sdk = makeSdk({ publicKey: undefined, runtimeMode: 'local_only', localRuntime: { playbook: { ...LEGACY_CONFIG } as never } });
    expect(sdk.getPlaybookLoadFailure()).toBeUndefined();
    expect(warnings(warn)).toHaveLength(0);
  });
});
