/**
 * @vitest-environment jsdom
 *
 * ST-1344 REQ-6 (a)-(f) + AC-9 — the area → feature → action telemetry
 * hierarchy: `feature` on `TelemetryScope`, `EngagementArea` and `useTrack`
 * options, merged per field outer → inner → invocation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineContext } from './useRevTurbine';
import { TelemetryScope } from './TelemetryScope';
import { EngagementArea } from './EngagementArea';
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

async function mount(tree: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(tree));
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function withProvider(sdk: AnySdk, children: React.ReactNode): React.ReactElement {
  return (
    <RevTurbineContext.Provider value={{ sdk, isReady: true, error: '', setContext: () => {} }}>
      {children}
    </RevTurbineContext.Provider>
  );
}

const eventsNamed = (sdk: AnySdk, name: string) =>
  sdk.capture.mock.calls.filter((c: unknown[]) => c[0] === name);

function makeProbe(): { Probe: () => React.ReactElement; ref: { current: TrackFn | null } } {
  const ref = { current: null as TrackFn | null };
  function Probe(): React.ReactElement {
    ref.current = useTrack();
    return <span>probe</span>;
  }
  return { Probe, ref };
}

describe('telemetry hierarchy (area → feature → action)', () => {
  it('(a) TelemetryScope area + EngagementArea feature stamps view, interaction and dwell', async () => {
    const base = Date.now();
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => base + offset);
    const sdk = mkSdk();
    await mount(
      withProvider(
        sdk,
        <TelemetryScope area="editor">
          <EngagementArea feature="timeline">
            <button type="button">go</button>
          </EngagementArea>
        </TelemetryScope>,
      ),
    );
    await act(async () => {
      container!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    offset = 400;
    await act(async () => root!.unmount());
    root = null;
    for (const name of ['engagement_view', 'engagement_interaction', 'engagement_dwell']) {
      const calls = eventsNamed(sdk, name);
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ area: 'editor', feature: 'timeline' });
    }
  });

  it('(b) EngagementArea area alone keeps today\'s payload keys (no feature key)', async () => {
    const sdk = mkSdk();
    await mount(withProvider(sdk, <EngagementArea area="pricing" />));
    const views = eventsNamed(sdk, 'engagement_view');
    expect(views).toHaveLength(1);
    expect(Object.keys(views[0][1]).sort()).toEqual(['area']);
    expect(views[0][1]).toEqual({ area: 'pricing' });
  });

  it('(c) invocation feature overrides scope feature; nested scopes merge inner-over-outer', async () => {
    const sdk = mkSdk();
    const { Probe, ref } = makeProbe();
    await mount(
      withProvider(
        sdk,
        <TelemetryScope feature="outer">
          <TelemetryScope feature="inner">
            <Probe />
          </TelemetryScope>
        </TelemetryScope>,
      ),
    );
    await act(async () => {
      ref.current!('scoped');
      ref.current!('overridden', {}, { feature: 'call' });
    });
    expect(eventsNamed(sdk, 'scoped')[0][1]).toMatchObject({ feature: 'inner' });
    expect(eventsNamed(sdk, 'overridden')[0][1]).toMatchObject({ feature: 'call' });
  });

  it('(d) EngagementArea area + feature emits both', async () => {
    const sdk = mkSdk();
    await mount(withProvider(sdk, <EngagementArea area="x" feature="y" />));
    expect(eventsNamed(sdk, 'engagement_view')[0][1]).toEqual({ area: 'x', feature: 'y' });
  });

  it('(e) an ordinary track beneath scope area + EngagementArea feature carries both', async () => {
    const sdk = mkSdk();
    const { Probe, ref } = makeProbe();
    await mount(
      withProvider(
        sdk,
        <TelemetryScope area="editor">
          <EngagementArea feature="timeline">
            <Probe />
          </EngagementArea>
        </TelemetryScope>,
      ),
    );
    await act(async () => {
      ref.current!('clip_split');
    });
    expect(eventsNamed(sdk, 'clip_split')[0][1]).toMatchObject({
      area: 'editor',
      feature: 'timeline',
    });
  });

  it('(f) a scope that sets area does not reset an inherited feature (per-field inheritance)', async () => {
    const sdk = mkSdk();
    await mount(
      withProvider(
        sdk,
        <TelemetryScope feature="timeline">
          <EngagementArea area="billing" />
        </TelemetryScope>,
      ),
    );
    expect(eventsNamed(sdk, 'engagement_view')[0][1]).toEqual({
      area: 'billing',
      feature: 'timeline',
    });
  });

  it('(AC-9) TelemetryScope properties merge beneath event data, nested, reserved keys stripped', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sdk = mkSdk();
    const { Probe, ref } = makeProbe();
    await mount(
      withProvider(
        sdk,
        <TelemetryScope properties={{ product_kind: 'video', tier: 'a' }}>
          <TelemetryScope properties={{ tier: 'b', tenant_id: 'evil' }}>
            <Probe />
          </TelemetryScope>
        </TelemetryScope>,
      ),
    );
    await act(async () => {
      ref.current!('with_props', { product_kind: 'audio' });
      ref.current!('scope_props');
    });
    expect(eventsNamed(sdk, 'with_props')[0][1]).toEqual({ product_kind: 'audio', tier: 'b' });
    expect(eventsNamed(sdk, 'scope_props')[0][1]).toEqual({ product_kind: 'video', tier: 'b' });
  });
});
