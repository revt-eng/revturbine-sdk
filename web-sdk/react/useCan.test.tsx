/**
 * @vitest-environment jsdom
 *
 * Plan 169 TASK-7 / AC-9 — `useCan` is deny-until-ready: `can` is `false` while
 * the check is unresolved (with `isLoading: true`), flips within a microtask
 * once the local evaluation resolves, and settles fail-closed (`can: false`,
 * `isLoading: false`) when the check errors. `<Gate>` behavior is unchanged —
 * this covers the raw hook boolean that used to report `true` pre-resolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineContext } from './useRevTurbine';
import { useCan, type UseCanResult } from './useCan';

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

async function mount(
  handle: string,
  sdk: AnySdk,
  { isReady = true }: { isReady?: boolean } = {},
): Promise<UseCanResult[]> {
  const snapshots: UseCanResult[] = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Probe(): null {
    snapshots.push(useCan(handle));
    return null;
  }
  await act(async () => {
    root!.render(
      <RevTurbineContext.Provider value={{ sdk, isReady, error: '', setContext: () => {} }}>
        <Probe />
      </RevTurbineContext.Provider>,
    );
  });
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return snapshots;
}

describe('useCan — deny-until-ready (AC-9)', () => {
  it('reports { can: false, isLoading: true } before the check resolves', async () => {
    const snapshots = await mount('batch_export', createMockSdk());
    expect(snapshots[0]).toMatchObject({ can: false, isLoading: true, result: null });
  });

  it('flips to { can: true, isLoading: false } once an allowed result resolves', async () => {
    const snapshots = await mount('batch_export', createMockSdk());
    expect(snapshots.at(-1)).toMatchObject({ can: true, limited: false, isLoading: false });
  });

  it('settles to { can: false, isLoading: false } on a denied result', async () => {
    const sdk = createMockSdk({
      checkEntitlement: vi.fn().mockResolvedValue({ status: 'denied', reason: 'no_plan' }),
    });
    const snapshots = await mount('batch_export', sdk);
    expect(snapshots.at(-1)).toMatchObject({ can: false, isLoading: false });
  });

  it('grants with limited: true for a limited result', async () => {
    const sdk = createMockSdk({
      checkEntitlement: vi.fn().mockResolvedValue({ status: 'limited' }),
    });
    const snapshots = await mount('batch_export', sdk);
    expect(snapshots.at(-1)).toMatchObject({ can: true, limited: true, isLoading: false });
  });

  it('stays denied while a check hangs unresolved — an unresolved check never grants', async () => {
    const sdk = createMockSdk({
      checkEntitlement: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const snapshots = await mount('batch_export', sdk);
    expect(snapshots.at(-1)).toMatchObject({ can: false, isLoading: true, result: null });
  });

  it('settles fail-closed ({ can: false, isLoading: false }) when the check throws', async () => {
    const sdk = createMockSdk({
      checkEntitlement: vi.fn().mockRejectedValue(new Error('resolver exploded')),
    });
    const snapshots = await mount('batch_export', sdk);
    expect(snapshots.at(-1)).toMatchObject({ can: false, isLoading: false, result: null });
  });

  it('holds { can: false, isLoading: true } while the SDK is not ready (init window)', async () => {
    const snapshots = await mount('batch_export', createMockSdk(), { isReady: false });
    expect(snapshots.at(-1)).toMatchObject({ can: false, isLoading: true, result: null });
  });
});
