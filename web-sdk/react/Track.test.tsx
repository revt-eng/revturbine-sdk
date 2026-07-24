/**
 * @vitest-environment jsdom
 *
 * Plan 144 TASK-16 — `Track` + `useTelemetryProps` (REQ-22, AC-14). `Track asChild`
 * composes onto the child (no wrapper), runs the child's onClick first, fires
 * telemetry only if the child didn't `preventDefault`, and leaves the child's
 * accessible name + disabled state untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineContext } from './useRevTurbine';
import { Track, useTelemetryProps } from './Track';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any;
const mkSdk = (): AnySdk => ({ capture: vi.fn().mockResolvedValue(undefined) });

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
const clickBtn = async (): Promise<void> => {
  await act(async () => container!.querySelector('button')!.click());
};
const captureNames = (sdk: AnySdk): string[] => sdk.capture.mock.calls.map((c: unknown[]) => c[0] as string);

describe('Track asChild (AC-14)', () => {
  it('composes the child onClick AND fires telemetry', async () => {
    const sdk = mkSdk();
    const childClick = vi.fn();
    await mount(
      withProvider(
        sdk,
        <Track event="cta_clicked" data={{ plan: 'pro' }} asChild>
          <button type="button" onClick={childClick}>Buy</button>
        </Track>,
      ),
    );
    await clickBtn();
    expect(childClick).toHaveBeenCalledTimes(1);
    expect(captureNames(sdk)).toEqual(['cta_clicked']);
    expect(sdk.capture.mock.calls[0][1]).toEqual({ plan: 'pro' });
  });

  it('does NOT fire telemetry when the child onClick calls preventDefault', async () => {
    const sdk = mkSdk();
    await mount(
      withProvider(
        sdk,
        <Track event="cta_clicked" asChild>
          <button type="button" onClick={(e) => e.preventDefault()}>Buy</button>
        </Track>,
      ),
    );
    await clickBtn();
    expect(sdk.capture).not.toHaveBeenCalled();
  });

  it('leaves the child accessible name and disabled state unchanged', async () => {
    const sdk = mkSdk();
    await mount(
      withProvider(
        sdk,
        <Track event="cta_clicked" asChild>
          <button type="button" disabled aria-label="Upgrade now">Buy</button>
        </Track>,
      ),
    );
    const btn = container!.querySelector('button')!;
    expect(btn.textContent).toBe('Buy');
    expect(btn.getAttribute('aria-label')).toBe('Upgrade now');
    expect(btn.disabled).toBe(true);
    // No wrapper element was added.
    expect(container!.firstElementChild).toBe(btn);
  });

  it('warns and renders children when asChild gets a non-element child', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sdk = mkSdk();
    await mount(withProvider(sdk, <Track event="x" asChild>plain text</Track>));
    expect(container!.textContent).toContain('plain text');
    expect(warn).toHaveBeenCalled();
  });
});

describe('Track (wrapper) + useTelemetryProps', () => {
  it('non-asChild renders a host element that fires on click', async () => {
    const sdk = mkSdk();
    await mount(withProvider(sdk, <Track event="banner_click" as="button">Hi</Track>));
    await clickBtn();
    expect(captureNames(sdk)).toEqual(['banner_click']);
  });

  it('useTelemetryProps returns an onClick that fires telemetry', async () => {
    const sdk = mkSdk();
    function Probe(): React.ReactElement {
      return <button type="button" {...useTelemetryProps('primitive_click', { a: 1 })}>x</button>;
    }
    await mount(withProvider(sdk, <Probe />));
    await clickBtn();
    expect(captureNames(sdk)).toEqual(['primitive_click']);
    expect(sdk.capture.mock.calls[0][1]).toEqual({ a: 1 });
  });
});
