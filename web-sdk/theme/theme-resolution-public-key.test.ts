/**
 * BL-0477 — theme resolution by public key, with the embedded defaults as the
 * floor.
 *
 * - The theme request's bearer is the public key; the server key (`apiKey`)
 *   and `x-tenant-id` are never sent.
 * - The persisted theme is scoped per key, so two keys on one origin do not
 *   share an entry, and no tenant id is needed.
 * - Without a public key nothing is fetched (no placeholder host or bearer).
 * - Headless init resolves the same ladder as the React provider: explicit
 *   `branding` wins, the theme API is opt-in (`fetchThemeOverride`), and with
 *   nothing supplied `getBranding()` reports the embedded default theme.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTheme } from './theme-loader';
import { DARK_THEME, DEFAULT_THEME } from './defaults';
import { InMemoryStorage } from '../storage';
import { initRevTurbine } from '../controllers';

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

function themeRequests(): Array<{ url: string; headers: Record<string, string> }> {
  return fetchMock.mock.calls
    .map(([url, init]) => ({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> }))
    .filter(({ url }) => url.includes('/api/sdk/theme'));
}

beforeEach(() => {
  fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/api/sdk/theme')) {
      return { ok: true, status: 200, json: async () => ({ version: 'v2', colors: { primary: '#ff0000' } }) } as unknown as Response;
    }
    return { ok: true, status: 202, json: async () => ({}), text: async () => '', headers: new Headers() } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BL-0477: theme-loader authenticates with the public key only', () => {
  it('sends the public key as the bearer and no x-tenant-id', async () => {
    await loadTheme({ publicKey: 'rtk_public_a', tenantId: 'tenant_1', endpoint: 'https://edge.example.com', storage: new InMemoryStorage() });
    await flush();
    const [request] = themeRequests();
    expect(request?.headers.authorization).toBe('Bearer rtk_public_a');
    expect(Object.keys(request?.headers ?? {})).not.toContain('x-tenant-id');
  });

  it('never sends a key passed as the deprecated apiKey: no request, one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const theme = await loadTheme({ apiKey: 'rtk_server_secret', endpoint: 'https://edge.example.com', storage: new InMemoryStorage() });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('rtk_server_secret');
    expect(theme.colors.primary).toBe(DEFAULT_THEME.colors.primary);
    expect(warn.mock.calls.some(([message]) => String(message).includes('ignores `apiKey`'))).toBe(true);
  });

  it('with both keys, the bearer is the public key and the apiKey value appears nowhere', async () => {
    await loadTheme({ publicKey: 'rtk_public_a', apiKey: 'rtk_server_secret', endpoint: 'https://edge.example.com', storage: new InMemoryStorage() });
    await flush();
    const requests = themeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.authorization).toBe('Bearer rtk_public_a');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('rtk_server_secret');
  });

  it('fetches nothing without a key', async () => {
    const theme = await loadTheme({ endpoint: 'https://edge.example.com', storage: new InMemoryStorage() });
    await flush();
    expect(themeRequests()).toHaveLength(0);
    expect(theme.colors.primary).toBe(DEFAULT_THEME.colors.primary);
  });

  it('scopes the persisted theme per key: key B does not read key A\'s cache', async () => {
    const storage = new InMemoryStorage();
    await loadTheme({ publicKey: 'rtk_public_a', endpoint: 'https://edge.example.com', storage });
    await flush();
    // Key A's fetched theme is now persisted; key B starts from the defaults.
    fetchMock.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);
    const forA = await loadTheme({ publicKey: 'rtk_public_a', endpoint: 'https://edge.example.com', storage });
    const forB = await loadTheme({ publicKey: 'rtk_public_b', endpoint: 'https://edge.example.com', storage });
    expect(forA.colors.primary).toBe('#ff0000');
    expect(forB.colors.primary).toBe(DEFAULT_THEME.colors.primary);
  });
});

describe('BL-0477: headless init resolves the branding ladder', () => {
  const hosted = { tenantId: 'tenant_1', endpoint: 'https://edge.example.com', contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false } };

  it('uses the dark embedded defaults in both headless rendering and branding', async () => {
    const session = await initRevTurbine({ ...hosted, publicKey: 'rtk_public_a', colorScheme: 'dark' });
    expect(session.theme).toEqual(DARK_THEME);
    expect(session.sdk.getBranding().branding.theme).toEqual(DARK_THEME);
    expect(themeRequests()).toHaveLength(0);
  });

  it('nothing supplied: no theme request, and getBranding() reports the embedded defaults', async () => {
    const session = await initRevTurbine({ ...hosted, publicKey: 'rtk_public_a' });
    await flush();
    expect(themeRequests()).toHaveLength(0);
    expect(session.theme.colors.primary).toBe(DEFAULT_THEME.colors.primary);
    const branding = session.sdk.getBranding();
    expect(branding.source).toBe('default');
    expect(branding.branding.theme).toMatchObject({ colors: { primary: DEFAULT_THEME.colors.primary } });
  });

  it('the explicit branding option is honoured (it was ignored on the headless path)', async () => {
    const session = await initRevTurbine({
      ...hosted,
      publicKey: 'rtk_public_a',
      branding: { theme: { colors: { primary: '#00ff00' } } },
    });
    expect(session.theme.colors.primary).toBe('#00ff00');
  });

  it('fetchThemeOverride fetches with the public key and never the server key', async () => {
    await initRevTurbine({ ...hosted, publicKey: 'rtk_public_a', apiKey: 'rtk_server_secret', fetchThemeOverride: true });
    await flush();
    const requests = themeRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.authorization).toBe('Bearer rtk_public_a');
    expect(JSON.stringify(requests)).not.toContain('rtk_server_secret');
  });

  it('local mode makes no request to a placeholder host', async () => {
    await initRevTurbine({
      tenantId: 'local',
      runtimeMode: 'local_only',
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      localRuntime: {
        playbook: {
          version: '1.0.0', plans: [], entitlements: [], entitlement_rules: [], segments: [], content_ui_paths: [], placements: [],
        } as never,
      },
    });
    await flush();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('revturbine.local'))).toBe(false);
    expect(themeRequests()).toHaveLength(0);
  });
});
