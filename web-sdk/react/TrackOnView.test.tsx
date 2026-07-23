/**
 * @vitest-environment jsdom
 *
 * Plan 144 TASK-13 — `TrackOnView` + `EngagementArea` (REQ-21, AC-12, AC-13).
 * jsdom has no `IntersectionObserver`, so both degrade to a render-time view
 * (the AC-10 fallback); the point exercised here is the **one-shot across React
 * Strict Mode's double-mount** (AC-12) and rendering children without a provider
 * (AC-13).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineContext } from './useRevTurbine';
import { TrackOnView } from './TrackOnView';
import { EngagementArea } from './EngagementArea';

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
  // Flush the render-fallback microtask + any effects.
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

describe('TrackOnView', () => {
  it('renders children without a provider (AC-13)', async () => {
    await mount(
      <TrackOnView event="x">
        <span>hi</span>
      </TrackOnView>,
    );
    expect(container!.textContent).toContain('hi');
  });

  it('fires its event exactly once under React Strict Mode (AC-12)', async () => {
    const sdk = mkSdk();
    await mount(
      withProvider(
        sdk,
        <React.StrictMode>
          <TrackOnView event="hero_seen" data={{ variant: 'a' }} />
        </React.StrictMode>,
      ),
    );
    const fires = eventsNamed(sdk, 'hero_seen');
    expect(fires).toHaveLength(1);
    expect(fires[0][1]).toMatchObject({ variant: 'a' });
  });
});

describe('EngagementArea', () => {
  it('renders children without a provider (AC-13)', async () => {
    await mount(
      <EngagementArea area="pricing">
        <span>hi</span>
      </EngagementArea>,
    );
    expect(container!.textContent).toContain('hi');
  });

  it('emits the view event once under React Strict Mode, stamped with the area (AC-12)', async () => {
    const sdk = mkSdk();
    await mount(
      withProvider(
        sdk,
        <React.StrictMode>
          <EngagementArea area="pricing" />
        </React.StrictMode>,
      ),
    );
    const views = eventsNamed(sdk, 'engagement_view');
    expect(views).toHaveLength(1);
    expect(views[0][1]).toMatchObject({ area: 'pricing' });
  });

  it('bubbles a descendant click as an interaction event', async () => {
    const sdk = mkSdk();
    await mount(
      withProvider(
        sdk,
        <EngagementArea area="pricing">
          <button type="button">Buy</button>
        </EngagementArea>,
      ),
    );
    const btn = container!.querySelector('button')!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const clicks = eventsNamed(sdk, 'engagement_interaction');
    expect(clicks).toHaveLength(1);
    expect(clicks[0][1]).toMatchObject({ area: 'pricing' });
  });

  it('emits accrued dwell on unmount', async () => {
    const base = Date.now();
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => base + offset);

    const sdk = mkSdk();
    await mount(withProvider(sdk, <EngagementArea area="pricing" />)); // enters viewport → visibleSince

    offset = 500;
    await act(async () => root!.unmount());
    root = null; // prevent afterEach double-unmount

    const dwell = eventsNamed(sdk, 'engagement_dwell');
    expect(dwell).toHaveLength(1);
    expect(dwell[0][1]).toMatchObject({ dwell_ms: 500 });
  });
});
