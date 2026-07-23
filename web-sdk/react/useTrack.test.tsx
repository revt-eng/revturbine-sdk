/**
 * @vitest-environment jsdom
 *
 * Plan 144 TASK-12 — `TelemetryScope` + `useTrack` (REQ-21, AC-13, AC-21).
 * Scope context merges outer → inner → invocation; `once`/`dedupeKey` suppress
 * repeats; reserved property names are dropped; and with no provider the
 * component still renders its children and `track` is a safe no-op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineContext } from './useRevTurbine';
import { TelemetryScope } from './TelemetryScope';
import { useTrack, type TrackFn } from './useTrack';

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

function makeProbe(): { Probe: () => React.ReactElement; ref: { current: TrackFn | null } } {
  const ref = { current: null as TrackFn | null };
  function Probe(): React.ReactElement {
    ref.current = useTrack();
    return <span>child</span>;
  }
  return { Probe, ref };
}

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

const firstPayload = (sdk: AnySdk): Record<string, unknown> => sdk.capture.mock.calls[0][1];

describe('TelemetryScope + useTrack', () => {
  it('renders children and no-ops track without a provider (AC-13)', async () => {
    const { Probe, ref } = makeProbe();
    await mount(
      <TelemetryScope area="x">
        <Probe />
      </TelemetryScope>,
    );
    expect(container!.textContent).toContain('child'); // children still rendered
    expect(() => ref.current!('evt', { a: 1 })).not.toThrow(); // safe no-op
  });

  it('merges scope area/action/purpose with outer→inner→invocation precedence', async () => {
    const sdk = mkSdk();
    const { Probe, ref } = makeProbe();
    await mount(
      withProvider(
        sdk,
        <TelemetryScope area="outer" purpose="engagement">
          <TelemetryScope action="inner">
            <Probe />
          </TelemetryScope>
        </TelemetryScope>,
      ),
    );

    act(() => ref.current!('clicked', { label: 'buy' }, { action: 'override' }));

    expect(sdk.capture).toHaveBeenCalledTimes(1);
    expect(sdk.capture.mock.calls[0][0]).toBe('clicked');
    expect(firstPayload(sdk)).toEqual({
      label: 'buy',
      area: 'outer', // from the outer scope
      action: 'override', // invocation wins over the inner scope
      purpose: 'engagement', // from the outer scope
    });
  });

  it('once emits a single event across repeated calls', async () => {
    const sdk = mkSdk();
    const { Probe, ref } = makeProbe();
    await mount(withProvider(sdk, <Probe />));

    act(() => {
      ref.current!('viewed', {}, { once: true });
      ref.current!('viewed', {}, { once: true });
      ref.current!('viewed', {}, { once: true });
    });
    expect(sdk.capture).toHaveBeenCalledTimes(1);
  });

  it('dedupeKey suppresses repeats sharing the key, even across event names', async () => {
    const sdk = mkSdk();
    const { Probe, ref } = makeProbe();
    await mount(withProvider(sdk, <Probe />));

    act(() => {
      ref.current!('a', {}, { dedupeKey: 'k' });
      ref.current!('b', {}, { dedupeKey: 'k' }); // same key → suppressed
      ref.current!('c', {}, { dedupeKey: 'other' });
    });
    expect(sdk.capture).toHaveBeenCalledTimes(2);
  });

  it('drops reserved property names from event data', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sdk = mkSdk();
    const { Probe, ref } = makeProbe();
    await mount(withProvider(sdk, <Probe />));

    act(() => ref.current!('evt', { user_id: 'spoof', tenant_id: 'x', event_id: 'e', plan: 'pro' }));

    const payload = firstPayload(sdk);
    expect(payload.user_id).toBeUndefined();
    expect(payload.tenant_id).toBeUndefined();
    expect(payload.event_id).toBeUndefined();
    expect(payload.plan).toBe('pro'); // non-reserved kept
  });

  it('forwards immediate through to capture', async () => {
    const sdk = mkSdk();
    const { Probe, ref } = makeProbe();
    await mount(withProvider(sdk, <Probe />));

    act(() => ref.current!('evt', {}, { immediate: true }));
    expect(sdk.capture.mock.calls[0][2]).toEqual({ immediate: true });
  });
});
