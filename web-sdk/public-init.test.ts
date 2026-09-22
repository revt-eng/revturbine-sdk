import { afterEach, describe, expect, it, vi } from 'vitest';
import { initRevTurbine as initRoot, SdkSession } from './index';
import { initRevTurbine as initHeadless } from './headless';
import { initRevTurbine as initCore, RevTurbineCustomerSdk } from './customer-side';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('public initializer user context (plan 254 AC-5)', () => {
  it.each([
    ['root', initRoot],
    ['headless', initHeadless],
  ])('%s returns an awaited session and identifies without forwarding the id twice', async (_entry, init) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const session = await init({
      tenantId: 'public_init',
      apiKey: 'local-only',
      endpoint: 'https://sdk.example.test',
      mode: 'snippet',
      runtimeMode: 'local_only',
      previewMode: true,
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      user: { id: 'user_123', plan_handle: 'pro', custom: { region: 'eu' } },
    });
    try {
      expect(session).toBeInstanceOf(SdkSession);
      expect(session.sdk.getUserContext()).toMatchObject({
        id: 'user_123', custom: { region: 'eu' },
      });
      expect(session.sdk.getTargeting().plan).toBe('pro');
      expect(session.sdk.getBranding().branding.theme).toBeDefined();
      expect(warn.mock.calls.filter(([message]) => String(message).includes('unrecognized user-context key'))).toEqual([]);
    } finally {
      session.sdk.dispose();
    }
  });

  it('defaults endpoint and mode for a hosted init that omits them', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const session = await initHeadless({
      tenantId: 'public_init',
      apiKey: 'rtk_test',
      previewMode: true,
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      user: { id: 'user_123' },
    });
    try {
      // `mode` labels telemetry only; the core default is `'snippet'`.
      expect((session.sdk as unknown as { mode: string }).mode).toBe('snippet');
      // Hosted mode with no `endpoint` talks to the control plane at the default.
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((url) => url.startsWith('https://revturbine.com/app'))).toBe(true);
    } finally {
      session.sdk.dispose();
    }
  });

  it('preserves the separate synchronous core initializer', () => {
    const sdk = initCore({
      tenantId: 'core_init', apiKey: 'local-only', endpoint: 'https://sdk.example.test',
      mode: 'snippet', runtimeMode: 'local_only', previewMode: true,
    });
    try {
      expect(sdk).toBeInstanceOf(RevTurbineCustomerSdk);
      expect(sdk).not.toBeInstanceOf(Promise);
    } finally {
      sdk.dispose();
    }
  });
});
