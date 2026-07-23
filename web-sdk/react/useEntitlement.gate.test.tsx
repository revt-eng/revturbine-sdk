/**
 * @vitest-environment jsdom
 *
 * Plan 144 TASK-10 / AC-11 — mounting a passive gate emits `gate_evaluated` and
 * never `gate_attempted`. `<Gate>` (AccessGateSurfaceSlot) and `useEntitlement`
 * both evaluate through `EntitlementGate.check()`, which auto-runs on mount, so
 * this exercises the passive-mount path via the hook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineContext } from './useRevTurbine';
import { useEntitlement, type UseEntitlementOptions } from './useEntitlement';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any;

function createMockSdk(over: Record<string, unknown> = {}): AnySdk {
  return {
    getUserContext: vi.fn().mockReturnValue({ user_id: 'user_1' }),
    checkEntitlement: vi.fn().mockResolvedValue({ status: 'allowed' }),
    emitSemantic: vi.fn().mockResolvedValue(undefined),
    getPlacement: vi.fn().mockResolvedValue(null),
    ...over,
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

async function mount(options: UseEntitlementOptions, sdk: AnySdk): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Probe(): null {
    useEntitlement(options);
    return null;
  }
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

const semanticNames = (sdk: AnySdk): string[] => sdk.emitSemantic.mock.calls.map((c: unknown[]) => c[0]);

describe('useEntitlement — passive gate telemetry (AC-11)', () => {
  it('emits gate_evaluated on mount and never gate_attempted', async () => {
    const sdk = createMockSdk();
    await mount({ handle: 'brand_kit' }, sdk);

    const names = semanticNames(sdk);
    expect(names).toContain('gate_evaluated');
    expect(names).not.toContain('gate_attempted');
  });

  it('carries the resolved outcome (denied) on the gate_evaluated event', async () => {
    const sdk = createMockSdk({
      checkEntitlement: vi.fn().mockResolvedValue({ status: 'denied', reason: 'no_plan' }),
    });
    await mount({ handle: 'brand_kit' }, sdk);

    const evaluated = sdk.emitSemantic.mock.calls.find((c: unknown[]) => c[0] === 'gate_evaluated');
    expect(evaluated?.[1]).toMatchObject({ outcome: 'denied', gated: true });
  });
});
