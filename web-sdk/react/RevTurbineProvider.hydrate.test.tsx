/**
 * @vitest-environment jsdom
 *
 * Plan 186 TASK-2 (REQ-8, AC-8) — `serverPayload` hydrates the provider.
 *
 * `sdk.hydrate()` existed with no caller: the provider exposed no prop to feed
 * it, so a server-rendered app evaluated once on the server and then threw the
 * result away and re-evaluated from scratch on the client. These tests pin the
 * wiring — that a payload is applied when the SDK is created, applied exactly
 * once, re-applied when a navigation supplies a fresh one, and that a bad
 * payload degrades to client-side evaluation instead of breaking init.
 *
 * Plan: docs/dev-lifecycle/inprogress/186-server-rendering-sdk-and-api-token-management.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from './RevTurbineProvider';
import { useRevTurbine } from './useRevTurbine';
import {
  RevTurbineCustomerSdk,
  type RevTurbineCustomerSdk as SdkType,
  type RevTurbineInitOptions,
  type ServerEvaluationHydrationPayload,
} from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  );
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OPTIONS: RevTurbineInitOptions = {
  tenantId: 'tenant_hydrate',
  apiKey: 'sk_test',
  ingestPublicKey: 'pub_test',
  environmentId: 'staging',
  endpoint: 'https://edge.example.com',
  mode: 'snippet',
  runtimeMode: 'local_only',
  contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
};

function payloadWith(handle: string, allowed: boolean): ServerEvaluationHydrationPayload {
  return {
    version: '1.0.0',
    request_id: `req_${handle}`,
    tenant_id: 'tenant_hydrate',
    evaluated_at: new Date(0).toISOString(),
    ttl_seconds: 60,
    user: { id: 'user_123', anonymous_id: 'anon_1', traits: { plan: 'pro' } },
    decisions: [],
    entitlements: {
      [handle]: {
        status: allowed ? 'allowed' : 'denied',
        allowed,
        reason: 'server_evaluated',
      },
    },
  };
}

const handle: { sdk: SdkType | null; isReady: boolean; error: string } = {
  sdk: null,
  isReady: false,
  error: '',
};

function Probe(): null {
  const ctx = useRevTurbine();
  handle.sdk = ctx.sdk;
  handle.isReady = ctx.isReady;
  handle.error = ctx.error;
  return null;
}

async function mount(serverPayload?: ServerEvaluationHydrationPayload): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={OPTIONS} serverPayload={serverPayload}>
        <Probe />
      </RevTurbineProvider>,
    );
  });
}

async function rerender(serverPayload?: ServerEvaluationHydrationPayload): Promise<void> {
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={OPTIONS} serverPayload={serverPayload}>
        <Probe />
      </RevTurbineProvider>,
    );
  });
}

describe('RevTurbineProvider serverPayload hydration (AC-8)', () => {
  it('applies server-evaluated entitlements without a network round trip', async () => {
    await mount(payloadWith('brand_kit', true));

    expect(handle.isReady).toBe(true);
    expect(handle.sdk?.getEntitlements()).toMatchObject({
      brand_kit: { allowed: true, reason: 'server_evaluated' },
    });

    const entitlementCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('entitlement'),
    );
    expect(entitlementCalls).toEqual([]);
  });

  it('hydrates exactly once when mounted with a payload', async () => {
    const hydrateSpy = vi.spyOn(RevTurbineCustomerSdk.prototype, 'hydrate');
    await mount(payloadWith('brand_kit', true));

    expect(hydrateSpy).toHaveBeenCalledTimes(1);
  });

  it('re-hydrates when a later payload arrives, without remounting', async () => {
    const hydrateSpy = vi.spyOn(RevTurbineCustomerSdk.prototype, 'hydrate');
    await mount(payloadWith('brand_kit', true));
    const initialSdk = handle.sdk;

    await rerender(payloadWith('mp4_download', false));

    expect(hydrateSpy).toHaveBeenCalledTimes(2);
    expect(handle.sdk).toBe(initialSdk);
    expect(handle.sdk?.getEntitlements()).toMatchObject({
      brand_kit: { allowed: true },
      mp4_download: { allowed: false },
    });
  });

  it('does not re-hydrate when the same payload identity re-renders', async () => {
    const hydrateSpy = vi.spyOn(RevTurbineCustomerSdk.prototype, 'hydrate');
    const stable = payloadWith('brand_kit', true);
    await mount(stable);

    await rerender(stable);

    expect(hydrateSpy).toHaveBeenCalledTimes(1);
  });

  it('mounts normally when no payload is supplied', async () => {
    const hydrateSpy = vi.spyOn(RevTurbineCustomerSdk.prototype, 'hydrate');
    await mount(undefined);

    expect(hydrateSpy).not.toHaveBeenCalled();
    expect(handle.isReady).toBe(true);
    expect(handle.error).toBe('');
  });

  it('degrades to client-side evaluation when hydration throws, leaving the provider ready', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(RevTurbineCustomerSdk.prototype, 'hydrate').mockImplementation(() => {
      throw new Error('malformed payload');
    });

    await mount(payloadWith('brand_kit', true));

    expect(handle.isReady).toBe(true);
    expect(handle.error).toBe('');
    expect(consoleError).toHaveBeenCalledWith(
      '[RevTurbine] serverPayload hydration failed:',
      expect.any(Error),
    );
  });

  it('skips an unknown payload version rather than throwing', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `version` is the literal type '1.0.0', so a stale payload is
    // unrepresentable in TypeScript and can only reach the SDK as deserialized
    // wire data. Round-tripping through JSON models that boundary exactly —
    // which is the only path the runtime version guard can ever be hit from.
    const stale: ServerEvaluationHydrationPayload = JSON.parse(
      JSON.stringify({ ...payloadWith('brand_kit', true), version: '0.9.0' }),
    ); // sdk-ok: boundary-parse

    await mount(stale);

    expect(handle.isReady).toBe(true);
    expect(handle.sdk?.getEntitlements()).toEqual({});
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('Unknown hydration payload version'),
    );
  });
});
