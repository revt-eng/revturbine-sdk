/**
 * @vitest-environment jsdom
 *
 * BL-0207 / D-30 — "The route of a slot should be calculated by react and
 * emitted as part of its events." Two host shapes:
 *
 *   - plain DOM: no router integration — the hook reports the browser's
 *     `location.pathname`, normalized (query string dropped, identifier-like
 *     segments templated to `:id`);
 *   - Next.js App Router: the host mounts `<RevTurbineRoute>` with the
 *     pattern rebuilt from `usePathname()` + `useParams()` via
 *     `routePatternFromParams`, and the declared pattern wins over the
 *     concrete pathname.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineContext } from './useRevTurbine';
import { usePlacement, type UsePlacementOptions } from './usePlacement';
import { RevTurbineRoute, useSlotRoute } from './RevTurbineRoute';
import { routePatternFromParams } from '../slot-route';

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
      requestId: 'req_1',
      decisionSource: 'local',
      reasonCodes: ['target_matched'],
      content: { header: 'Upgrade now' },
      output: { decision_id: 'dec_1', surface: { slot_id: 'slot_1', template: 'banner', type: 'banner' }, output_id: 'pay_1' },
    }),
    trackTreatmentInteraction: vi.fn().mockResolvedValue(undefined),
    emitPlatformEvent: vi.fn().mockResolvedValue(undefined),
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
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

async function render(tree: React.ReactNode, sdk: AnySdk): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineContext.Provider value={{ sdk, isReady: true, error: '', setContext: () => {} }}>
        {tree}
      </RevTurbineContext.Provider>,
    );
  });
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function Slot(props: UsePlacementOptions): null {
  usePlacement(props);
  return null;
}

const slotPayloads = (sdk: AnySdk) =>
  (sdk.emitPlatformEvent.mock.calls as Array<[string, Record<string, unknown>]>).filter(([name]) =>
    name.startsWith('slot_'),
  );

describe('usePlacement — slot route (plain DOM)', () => {
  it('stamps the normalized browser pathname on every slot lifecycle event', async () => {
    window.history.replaceState(null, '', '/accounts/4821/billing?coupon=SPRING&email=jane%40x.com#top');
    const sdk = createMockSdk();
    await render(<Slot surfaceSlot={{ id: 'slot_1', name: 'Billing upsell' }} />, sdk);

    const events = slotPayloads(sdk);
    expect(events.map(([name]) => name)).toEqual(['slot_evaluated', 'slot_filled']);
    for (const [, payload] of events) {
      expect(payload.route).toBe('/accounts/:id/billing');
      expect(payload.slot_name).toBe('Billing upsell');
      // The query string and fragment never reach the payload in any field.
      expect(JSON.stringify(payload)).not.toContain('SPRING');
      expect(JSON.stringify(payload)).not.toContain('jane');
    }
  });

  it('useSlotRoute reports the same route the events carry', async () => {
    window.history.replaceState(null, '', '/settings/team/');
    let seen: string | null = 'unset';
    function Probe(): null {
      seen = useSlotRoute();
      return null;
    }
    await render(<Probe />, createMockSdk());
    expect(seen).toBe('/settings/team');
  });
});

describe('usePlacement — slot route (Next.js App Router pattern)', () => {
  it('prefers the <RevTurbineRoute> pattern built from usePathname() + useParams()', async () => {
    // What Next's hooks return for app/projects/[projectId]/settings/page.tsx.
    const pathname = '/projects/proj_8f3a2c/settings';
    const params = { projectId: 'proj_8f3a2c' };
    window.history.replaceState(null, '', `${pathname}?ref=email`);
    const sdk = createMockSdk();

    await render(
      <RevTurbineRoute route={routePatternFromParams(pathname, params)}>
        <Slot surfaceSlot={{ id: 'slot_1', name: 'Project upsell' }} />
      </RevTurbineRoute>,
      sdk,
    );

    const events = slotPayloads(sdk);
    expect(events.length).toBeGreaterThan(0);
    for (const [, payload] of events) {
      expect(payload.route).toBe('/projects/[projectId]/settings');
    }
  });

  it('the innermost boundary wins, and an empty boundary defers to its parent', async () => {
    const sdk = createMockSdk();
    await render(
      <RevTurbineRoute route="/dashboard">
        <RevTurbineRoute route={null}>
          <Slot surfaceSlot={{ id: 'slot_1' }} />
        </RevTurbineRoute>
        <RevTurbineRoute route="/dashboard/[widgetId]?debug=1">
          <Slot surfaceSlot={{ id: 'slot_2' }} />
        </RevTurbineRoute>
      </RevTurbineRoute>,
      sdk,
    );

    // Both slots resolve the same mocked decision, so compare the emitted set.
    const routes = new Set(slotPayloads(sdk).map(([, p]) => p.route));
    expect(routes).toEqual(new Set(['/dashboard', '/dashboard/[widgetId]']));
  });
});
