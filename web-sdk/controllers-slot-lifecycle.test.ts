/**
 * Plan 144 TASK-10 (optional breadth) — slot delivery diagnostics + the
 * terminal `placement_outcome`, per spec §10.1 / §10.3.
 *
 *   slot_evaluated → { slot_filled | slot_empty | slot_suppressed } | slot_error
 *   ctaComplete()  → placement_outcome
 *
 * These are funnel-denominator signals (not engagement), deduped within the
 * decision-cache lifetime and best-effort — a telemetry failure never breaks a
 * placement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      requestId: 'req_1',
      decisionSource: 'remote',
      reasonCodes: ['target_matched'],
      content: { header: 'Hi' },
      output: {
        decision_id: 'dec_9',
        surface: { slot_id: 'slot_1', template: 'tpl_1', type: 'banner' },
        output_id: 'pay_1',
        category: 'promo',
      },
    }),
    trackTreatmentInteraction: vi.fn().mockResolvedValue(undefined),
    emitSemantic: vi.fn().mockResolvedValue(undefined),
  };
}

async function loadCtrl(sdk: AnySdk, opts: Partial<PlacementControllerOptions> = {}): Promise<PlacementController> {
  const ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'Upgrade slot' }, ...opts });
  await ctrl.load();
  return ctrl;
}

const semantic = (sdk: AnySdk, name: string) =>
  sdk.emitSemantic.mock.calls.filter((c: unknown[]) => c[0] === name);
const payloadOf = (sdk: AnySdk, name: string) => semantic(sdk, name)[0]?.[1] as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('slot resolution diagnostics (spec §10.1)', () => {
  it('emits slot_evaluated + slot_filled for a visible decision, with slot + decision context', async () => {
    const sdk = mkSdk();
    await loadCtrl(sdk);
    expect(semantic(sdk, 'slot_evaluated')).toHaveLength(1);
    expect(semantic(sdk, 'slot_filled')).toHaveLength(1);
    expect(semantic(sdk, 'slot_empty')).toHaveLength(0);
    expect(semantic(sdk, 'slot_suppressed')).toHaveLength(0);

    expect(payloadOf(sdk, 'slot_filled')).toMatchObject({
      surface_slot_id: 'slot_1',
      slot_name: 'Upgrade slot',
      template_id: 'tpl_1',
      surface_type: 'banner',
      category: 'promo',
      decision_source: 'remote',
      reason_codes: ['target_matched'],
      decision_id: 'dec_9',
    });
  });

  it('emits slot_empty when nothing matched (not visible, no suppression)', async () => {
    const sdk = mkSdk();
    sdk.getPlacementDecision.mockResolvedValue({
      visible: false,
      placementId: 'pl_1',
      requestId: 'req_1',
      decisionSource: 'remote',
      reasonCodes: ['no_target_match'],
      content: {},
    });
    await loadCtrl(sdk);
    expect(semantic(sdk, 'slot_evaluated')).toHaveLength(1);
    expect(semantic(sdk, 'slot_empty')).toHaveLength(1);
    expect(semantic(sdk, 'slot_filled')).toHaveLength(0);
    expect(semantic(sdk, 'slot_suppressed')).toHaveLength(0);
  });

  it('emits slot_suppressed when a suppression reason is present', async () => {
    const sdk = mkSdk();
    sdk.getPlacementDecision.mockResolvedValue({
      visible: false,
      placementId: 'pl_1',
      requestId: 'req_1',
      decisionSource: 'remote',
      reasonCodes: ['frequency_cap_reached'],
      suppressionReason: 'frequency_cap_reached',
      content: {},
    });
    await loadCtrl(sdk);
    expect(semantic(sdk, 'slot_suppressed')).toHaveLength(1);
    expect(semantic(sdk, 'slot_empty')).toHaveLength(0);
    expect(semantic(sdk, 'slot_filled')).toHaveLength(0);
  });

  it('emits slot_error when resolution fails', async () => {
    const sdk = mkSdk();
    sdk.getPlacementDecision.mockRejectedValue(new Error('decision service down'));
    await loadCtrl(sdk);
    const err = semantic(sdk, 'slot_error');
    expect(err).toHaveLength(1);
    expect(err[0][1]).toMatchObject({ surface_slot_id: 'slot_1', error: 'decision service down' });
    // No terminal resolution event when the fetch threw.
    expect(semantic(sdk, 'slot_filled')).toHaveLength(0);
  });

  it('dedupes a re-load against the same cached decision, and reset() re-arms', async () => {
    const sdk = mkSdk();
    const ctrl = await loadCtrl(sdk);
    expect(semantic(sdk, 'slot_evaluated')).toHaveLength(1);

    // Same decision identity (requestId/decision_id) → no re-emit.
    await ctrl.load();
    expect(semantic(sdk, 'slot_evaluated')).toHaveLength(1);
    expect(semantic(sdk, 'slot_filled')).toHaveLength(1);

    // reset() wipes the dedup key → next load re-emits.
    ctrl.reset();
    await ctrl.load();
    expect(semantic(sdk, 'slot_evaluated')).toHaveLength(2);
  });

  it('re-emits when a fresh decision changes identity', async () => {
    const sdk = mkSdk();
    const ctrl = await loadCtrl(sdk);
    expect(semantic(sdk, 'slot_filled')).toHaveLength(1);

    sdk.getPlacementDecision.mockResolvedValue({
      visible: true,
      placementId: 'pl_1',
      requestId: 'req_2', // new identity
      decisionSource: 'remote',
      reasonCodes: [],
      content: { header: 'Hi' },
      output: { decision_id: 'dec_10', surface: { slot_id: 'slot_1' } },
    });
    await ctrl.load();
    expect(semantic(sdk, 'slot_filled')).toHaveLength(2);
  });
});

describe('placement_outcome (spec §10.3)', () => {
  it('emits placement_outcome on ctaComplete with decision provenance', async () => {
    const sdk = mkSdk();
    const ctrl = await loadCtrl(sdk);
    await ctrl.ctaComplete('/upgrade');

    const outcome = semantic(sdk, 'placement_outcome');
    expect(outcome).toHaveLength(1);
    expect(outcome[0][1]).toMatchObject({
      placement_id: 'pl_1',
      surface_slot_id: 'slot_1',
      payload_id: 'pay_1',
      decision_id: 'dec_9',
      decision_source: 'remote',
      outcome: 'cta_completed',
      cta_target: '/upgrade',
    });
  });

  it('does not emit placement_outcome for a plain ctaClick', async () => {
    const sdk = mkSdk();
    const ctrl = await loadCtrl(sdk);
    await ctrl.ctaClick('/upgrade');
    expect(semantic(sdk, 'placement_outcome')).toHaveLength(0);
  });
});
