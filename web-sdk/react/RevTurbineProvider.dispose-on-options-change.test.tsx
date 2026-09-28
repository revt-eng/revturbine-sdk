/**
 * @vitest-environment jsdom
 *
 * BL-0375 — `RevTurbineProvider`'s init effect (deps `[options,
 * stableBootstrap]`) creates a new SDK instance whenever `options` changes
 * identity, but its cleanup previously only flipped a `mounted` flag — it
 * never disposed the instance it was replacing. A host that rebuilds
 * `options` on every render (the shape web's dogfood provider had until web
 * #944 / BL-0358) therefore re-initialized on every render and leaked every
 * earlier instance's flush timer, page-unload listeners, and buffered
 * telemetry.
 *
 * These tests pin: (1) a re-render with a *new but content-equal* options
 * object disposes the previous instance, leaves exactly one live
 * (non-disposed) instance, bootstraps the replacement exactly once, and logs
 * a one-time dev warning pointing at memoization; (2) a re-render with an
 * actually-changed option (tenant) still creates a new instance and disposes
 * the old one — the documented re-init contract is unchanged, only the leak
 * is fixed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from './RevTurbineProvider';
import { useRevTurbine } from './useRevTurbine';
import { RevTurbineCustomerSdk, type RevTurbineInitOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let sdkSeen: RevTurbineCustomerSdk | null = null;

function Probe() {
  const { sdk } = useRevTurbine();
  sdkSeen = sdk;
  return <div>probe</div>;
}

const PLAYBOOK_BASE = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  playbook_handle: 'default',
  playbook_version_id: null,
  environment_id: 'production',
  plans: [],
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
};

// Stable identity across renders — only `options` should vary in these
// tests; a bootstrap array that also changed identity every render would
// confound the "bootstraps once per instance" assertion below.
const BOOTSTRAP_PLACEMENTS = [{ placement: { name: 'bl_0375_test_placement' }, userId: 'user_1' }];

function makeOptions(tenantId: string): RevTurbineInitOptions {
  return {
    tenantId,
    runtimeMode: 'local_only',
    localRuntime: { playbook: { ...PLAYBOOK_BASE, tenant_id: tenantId } },
  } as unknown as RevTurbineInitOptions;
}

// Bootstrapping a placement (registerPlacement → bootstrapPlacementDecisions
// → getPlacementDecision) resolves over more microtask turns than a single
// `act(async () => { render() })` flushes, matching the pattern
// `usePlacement.sdk-rebuild.test.tsx` uses for the same reason.
async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(options: RevTurbineInitOptions): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={options} bootstrapPlacements={BOOTSTRAP_PLACEMENTS}>
        <Probe />
      </RevTurbineProvider>,
    );
  });
  await flushAsyncWork();
}

async function rerender(options: RevTurbineInitOptions): Promise<void> {
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={options} bootstrapPlacements={BOOTSTRAP_PLACEMENTS}>
        <Probe />
      </RevTurbineProvider>,
    );
  });
  await flushAsyncWork();
}

function equivalentContentWarnings(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls = (console.warn as any).mock.calls as unknown[][];
  return calls
    .map((args) => args[0])
    .filter((msg): msg is string => typeof msg === 'string' && msg.includes('structurally equivalent content'));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  sdkSeen = null;
  vi.restoreAllMocks();
});

describe('RevTurbineProvider disposes the previous SDK instance on an options identity change (BL-0375)', () => {
  it('disposes the previous instance, keeps one live instance, bootstraps once, and warns once for a content-equal rebuild', async () => {
    const registerSpy = vi.spyOn(RevTurbineCustomerSdk.prototype, 'registerPlacement');
    const disposeSpy = vi.spyOn(RevTurbineCustomerSdk.prototype, 'dispose');

    const first = makeOptions('t_1');
    await mount(first);
    const sdkA = sdkSeen;
    expect(sdkA).not.toBeNull();
    expect(disposeSpy).not.toHaveBeenCalled();

    // A brand-new object, but every key holds the same value — exactly the
    // shape an unmemoized `options={{ ... }}` literal produces on re-render.
    const second = { ...first };
    expect(second).not.toBe(first);
    await rerender(second);
    const sdkB = sdkSeen;

    // Re-init semantics are unchanged: a new object identity still creates a
    // new instance. What's fixed is that the OLD one is no longer leaked.
    expect(sdkB).not.toBeNull();
    expect(sdkB).not.toBe(sdkA);

    // Exactly one dispose call, and it targeted the replaced instance —
    // never the surviving one: one live instance.
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy.mock.instances[0]).toBe(sdkA);
    expect(disposeSpy.mock.instances).not.toContain(sdkB);

    // Bootstrapping (registerPlacement) ran exactly once for EACH instance —
    // the fix does not cause the replacement to double-bootstrap, and
    // disposing the old one does not re-trigger its bootstrap either.
    const registerCallsForA = registerSpy.mock.instances.filter((instance) => instance === sdkA).length;
    const registerCallsForB = registerSpy.mock.instances.filter((instance) => instance === sdkB).length;
    expect(registerCallsForA).toBe(1);
    expect(registerCallsForB).toBe(1);

    // Dev-mode warning: the one-time structurally-equivalent warning fires
    // exactly once.
    expect(equivalentContentWarnings()).toHaveLength(1);

    // A further content-equal rebuild does not warn again — one-time-ever.
    const third = { ...first };
    await rerender(third);
    expect(equivalentContentWarnings()).toHaveLength(1);
  });

  it('disposes the previous instance and creates a fresh one when a real option (tenant) changes', async () => {
    const disposeSpy = vi.spyOn(RevTurbineCustomerSdk.prototype, 'dispose');

    await mount(makeOptions('t_1'));
    const sdkA = sdkSeen;
    expect(sdkA).not.toBeNull();

    await rerender(makeOptions('t_2'));
    const sdkB = sdkSeen;

    expect(sdkB).not.toBeNull();
    expect(sdkB).not.toBe(sdkA);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(disposeSpy.mock.instances[0]).toBe(sdkA);

    // The content-equal warning must NOT fire here — the options genuinely
    // differ (different tenant), so re-initializing is the correct, expected
    // behavior, not a mistake to warn about.
    expect(equivalentContentWarnings()).toHaveLength(0);
  });

  it('does not dispose the current instance while it remains mounted', async () => {
    const disposeSpy = vi.spyOn(RevTurbineCustomerSdk.prototype, 'dispose');
    await mount(makeOptions('t_1'));
    expect(sdkSeen).not.toBeNull();
    expect(disposeSpy).not.toHaveBeenCalled();
  });
});
