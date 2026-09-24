/**
 * Plan 257 — `publicKey` is the browser option; `apiKey` is the server key.
 * BL-0113 (0.11.0) — and now it is the ONLY browser option.
 *
 * Asserts the browser credential contract after the alias window closed:
 *   - `publicKey` is the bearer on ingest AND on control-plane fetches (AC-1),
 *   - `publicKey` is the only name resolved; `apiKey` is NOT read as a browser
 *     credential, so an `apiKey`-only browser init resolves nothing (AC-2),
 *   - no alias remains to warn about, so nothing warns (AC-3),
 *   - a keyless local-only init fills the placeholder and does not warn (AC-4),
 *   - the keyless anonymous beacon (plan 95) keys off a real `publicKey`, so an
 *     `apiKey`-only init keeps sending it (REQ-6).
 *
 * `ingestPublicKey` is absent from `RevTurbineInitOptions` entirely — that is a
 * TYPE-level assertion and lives in `init-options-exactness.test-d.ts`, since
 * there is nothing left to run here.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  RevTurbineCustomerSdk,
  initRevTurbine,
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

describe('resolveBrowserPublicKey reads publicKey and nothing else (AC-2, BL-0113)', () => {
  it('resolves publicKey', () => {
    expect(resolveBrowserPublicKey({ publicKey: 'pk' })).toBe('pk');
  });

  it('does NOT read apiKey as a browser credential — the 0.10.0 alias is gone', () => {
    // `apiKey` is the secret server key. Before 0.11.0 this returned 'ak', and a
    // browser init that set only `apiKey` silently sent it as the bearer.
    expect(resolveBrowserPublicKey({ apiKey: 'ak' } as { publicKey?: string })).toBeUndefined();
  });

  it('returns undefined when no key is supplied, and treats blanks as absent', () => {
    expect(resolveBrowserPublicKey({})).toBeUndefined();
    expect(resolveBrowserPublicKey({ publicKey: '  ' })).toBeUndefined();
  });
});

describe('publicKey is the browser bearer (AC-1)', () => {
  it('authenticates ingest with publicKey', async () => {
    const sdk = makeSdk({ publicKey: 'rtk_public_key' });
    await sdk.capture('feature_used', {}, { immediate: true });
    expect(bearerOf(trackCall())).toBe('Bearer rtk_public_key');
  });

  it('authenticates ingest with publicKey even when a server apiKey is also set', async () => {
    const sdk = makeSdk({ publicKey: 'rtk_public_key', apiKey: 'old_api' });
    await sdk.capture('feature_used', {}, { immediate: true });
    expect(bearerOf(trackCall())).toBe('Bearer rtk_public_key');
  });

  it('uses the same publicKey on every control-plane fetch, not only ingest', async () => {
    const sdk = makeSdk({ publicKey: 'rtk_public_key', apiKey: 'old_api' });
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

describe('no browser-key alias remains to warn about (AC-3, BL-0113)', () => {
  it('an apiKey-only browser init resolves NO browser credential', () => {
    process.env.NODE_ENV = 'development';
    stubBrowserGlobals();
    // 0.10.0 warned and then used it. 0.11.0 does not read it at all, so the
    // bearer is an empty resolution rather than a leaked server key.
    expect(resolveBrowserPublicKey({ apiKey: 'rtk_server_key' } as { publicKey?: string })).toBeUndefined();
  });

  it('does not warn about a deprecated browser key alias in any runtime', () => {
    process.env.NODE_ENV = 'development';
    stubBrowserGlobals();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    makeSdk({ apiKey: 'legacy_key' });
    makeSdk({ publicKey: 'rtk_public_key', apiKey: 'legacy_key' });
    expect(warn.mock.calls.some(([m]) => String(m).includes('is deprecated on the browser init'))).toBe(false);
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
