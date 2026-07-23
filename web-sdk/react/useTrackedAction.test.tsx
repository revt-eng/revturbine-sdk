/**
 * @vitest-environment jsdom
 *
 * Plan 144 TASK-14 — `useTrackedAction` + `useGatedAction` (REQ-21, AC-11, AC-13).
 * `useTrackedAction` telemeters started/completed/failed and preserves the return
 * value; `useGatedAction` delegates to `sdk.gate` (so the gate sequence isn't
 * forked — that sequence itself is covered in customer-side-gate-sequence).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineContext } from './useRevTurbine';
import { useTrackedAction } from './useTrackedAction';
import { useGatedAction } from './useGatedAction';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any;

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

async function mount(tree: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(tree));
}

function withProvider(sdk: AnySdk, children: React.ReactNode): React.ReactElement {
  return (
    <RevTurbineContext.Provider value={{ sdk, isReady: true, error: '', setContext: () => {} }}>
      {children}
    </RevTurbineContext.Provider>
  );
}

const names = (sdk: AnySdk): string[] => sdk.capture.mock.calls.map((c: unknown[]) => c[0] as string);

describe('useTrackedAction', () => {
  it('emits started → completed and preserves the return value', async () => {
    const sdk: AnySdk = { capture: vi.fn().mockResolvedValue(undefined) };
    const ref = { current: null as ReturnType<typeof useTrackedAction> | null };
    function Probe(): null {
      ref.current = useTrackedAction('export', async () => 'done');
      return null;
    }
    await mount(withProvider(sdk, <Probe />));

    let value: unknown;
    await act(async () => {
      value = await ref.current!.run();
    });
    expect(value).toBe('done');
    expect(names(sdk)).toEqual(['export_started', 'export_completed']);
  });

  it('emits started → failed with a non-sensitive category and re-throws', async () => {
    const sdk: AnySdk = { capture: vi.fn().mockResolvedValue(undefined) };
    const ref = { current: null as ReturnType<typeof useTrackedAction> | null };
    function Probe(): null {
      ref.current = useTrackedAction('save', async () => {
        throw new Error('Network request failed for user@example.com');
      });
      return null;
    }
    await mount(withProvider(sdk, <Probe />));

    await act(async () => {
      await expect(ref.current!.run()).rejects.toThrow(/Network request failed/);
    });
    expect(names(sdk)).toEqual(['save_started', 'save_failed']);
    const failed = sdk.capture.mock.calls.find((c: unknown[]) => c[0] === 'save_failed');
    expect(failed[1]).toEqual({ error_category: 'network' }); // NO raw message / email
  });
});

describe('useGatedAction', () => {
  it('delegates to sdk.gate and telemeters the wrapped action', async () => {
    const sdk: AnySdk = {
      capture: vi.fn().mockResolvedValue(undefined),
      gate: vi.fn(async (_action: string, fn: () => Promise<unknown>) => ({
        ran: true,
        result: await fn(),
        entitlement: { status: 'allowed', allowed: true },
      })),
    };
    const ref = { current: null as ReturnType<typeof useGatedAction> | null };
    function Probe(): null {
      ref.current = useGatedAction('export_pdf', async () => 'exported');
      return null;
    }
    await mount(withProvider(sdk, <Probe />));

    let result: { ran: boolean } | undefined;
    await act(async () => {
      result = await ref.current!.run();
    });
    expect(sdk.gate).toHaveBeenCalledWith('export_pdf', expect.any(Function), undefined);
    expect(result).toMatchObject({ ran: true });
    expect(names(sdk)).toEqual(['export_pdf_started', 'export_pdf_completed']);
  });

  it('is a safe no-op reporting denied without a provider (AC-13)', async () => {
    const ref = { current: null as ReturnType<typeof useGatedAction> | null };
    function Probe(): null {
      ref.current = useGatedAction('export_pdf', async () => 'exported');
      return null;
    }
    // No provider — default context sdk is null.
    await mount(<Probe />);

    let result: { ran: boolean } | undefined;
    await act(async () => {
      result = await ref.current!.run();
    });
    expect(result).toMatchObject({ ran: false });
  });
});
