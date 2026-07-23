/**
 * @vitest-environment jsdom
 *
 * Plan 144 TASK-8 — REQ-13: `anonymousTelemetry` is separately controlled and
 * unaffected by `telemetry.consent`. The keyless anonymous SDK-init beacon
 * (`/api/sdk/meta`) carries config-shape counts and no user context, so denying
 * behavior-telemetry consent must NOT silence it — only its own
 * `anonymousTelemetry: false` switch does.
 *
 * jsdom is required: the beacon only fires in a browser (`isBrowser()`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import type { RevTurbineConfig } from '@revt-eng/schema';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];

function okResponse(): Response {
  return {
    ok: true,
    status: 202,
    json: async () => ({ accepted: 1 }),
    text: async () => '',
  } as unknown as Response;
}

function makeConfig(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [{ id: 'plan_free', unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 }],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(okResponse());
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function makeKeylessSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_abc',
    apiKey: 'sk_secret_key',
    ingestPublicKey: undefined, // keyless → the anonymous /api/sdk/meta beacon path
    environmentId: 'prod',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { exportedConfig: makeConfig() },
    ...over,
  });
}

const metaCalls = (): FetchCall[] => calls.filter((c) => c.url.endsWith('/api/sdk/meta'));
const trackCalls = (): FetchCall[] => calls.filter((c) => c.url.endsWith('/api/track'));

describe('anonymousTelemetry is independent of telemetry.consent (REQ-13)', () => {
  it('still fires the keyless sdk_init beacon when behavior consent is denied', async () => {
    makeKeylessSdk({ telemetry: { consent: 'denied' } });

    // The anonymous adoption beacon is ungated by consent…
    await vi.waitFor(() => expect(metaCalls().length).toBe(1));
    const body = JSON.parse(String(metaCalls()[0].init.body)) as {
      events: Array<{ event_type: string }>;
    };
    expect(body.events[0].event_type).toBe('sdk_init');
  });

  it('still honors its own anonymousTelemetry:false switch regardless of consent', async () => {
    makeKeylessSdk({ telemetry: { consent: 'granted' }, anonymousTelemetry: false });

    // Give the init beacon a chance to (not) fire.
    await Promise.resolve();
    await Promise.resolve();
    expect(metaCalls()).toHaveLength(0);
  });

  it('never posts the authed clickstream from a keyless install', async () => {
    makeKeylessSdk({ telemetry: { consent: 'denied' } });
    await vi.waitFor(() => expect(metaCalls().length).toBe(1));
    // Keyless routes to /api/sdk/meta only — never /api/track.
    expect(trackCalls()).toHaveLength(0);
  });
});
