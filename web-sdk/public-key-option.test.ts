/**
 * Plan 257 — `publicKey` is the browser option; `apiKey` is the server key.
 *
 * Asserts the browser credential contract after the rename:
 *   - `publicKey` is the bearer on ingest AND on control-plane fetches (AC-1),
 *   - precedence is `publicKey`, then `ingestPublicKey`, then `apiKey` (AC-2),
 *   - a deprecated alias without `publicKey` warns exactly once in a
 *     development build and never in production; `publicKey` never warns (AC-3),
 *   - a keyless local-only init fills the placeholder and does not warn (AC-4),
 *   - the keyless anonymous beacon (plan 95) still keys off a *real* public
 *     key, so a legacy `apiKey`-only init keeps sending it (REQ-6).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  RevTurbineCustomerSdk,
  initRevTurbine,
  resetBrowserKeyAliasWarning,
  resolveBrowserPublicKey,
} from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import type { RevTurbineConfig } from './generated';

type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[];
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function okResponse(): Response {
  return {
    ok: true,
    status: 202,
    json: async () => ({ accepted: 1 }),
    text: async () => '',
  } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  resetBrowserKeyAliasWarning();
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(okResponse());
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_abc',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

function bearerOf(call: FetchCall | undefined): string | undefined {
  const headers = (call?.init.headers ?? {}) as Record<string, string>;
  return headers.authorization ?? headers.Authorization;
}

function trackCall(): FetchCall | undefined {
  return calls.find((c) => c.url.includes('/api/track'));
}

describe('resolveBrowserPublicKey precedence (AC-2)', () => {
  it('prefers publicKey over both aliases', () => {
    expect(resolveBrowserPublicKey({ publicKey: 'pk', ingestPublicKey: 'ipk', apiKey: 'ak' })).toBe('pk');
  });

  it('prefers ingestPublicKey over apiKey when publicKey is absent', () => {
    expect(resolveBrowserPublicKey({ ingestPublicKey: 'ipk', apiKey: 'ak' })).toBe('ipk');
  });

  it('falls back to apiKey alone', () => {
    expect(resolveBrowserPublicKey({ apiKey: 'ak' })).toBe('ak');
  });

  it('returns undefined when no key is supplied, and treats blanks as absent', () => {
    expect(resolveBrowserPublicKey({})).toBeUndefined();
    expect(resolveBrowserPublicKey({ publicKey: '  ', apiKey: '' })).toBeUndefined();
  });
});

describe('publicKey is the browser bearer (AC-1)', () => {
  it('authenticates ingest with publicKey', async () => {
    const sdk = makeSdk({ publicKey: 'rtk_public_key' });
    await sdk.capture('feature_used', {}, { immediate: true });
    expect(bearerOf(trackCall())).toBe('Bearer rtk_public_key');
  });

  it('authenticates ingest with publicKey even when the deprecated aliases are also set', async () => {
    const sdk = makeSdk({ publicKey: 'rtk_public_key', ingestPublicKey: 'old_ingest', apiKey: 'old_api' });
    await sdk.capture('feature_used', {}, { immediate: true });
    expect(bearerOf(trackCall())).toBe('Bearer rtk_public_key');
  });

  it('uses the same publicKey on every control-plane fetch, not only ingest', async () => {
    const sdk = makeSdk({ publicKey: 'rtk_public_key', ingestPublicKey: 'old_ingest', apiKey: 'old_api' });
    await sdk.capture('feature_used', {}, { immediate: true });
    await sdk.getTrialStatus();
    await sdk.fetchUserContext('user_123').catch(() => undefined);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const bearers = calls
      .map((c) => bearerOf(c))
      .filter((b): b is string => typeof b === 'string');
    expect(bearers.length).toBeGreaterThan(0);
    expect(new Set(bearers)).toEqual(new Set(['Bearer rtk_public_key']));
  });
});

/** Make `isBrowser()` true for one test: the SDK checks for `window` + `document`. */
function stubBrowserGlobals(): void {
  vi.stubGlobal('window', { location: { hostname: 'app.example.com' }, addEventListener: () => undefined });
  vi.stubGlobal('document', { addEventListener: () => undefined });
}

describe('deprecated alias warning (AC-3)', () => {
  it('warns once, naming publicKey, when apiKey is used without publicKey in a browser dev build', () => {
    process.env.NODE_ENV = 'development';
    stubBrowserGlobals();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    makeSdk({ apiKey: 'legacy_key' });
    makeSdk({ apiKey: 'legacy_key' });
    const alias = warn.mock.calls.filter(([m]) => String(m).includes('publicKey'));
    expect(alias).toHaveLength(1);
    expect(String(alias[0]?.[0])).toContain('`apiKey` is deprecated');
  });

  it('does not warn for apiKey off the browser: on a backend it is the server key', () => {
    process.env.NODE_ENV = 'development';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    makeSdk({ apiKey: 'rtk_server_key' });
    expect(warn.mock.calls.some(([m]) => String(m).includes('deprecated'))).toBe(false);
  });

  it('names ingestPublicKey when that alias is the one used, in any runtime', () => {
    process.env.NODE_ENV = 'development';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    makeSdk({ ingestPublicKey: 'legacy_ingest' });
    const alias = warn.mock.calls.filter(([m]) => String(m).includes('publicKey'));
    expect(alias).toHaveLength(1);
    expect(String(alias[0]?.[0])).toContain('`ingestPublicKey` is deprecated');
  });

  it('never warns when publicKey is supplied, even alongside an alias', () => {
    process.env.NODE_ENV = 'development';
    stubBrowserGlobals();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    makeSdk({ publicKey: 'rtk_public_key', apiKey: 'legacy_key' });
    expect(warn.mock.calls.some(([m]) => String(m).includes('deprecated'))).toBe(false);
  });

  it('is silent in a production build', () => {
    process.env.NODE_ENV = 'production';
    stubBrowserGlobals();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    makeSdk({ apiKey: 'legacy_key' });
    expect(warn.mock.calls.some(([m]) => String(m).includes('deprecated'))).toBe(false);
  });
});

describe('local-only minimal init (AC-4)', () => {
  it('fills the publicKey placeholder without warning when no key is supplied', () => {
    process.env.NODE_ENV = 'development';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const playbook = {
      version: '1.0.0',
      exported_at: '2026-01-01T00:00:00Z',
      plans: [{ id: 'cfg_a', unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 }],
      entitlements: [],
      entitlement_rules: [],
      segments: [],
      content_ui_paths: [],
      surface_templates: [],
      placements: [],
    } as unknown as RevTurbineConfig;
    const sdk = initRevTurbine({
      localRuntime: { playbook },
      anonymousTelemetry: false,
    });
    expect(sdk).toBeInstanceOf(RevTurbineCustomerSdk);
    expect(warn.mock.calls.some(([m]) => String(m).includes('deprecated'))).toBe(false);
  });
});

describe('keyless anonymous beacon still keys off a real public key (REQ-6)', () => {
  it('does not send the keyless beacon when publicKey is set', async () => {
    const sdk = makeSdk({ publicKey: 'rtk_public_key', anonymousTelemetry: true });
    await sdk.capture('feature_used', {}, { immediate: true });
    expect(calls.some((c) => c.url.includes('/api/sdk/meta'))).toBe(false);
  });
});
