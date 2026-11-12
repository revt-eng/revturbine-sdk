/**
 * @vitest-environment jsdom
 *
 * ST-1696 (SDK 0.16.0) — a `<Gate>` under an SDK that has no identified user
 * yet (its `user` promise is still pending) is fail-closed AND silent: it
 * withholds its children and renders nothing, including when `deniedFallback`
 * is supplied (Kent decision D-3: showing the upsell would flash it at an
 * entitled user during the sign-in race). It places no gate placement and never
 * calls `onDenied`. When the promise resolves, or `identify()` is called, the
 * mounted gate re-evaluates without a remount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AccessGateSurfaceSlot } from './AccessGateSurfaceSlot';
import { RevTurbineProvider } from '../react/RevTurbineProvider';
import { useRevTurbine } from '../react/useRevTurbine';
import type { RevTurbineCustomerSdk, RevTurbineInitInputOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let sdkRef: RevTurbineCustomerSdk | null = null;

const PLAYBOOK = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  playbook_handle: 'default',
  playbook_version_id: null,
  tenant_id: 't_1',
  environment_id: 'production',
  plans: [
    { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
    { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 1 },
  ],
  entitlements: [{ unique_handle: 'export', name: 'Export', type: 'feature' }],
  entitlement_rules: [
    { id: 'r1', entitlement_id: 'export', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], kind: 'feature', enabled: true },
  ],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [],
};

interface Deferred { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason: unknown) => void }
function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const options = (user: unknown): RevTurbineInitInputOptions => ({
  user,
  tenantId: 't_1',
  runtimeMode: 'local_only',
  anonymousTelemetry: false,
  contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
  localRuntime: { playbook: PLAYBOOK },
}) as unknown as RevTurbineInitInputOptions;

function SdkProbe(): null {
  sdkRef = useRevTurbine().sdk;
  return null;
}

function tree(opts: RevTurbineInitInputOptions, onDenied: () => void): React.ReactElement {
  return (
    <RevTurbineProvider options={opts as never}>
      <SdkProbe />
      <AccessGateSurfaceSlot id="g1" can="export" deniedFallback={<p>upgrade-fallback</p>} onDenied={onDenied}>
        <p>paid-content</p>
      </AccessGateSurfaceSlot>
    </RevTurbineProvider>
  );
}

async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 5); }); });
  }
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
const fetchMock = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sdkRef = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' }));
  vi.stubGlobal('fetch', fetchMock);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

describe('AccessGateSurfaceSlot while the user promise is pending', () => {
  it('renders nothing (not children, not deniedFallback), never calls onDenied, and logs nothing', async () => {
    const onDenied = vi.fn();
    await mount(tree(options(deferred().promise), onDenied));
    await settle();

    expect(sdkRef).not.toBeNull();
    expect(container!.textContent).toBe('');
    expect(onDenied).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(sdkRef!.getUserRequiredDiagnostic()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-evaluates on resolve without a remount: an entitled user gets the children', async () => {
    const user = deferred();
    const onDenied = vi.fn();
    await mount(tree(options(user.promise), onDenied));
    await settle();
    expect(container!.textContent).toBe('');
    const instance = sdkRef;

    await act(async () => { user.resolve({ id: 'u_pro', plan_handle: 'pro' }); });
    await settle();
    expect(container!.textContent).toContain('paid-content');
    expect(container!.textContent).not.toContain('upgrade-fallback');
    // Same SDK instance: the provider was not re-initialised.
    expect(sdkRef).toBe(instance);
    expect(onDenied).not.toHaveBeenCalled();
  });

  it('re-evaluates on resolve: a denied user gets the fallback and onDenied fires', async () => {
    const user = deferred();
    const onDenied = vi.fn();
    await mount(tree(options(user.promise), onDenied));
    await settle();
    expect(container!.textContent).toBe('');

    await act(async () => { user.resolve({ id: 'u_free', plan_handle: 'free' }); });
    await settle();
    expect(container!.textContent).toContain('upgrade-fallback');
    expect(container!.textContent).not.toContain('paid-content');
    expect(onDenied).toHaveBeenCalled();
  });

  it('re-evaluates on an explicit identify() while pending, and the later promise result does not overwrite it', async () => {
    const user = deferred();
    await mount(tree(options(user.promise), vi.fn()));
    await settle();

    await act(async () => { sdkRef!.identify('u_pro', { plan_handle: 'pro' }); });
    await settle();
    expect(container!.textContent).toContain('paid-content');

    await act(async () => { user.resolve({ id: 'u_free', plan_handle: 'free' }); });
    await settle();
    expect(container!.textContent).toContain('paid-content');
    expect(sdkRef!.getUserContext().user_id).toBe('u_pro');
  });

  it('a promise that rejects is the loud error; the gate leaves the pending state and behaves as in 0.15.0 (fallback, onDenied)', async () => {
    const user = deferred();
    const onDenied = vi.fn();
    await mount(tree(options(user.promise), onDenied));
    await settle();
    expect(container!.textContent).toBe('');
    expect(sdkRef!.isUserPending()).toBe(true);

    await act(async () => { user.reject(new Error('session lookup failed')); });
    await settle();
    expect(sdkRef!.isUserPending()).toBe(false);
    expect(container!.textContent).toContain('upgrade-fallback');
    expect(container!.textContent).not.toContain('paid-content');
    expect(onDenied).toHaveBeenCalled();
    const loud = errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('user_id_required'));
    expect(loud).toHaveLength(1);
    expect(loud[0]).toContain('session lookup failed');
  });

  it('a promise that resolves blank leaves the pending state the same way', async () => {
    const user = deferred();
    const onDenied = vi.fn();
    await mount(tree(options(user.promise), onDenied));
    await settle();
    await act(async () => { user.resolve({ id: '  ' }); });
    await settle();
    expect(container!.textContent).toContain('upgrade-fallback');
    expect(onDenied).toHaveBeenCalled();
  });
});

describe('AccessGateSurfaceSlot with a missing user (the loud error state, as in 0.15.0)', () => {
  it.each([['null', null], ['a blank id', { id: '' }], ['an omitted user', undefined]])(
    'with %s the gate shows deniedFallback and calls onDenied',
    async (_label, user) => {
      const onDenied = vi.fn();
      await mount(tree(options(user), onDenied));
      await settle();
      expect(sdkRef!.isUserPending()).toBe(false);
      expect(container!.textContent).toContain('upgrade-fallback');
      expect(container!.textContent).not.toContain('paid-content');
      expect(onDenied).toHaveBeenCalled();
    },
  );

  it('unmounting while pending applies nothing: a later resolve neither logs nor identifies', async () => {
    const user = deferred();
    await mount(tree(options(user.promise), vi.fn()));
    await settle();
    const sdk = sdkRef!;

    await act(async () => root!.unmount());
    root = null;
    user.resolve({ id: 'late', plan_handle: 'pro' });
    await new Promise((resolve) => { setTimeout(resolve, 10); });

    expect(sdk.getUserContext().user_id).toBe('');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
