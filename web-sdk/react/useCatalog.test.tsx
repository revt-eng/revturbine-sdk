/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineContext } from './useRevTurbine';
import { useAddons } from './useAddons';
import { usePlans } from './usePlans';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('usePlans and useAddons', () => {
  it('load eligible catalogs and refresh after user context changes', async () => {
    const listeners = new Set<() => void>();
    const getEligiblePlans = vi.fn()
      .mockResolvedValueOnce([{ handle: 'free' }])
      .mockResolvedValueOnce([{ handle: 'pro' }]);
    const getEligibleAddons = vi.fn().mockResolvedValue([{ handle: 'support' }]);
    const sdk = {
      getEligiblePlans,
      getEligibleAddons,
      onUserContextChange: vi.fn((next: () => void) => {
        listeners.add(next);
        return () => { listeners.delete(next); };
      }),
    };
    const snapshots: Array<{ plans: string[]; addons: string[] }> = [];
    function Probe(): null {
      const { plans } = usePlans();
      const { addons } = useAddons();
      snapshots.push({
        plans: plans.map((plan) => plan.handle),
        addons: addons.map((addon) => addon.handle),
      });
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <RevTurbineContext.Provider value={{
          sdk: sdk as never,
          isReady: true,
          error: '',
          setContext: () => {},
        }}>
          <Probe />
        </RevTurbineContext.Provider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(snapshots.at(-1)).toEqual({ plans: ['free'], addons: ['support'] });

    await act(async () => {
      for (const listener of listeners) listener();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(snapshots.at(-1)).toEqual({ plans: ['pro'], addons: ['support'] });
  });
});
