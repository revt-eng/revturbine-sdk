/**
 * @vitest-environment jsdom
 *
 * Plan 144 TASK-9 — the React plumbing (REQ-15, REQ-18, AC-8, AC-10).
 *
 * `usePlacement` now forwards `autoTrackImpression` into the controller (before
 * this task the React surface had no way to express it) and exposes an
 * `exposureRef` wired to the viewport-exposure substrate. jsdom has no
 * `IntersectionObserver`, so the substrate degrades to `render_fallback` — which
 * is exactly the AC-10 path this exercises through the hook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineContext } from './useRevTurbine';
import { usePlacement, type UsePlacementOptions, type UsePlacementResult } from './usePlacement';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any;

function createMockSdk(over: Record<string, unknown> = {}): AnySdk {
  return {
    getUserContext: vi.fn().mockReturnValue({ user_id: 'user_1', tenant_id: 'tenant_1' }),
    registerSurfaceSlot: vi.fn().mockResolvedValue('pl_slot_1'),
    registerPlacement: vi.fn().mockResolvedValue('pl_placement_1'),
    getPlacementDecision: vi.fn().mockResolvedValue({
      visible: true,
      placementId: 'pl_slot_1',
      decisionSource: 'remote',
      content: { header: 'Upgrade now' },
      output: { surface: { slot_id: 'slot_1' }, output_id: 'pay_1' },
    }),
    trackTreatmentInteraction: vi.fn().mockResolvedValue(undefined),
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

/** Mount `usePlacement` in a provider and return a live handle to its result. */
async function mount(
  options: UsePlacementOptions,
  sdk: AnySdk,
): Promise<{ current: UsePlacementResult }> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const handle = { current: null as unknown as UsePlacementResult };

  function Probe(): null {
    handle.current = usePlacement(options);
    return null;
  }

  await act(async () => {
    root!.render(
      <RevTurbineContext.Provider value={{ sdk, isReady: true, error: '', setContext: () => {} }}>
        <Probe />
      </RevTurbineContext.Provider>,
    );
  });
  return handle;
}

/** Drain the controller's async load()/exposure chains and re-render. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('usePlacement — autoTrackImpression plumbing (AC-8)', () => {
  it('suppresses the resolution impression when autoTrackImpression is false', async () => {
    const sdk = createMockSdk();
    await mount({ surfaceSlot: { id: 'slot_1', name: 'slot_1' }, autoTrackImpression: false }, sdk);
    await settle();

    const impressions = sdk.trackTreatmentInteraction.mock.calls.filter(
      (c: unknown[]) => (c[0] as { interactionType?: string })?.interactionType === 'impression',
    );
    expect(impressions).toHaveLength(0);
  });

  it('tracks the resolution impression by default (option omitted)', async () => {
    const sdk = createMockSdk();
    await mount({ surfaceSlot: { id: 'slot_1', name: 'slot_1' } }, sdk);
    await settle();

    const impressions = sdk.trackTreatmentInteraction.mock.calls.filter(
      (c: unknown[]) => (c[0] as { interactionType?: string })?.interactionType === 'impression',
    );
    expect(impressions.length).toBeGreaterThan(0);
  });
});

describe('usePlacement — exposureRef substrate (REQ-18, AC-10)', () => {
  it('render_fallback flows through the hook when IntersectionObserver is absent', async () => {
    const sdk = createMockSdk();
    const handle = await mount({ surfaceSlot: { id: 'slot_1', name: 'slot_1' }, autoLoad: false }, sdk);
    expect(handle.current.exposureBasis).toBeNull();

    // Attach the exposure ref to a real element; jsdom lacks IntersectionObserver.
    const el = document.createElement('div');
    await act(async () => {
      handle.current.exposureRef(el);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();

    expect(handle.current.exposureBasis).toBe('render_fallback');
  });
});
