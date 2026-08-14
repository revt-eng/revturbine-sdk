/**
 * @vitest-environment jsdom
 *
 * Plan 184 TASK-3 — theme resolution reads the Playbook; `/api/sdk/theme` is an
 * opt-in OVERRIDE.
 *
 * The defect: the provider fell back to an unconditional `GET /api/sdk/theme`
 * whenever the Playbook carried no theme — which in Server mode (no
 * `localRuntime`) is always — against an endpoint no control plane implemented.
 * Every Server-mode consumer logged a 404 on init.
 *
 * Plan: docs/dev-lifecycle/inprogress/184-dogfood-ingest-auth-and-sdk-contract-defects.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from './RevTurbineProvider';
import type { RevTurbineCustomerSdk, RevTurbineInitOptions } from '../customer-side';
import { useRevTurbine } from './useRevTurbine';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

/** URLs the SDK requested during a mount. */
function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

/** Requests to the theme endpoint specifically. */
function themeRequests(): string[] {
  return requestedUrls().filter((url) => url.includes('/api/sdk/theme'));
}

beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn(async (input: unknown) => {
    if (String(input).includes('/api/sdk/theme')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ primary: '#override' }),
        text: async () => '',
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 202,
      json: async () => ({}),
      text: async () => '',
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
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

async function mount(options: RevTurbineInitOptions): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={options}>
        <div />
      </RevTurbineProvider>,
    );
  });
}

const BASE: RevTurbineInitOptions = {
  tenantId: 'tenant_theme',
  apiKey: 'sk_test',
  ingestPublicKey: 'pub_test',
  environmentId: 'production',
  endpoint: 'https://edge.example.com',
  mode: 'snippet',
  runtimeMode: 'local_only',
  contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
};

describe('theme override is opt-in', () => {
  it('requests no theme at all by default', async () => {
    await mount(BASE);
    // The reported production symptom: a guaranteed 404 on every init.
    expect(themeRequests()).toEqual([]);
  });

  it('still requests no theme when the Playbook carries none (the Server-mode path)', async () => {
    // No `localRuntime` at all — previously the branch that always fetched.
    await mount({ ...BASE, localRuntime: undefined });
    expect(themeRequests()).toEqual([]);
  });

  it('requests the override endpoint when fetchThemeOverride is enabled', async () => {
    await mount({ ...BASE, fetchThemeOverride: true });
    expect(themeRequests()).toHaveLength(1);
    expect(themeRequests()[0]).toBe('https://edge.example.com/api/sdk/theme');
  });
});

describe('the fetched override reaches getBranding()', () => {
  /**
   * Without this wiring the override reached only the React theme context, so
   * `getBranding()` and `useRevTurbineTheme()` could report different branding
   * for the same tenant — a spec/code divergence introduced when the branding
   * API became an override (plan 184).
   */
  it('resolves branding from the branding-API rung once the override lands', async () => {
    let sdk: RevTurbineCustomerSdk | null = null;
    function Grab(): null {
      sdk = useRevTurbine().sdk;
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RevTurbineProvider options={{ ...BASE, fetchThemeOverride: true }}>
          <Grab />
        </RevTurbineProvider>,
      );
    });

    expect(sdk).not.toBeNull();
    const resolved = sdk!.getBranding();
    expect(resolved.source).toBe('branding-api');
    expect(resolved.branding.theme).toMatchObject({ primary: '#override' });
  });

  it('leaves branding on a lower rung when no override was fetched', async () => {
    let sdk: RevTurbineCustomerSdk | null = null;
    function Grab(): null {
      sdk = useRevTurbine().sdk;
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RevTurbineProvider options={BASE}>
          <Grab />
        </RevTurbineProvider>,
      );
    });

    // No fetch, so nothing may claim the branding-API rung.
    expect(sdk!.getBranding().source).not.toBe('branding-api');
  });
});
