/**
 * Plan 144 TASK-11 — `placementExposure` moves when the presentation-writing
 * `impression` fires (AC-9, AC-10, AC-22), realizing the Q-8 ruling.
 *
 * The impression-timing table:
 *   legacy_resolution (default) → at resolution                      (denominator UNCHANGED)
 *   render                      → at render (markRendered)
 *   viewport + IntersectionObserver → at viewport exposure (markVisible 'viewport')
 *   viewport + no IntersectionObserver → at resolution, `render_fallback` (Q-8 fallback)
 *
 * `IntersectionObserver` availability is driven through a hoisted mock of
 * `exposureManager.supported`, so both branches are exercised deterministically.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ioMock = vi.hoisted(() => ({ supported: true }));

vi.mock('./telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./telemetry')>();
  return {
    ...actual,
    exposureManager: {
      get supported() {
        return ioMock.supported;
      },
      observe: () => () => {},
      disconnect: () => {},
    },
  };
});

import { PlacementController } from './controllers';
import type { PlacementControllerOptions } from './controllers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any;

function mkSdk(): AnySdk {
  return {
    getUserContext: vi.fn().mockReturnValue({ user_id: 'user_1' }),
    registerSurfaceSlot: vi.fn().mockResolvedValue('pl_1'),
    registerPlacement: vi.fn().mockResolvedValue('pl_1'),
    getPlacementDecision: vi.fn().mockResolvedValue({
      visible: true,
      placementId: 'pl_1',
      decisionSource: 'remote',
      content: { header: 'Hi' },
      output: { surface: { slot_id: 'slot_1', template: 'tpl_1' }, output_id: 'pay_1' },
    }),
    trackTreatmentInteraction: vi.fn().mockResolvedValue(undefined),
    emitSemantic: vi.fn().mockResolvedValue(undefined),
  };
}

async function loadCtrl(sdk: AnySdk, opts: Partial<PlacementControllerOptions>): Promise<PlacementController> {
  const ctrl = new PlacementController(sdk, { surfaceSlot: { id: 's', name: 's' }, ...opts });
  await ctrl.load();
  return ctrl;
}

const impressions = (sdk: AnySdk) =>
  sdk.trackTreatmentInteraction.mock.calls.filter(
    (c: unknown[]) => (c[0] as { interactionType?: string })?.interactionType === 'impression',
  );
const basisOf = (sdk: AnySdk) => (impressions(sdk)[0]?.[0] as { metadata?: { exposure_basis?: string } })?.metadata?.exposure_basis;
const semantic = (sdk: AnySdk, name: string) =>
  sdk.emitSemantic.mock.calls.filter((c: unknown[]) => c[0] === name);

beforeEach(() => {
  ioMock.supported = true;
});

describe('legacy_resolution (default) — denominator unchanged (AC-22)', () => {
  it('fires the impression at resolution, basis legacy_resolution', async () => {
    const sdk = mkSdk();
    await loadCtrl(sdk, {});
    expect(impressions(sdk)).toHaveLength(1);
    expect(basisOf(sdk)).toBe('legacy_resolution');
  });

  it('does not move when exposure lifecycle also runs', async () => {
    const sdk = mkSdk();
    const ctrl = await loadCtrl(sdk, {});
    ctrl.markRendered();
    ctrl.markVisible('viewport');
    // Still exactly one impression, credited at resolution.
    expect(impressions(sdk)).toHaveLength(1);
    expect(basisOf(sdk)).toBe('legacy_resolution');
  });
});

describe('render mode', () => {
  it('defers the impression from resolution to render', async () => {
    const sdk = mkSdk();
    const ctrl = await loadCtrl(sdk, { placementExposure: 'render' });
    expect(impressions(sdk)).toHaveLength(0); // not at resolution

    ctrl.markRendered();
    expect(impressions(sdk)).toHaveLength(1);
    expect(basisOf(sdk)).toBe('render');
    expect(semantic(sdk, 'placement_rendered')).toHaveLength(1);
  });
});

describe('viewport mode — IntersectionObserver available (AC-9)', () => {
  it('offscreen render emits placement_rendered but not placement_exposed, and no impression yet', async () => {
    const sdk = mkSdk();
    const ctrl = await loadCtrl(sdk, { placementExposure: 'viewport' });
    ctrl.markRendered();
    expect(semantic(sdk, 'placement_rendered')).toHaveLength(1);
    expect(semantic(sdk, 'placement_exposed')).toHaveLength(0);
    expect(impressions(sdk)).toHaveLength(0);
  });

  it('viewport exposure emits placement_exposed once and fires the impression', async () => {
    const sdk = mkSdk();
    const ctrl = await loadCtrl(sdk, { placementExposure: 'viewport' });
    ctrl.markRendered();
    ctrl.markVisible('viewport');
    ctrl.markVisible('viewport'); // idempotent

    expect(semantic(sdk, 'placement_exposed')).toHaveLength(1);
    expect(semantic(sdk, 'placement_exposed')[0][1]).toMatchObject({ exposure_basis: 'viewport' });
    expect(impressions(sdk)).toHaveLength(1);
    expect(basisOf(sdk)).toBe('viewport');
  });
});

describe('viewport mode — IntersectionObserver unavailable (AC-10, Q-8 fallback)', () => {
  it('fires the impression at resolution tagged render_fallback, never double-firing', async () => {
    ioMock.supported = false;
    const sdk = mkSdk();
    const ctrl = await loadCtrl(sdk, { placementExposure: 'viewport' });

    // Q-8: no observer → emit as we do today (at resolution).
    expect(impressions(sdk)).toHaveLength(1);
    expect(basisOf(sdk)).toBe('render_fallback');

    // A later render_fallback exposure emits placement_exposed but does NOT
    // re-fire the impression.
    ctrl.markVisible('render_fallback');
    expect(impressions(sdk)).toHaveLength(1);
    expect(semantic(sdk, 'placement_exposed')[0][1]).toMatchObject({ exposure_basis: 'render_fallback' });
  });
});

describe('autoTrackImpression:false suppresses the impression in every mode', () => {
  it('viewport mode with impression off never credits a presentation', async () => {
    const sdk = mkSdk();
    const ctrl = await loadCtrl(sdk, { placementExposure: 'viewport', autoTrackImpression: false });
    ctrl.markRendered();
    ctrl.markVisible('viewport');
    expect(impressions(sdk)).toHaveLength(0);
    // The lifecycle signals still emit — they are independent of the impression.
    expect(semantic(sdk, 'placement_exposed')).toHaveLength(1);
  });
});

describe('plan 144 TASK-10 — placement_resolved + decision_id provenance', () => {
  // A decision that carries the decision_id the SDK lifts onto every event it
  // causes (REQ-8). mkSdk's default decision has none, exercising the null path.
  function mkSdkWithDecisionId(decisionId: string): AnySdk {
    const sdk = mkSdk();
    sdk.getPlacementDecision.mockResolvedValue({
      visible: true,
      placementId: 'pl_1',
      decisionSource: 'remote',
      content: { header: 'Hi' },
      output: { decision_id: decisionId, surface: { slot_id: 'slot_1', template: 'tpl_1' }, output_id: 'pay_1' },
    });
    return sdk;
  }

  it('emits placement_resolved once on load with decision provenance', async () => {
    const sdk = mkSdkWithDecisionId('dec_9');
    await loadCtrl(sdk, {});
    const resolved = semantic(sdk, 'placement_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0][1]).toMatchObject({
      placement_id: 'pl_1',
      decision_id: 'dec_9',
      decision_source: 'remote',
    });
  });

  it('emits placement_resolved with decision_id null when the decision carries none', async () => {
    const sdk = mkSdk(); // default decision — no decision_id
    await loadCtrl(sdk, {});
    const resolved = semantic(sdk, 'placement_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0][1]).toMatchObject({ decision_id: null });
  });

  it('threads decision_id onto placement_rendered, placement_exposed, and the impression', async () => {
    const sdk = mkSdkWithDecisionId('dec_9');
    const ctrl = await loadCtrl(sdk, { placementExposure: 'viewport' });
    ctrl.markRendered();
    ctrl.markVisible('viewport');
    expect(semantic(sdk, 'placement_rendered')[0][1]).toMatchObject({ decision_id: 'dec_9' });
    expect(semantic(sdk, 'placement_exposed')[0][1]).toMatchObject({ decision_id: 'dec_9' });
    expect((impressions(sdk)[0][0] as { metadata?: { decision_id?: string } }).metadata?.decision_id).toBe('dec_9');
  });
});
