/**
 * @vitest-environment jsdom
 *
 * BL-0251 (same defect class as `<Gate>`) — `usePlacement` rebuilds its
 * `PlacementController` when `sdk` or the serialized slot config changes, but
 * the auto-load effect keyed on `loadDecision`, whose own dependency list was
 * `[isReady, resolvedUserId]`. Neither moves when the host publishes a new SDK
 * instance (`RevTurbineProvider` does that whenever its `options` prop changes
 * identity, with `isReady` still true), so the replacement controller was
 * rebuilt and never loaded: the slot stayed on its initial empty state for the
 * rest of the mount.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineContext } from './useRevTurbine';
import { usePlacement, type UsePlacementOptions, type UsePlacementResult } from './usePlacement';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any;

function createMockSdk(): AnySdk {
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
const OPTIONS: UsePlacementOptions = { surfaceSlot: { id: 'slot_1', name: 'Slot 1' } };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

const handle = { current: null as unknown as UsePlacementResult };

function Probe(): null {
  handle.current = usePlacement(OPTIONS);
  return null;
}

async function render(sdk: AnySdk): Promise<void> {
  await act(async () => {
    root!.render(
      <RevTurbineContext.Provider value={{ sdk, isReady: true, error: '', setContext: () => {} }}>
        <Probe />
      </RevTurbineContext.Provider>,
    );
  });
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('usePlacement across an SDK instance change (BL-0251)', () => {
  it('loads a decision against the replacement SDK', async () => {
    const first = createMockSdk();
    await render(first);
    expect(handle.current.visible, 'slot not visible before the SDK changed').toBe(true);

    const second = createMockSdk();
    await render(second);

    expect(
      second.getPlacementDecision,
      'the rebuilt controller was never loaded against the new SDK instance',
    ).toHaveBeenCalled();
    expect(handle.current.visible, 'slot parked empty after the SDK instance changed').toBe(true);
  });
});
