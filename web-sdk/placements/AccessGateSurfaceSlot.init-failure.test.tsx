/**
 * @vitest-environment jsdom
 *
 * ST-1447 (BUG-1194) — a terminal init failure settles every gate into the
 * denied path. Before the fix the provider never produced an SDK, `useEntitlement`
 * never ran a check, and `<Gate>` read "no result yet" as "unresolved" and
 * rendered nothing, so `deniedFallback` never appeared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AccessGateSurfaceSlot } from './AccessGateSurfaceSlot';
import { RevTurbineProvider } from '../react/RevTurbineProvider';
import type { RevTurbineInitInputOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
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

/** `sanitizeUiPathResolverMap` throws on an empty action_type key: a deliberate, terminal init error. */
const failingOptions = (): RevTurbineInitInputOptions => ({
  user: { id: 'u_test' },
  tenantId: 'tenant_init_failure',
  apiKey: 'sk_test',
  publicKey: 'pub_test',
  environmentId: 'staging',
  endpoint: 'https://edge.example.com',
  mode: 'snippet',
  runtimeMode: 'local_only',
  anonymousTelemetry: false,
  contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
  uiPathResolvers: { '   ': () => {} },
}) as unknown as RevTurbineInitInputOptions;

async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

describe('AccessGateSurfaceSlot when SDK initialization failed', () => {
  it('renders deniedFallback and the dev banner, not children or nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount(
      <RevTurbineProvider options={failingOptions()}>
        <AccessGateSurfaceSlot id="g1" can="brand_kit" deniedFallback={<p>upgrade-fallback</p>}>
          <p>paid-content</p>
        </AccessGateSurfaceSlot>
      </RevTurbineProvider>,
    );

    expect(container!.textContent).toContain('upgrade-fallback');
    expect(container!.textContent).not.toContain('paid-content');
    expect(container!.querySelector('[data-revturbine-init-failure="true"]')).not.toBeNull();
  });

  it('still renders nothing while init is pending (no fail-open, no premature fallback)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount(
      <AccessGateSurfaceSlot id="g1" can="brand_kit" deniedFallback={<p>upgrade-fallback</p>}>
        <p>paid-content</p>
      </AccessGateSurfaceSlot>,
    );

    expect(container!.textContent).not.toContain('paid-content');
  });
});
