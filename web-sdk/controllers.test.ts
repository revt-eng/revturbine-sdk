import { describe, expect, it, beforeEach, vi } from 'vitest';
import { PlacementController, EntitlementGate, SdkSession } from './controllers';
import type { PlacementControllerOptions, EntitlementGateOptions } from './controllers';

// ---------------------------------------------------------------------------
//  Mock SDK factory — stubs every method PlacementController / EntitlementGate
//  / SdkSession call on RevTurbineCustomerSdk.
// ---------------------------------------------------------------------------

function createMockSdk(overrides: Record<string, unknown> = {}) {
  return {
    getUserContext: vi.fn().mockReturnValue({ user_id: 'user_1', tenant_id: 'tenant_1' }),
    registerSurfaceSlot: vi.fn().mockResolvedValue('pl_slot_1'),
    registerPlacement: vi.fn().mockResolvedValue('pl_placement_1'),
    getPlacementDecision: vi.fn().mockResolvedValue({
      visible: true,
      placementId: 'pl_slot_1',
      decisionSource: 'remote',
      content: { header: 'Upgrade now', body: 'Get 50% off', cta_label: 'Upgrade' },
    }),
    trackTreatmentInteraction: vi.fn().mockResolvedValue(undefined),
    checkEntitlement: vi.fn().mockResolvedValue({ status: 'allowed' }),
    getPlacement: vi.fn().mockResolvedValue(null),
    identify: vi.fn(),
    resetIdentity: vi.fn(),
    setUserContext: vi.fn(),
    updateUsage: vi.fn(),
    fetchUserContext: vi.fn().mockResolvedValue({ userId: 'user_1', segmentIds: [], traits: {} }),
    getTrialStatus: vi.fn().mockResolvedValue({ in_trial: false }),
    getUsage: vi.fn().mockReturnValue({}),
    trackEvent: vi.fn().mockResolvedValue(undefined),
    bootstrapPlacementDecisions: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
//  PlacementController
// ---------------------------------------------------------------------------

describe('PlacementController', () => {
  let sdk: ReturnType<typeof createMockSdk>;
  let ctrl: PlacementController;

  beforeEach(() => {
    sdk = createMockSdk();
  });

  describe('initial state', () => {
    it('starts with empty/default state', () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      expect(ctrl.state).toEqual({
        isLoading: false,
        error: '',
        placementId: '',
        visible: false,
        decision: null,
        content: null,
      });
      expect(ctrl.visible).toBe(false);
      expect(ctrl.content).toBeNull();
      expect(ctrl.decision).toBeNull();
      expect(ctrl.placementId).toBe('');
    });
  });

  describe('load()', () => {
    it('registers surface slot and fetches a visible decision', async () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      const decision = await ctrl.load();

      expect(sdk.registerSurfaceSlot).toHaveBeenCalledWith({ id: 'slot_1', name: 'slot_1' });
      expect(sdk.getPlacementDecision).toHaveBeenCalledWith(
        expect.objectContaining({ placementId: 'pl_slot_1', userId: 'user_1' }),
      );
      expect(decision?.visible).toBe(true);
      expect(ctrl.visible).toBe(true);
      expect(ctrl.placementId).toBe('pl_slot_1');
      expect(ctrl.content).toEqual({ header: 'Upgrade now', body: 'Get 50% off', cta_label: 'Upgrade' });
    });

    it('registers placement config when surfaceSlot is not provided', async () => {
      ctrl = new PlacementController(sdk, { placement: { name: 'banner' } });
      await ctrl.load();

      expect(sdk.registerPlacement).toHaveBeenCalledWith({ name: 'banner' });
      expect(sdk.registerSurfaceSlot).not.toHaveBeenCalled();
    });

    it('errors when neither placement nor surfaceSlot is provided', async () => {
      ctrl = new PlacementController(sdk, {});
      const decision = await ctrl.load();

      expect(decision).toBeNull();
      expect(ctrl.state.error).toBe('Either placement or surfaceSlot must be provided.');
    });

    it('errors when no userId is available', async () => {
      sdk.getUserContext.mockReturnValue({ user_id: '', tenant_id: 'tenant_1' });
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      const decision = await ctrl.load();

      expect(decision).toBeNull();
      expect(ctrl.state.error).toBe('Cannot load placement: no userId available.');
    });

    it('uses explicit userId over SDK context', async () => {
      ctrl = new PlacementController(sdk, {
        surfaceSlot: { id: 'slot_1', name: 'slot_1' },
        userId: 'explicit_user',
      });
      await ctrl.load();

      expect(sdk.getPlacementDecision).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'explicit_user' }),
      );
    });

    it('auto-tracks impression for visible decisions', async () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      await ctrl.load();

      expect(sdk.trackTreatmentInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          interactionType: 'impression',
          placementId: 'pl_slot_1',
          userId: 'user_1',
        }),
      );
    });

    it('skips impression tracking when autoTrackImpression is false', async () => {
      ctrl = new PlacementController(sdk, {
        surfaceSlot: { id: 'slot_1', name: 'slot_1' },
        autoTrackImpression: false,
      });
      await ctrl.load();

      expect(sdk.trackTreatmentInteraction).not.toHaveBeenCalled();
    });

    it('does not double-track impressions on subsequent loads', async () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      await ctrl.load();
      await ctrl.load();

      const impressionCalls = sdk.trackTreatmentInteraction.mock.calls.filter(
        (c: any[]) => c[0].interactionType === 'impression',
      );
      expect(impressionCalls).toHaveLength(1);
    });

    it('does not register twice on subsequent loads', async () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      await ctrl.load();
      await ctrl.load();

      expect(sdk.registerSurfaceSlot).toHaveBeenCalledTimes(1);
      expect(sdk.getPlacementDecision).toHaveBeenCalledTimes(2);
    });

    it('does not track impression for invisible decisions', async () => {
      sdk.getPlacementDecision.mockResolvedValue({
        visible: false,
        decisionSource: 'remote',
        content: null,
      });
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      await ctrl.load();

      expect(sdk.trackTreatmentInteraction).not.toHaveBeenCalled();
      expect(ctrl.visible).toBe(false);
    });

    it('passes contextMode, overrides, traits, and ttlMs to decision request', async () => {
      const overrides = { planHandle: 'enterprise' } as any;
      const traits = { region: 'us' };
      ctrl = new PlacementController(sdk, {
        surfaceSlot: { id: 'slot_1', name: 'slot_1' },
        contextMode: 'segment-based',
        overrides,
        traits,
        ttlMs: 5000,
      });
      await ctrl.load();

      expect(sdk.getPlacementDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          contextMode: 'segment-based',
          overrides,
          traits: { region: 'us' },
          ttlMs: 5000,
        }),
      );
    });

    it('captures error message on SDK failure', async () => {
      sdk.getPlacementDecision.mockRejectedValue(new Error('Network timeout'));
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      const decision = await ctrl.load();

      expect(decision).toBeNull();
      expect(ctrl.state.error).toBe('Network timeout');
      expect(ctrl.state.isLoading).toBe(false);
    });
  });

  describe('refresh()', () => {
    it('re-fetches and resets impression tracking', async () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      await ctrl.load();
      expect(sdk.trackTreatmentInteraction).toHaveBeenCalledTimes(1);

      await ctrl.refresh();

      const impressionCalls = sdk.trackTreatmentInteraction.mock.calls.filter(
        (c: any[]) => c[0].interactionType === 'impression',
      );
      expect(impressionCalls).toHaveLength(2);
    });
  });

  describe('interactions', () => {
    beforeEach(async () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      await ctrl.load();
      sdk.trackTreatmentInteraction.mockClear();
    });

    it('dismiss() tracks and hides', async () => {
      await ctrl.dismiss();

      expect(sdk.trackTreatmentInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          interactionType: 'dismiss',
          metadata: { cooldown_ms: 86400000 },
        }),
      );
      expect(ctrl.visible).toBe(false);
    });

    it('dismiss() accepts custom cooldown', async () => {
      await ctrl.dismiss(60_000);

      expect(sdk.trackTreatmentInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { cooldown_ms: 60_000 },
        }),
      );
    });

    it('snooze() tracks remind_me_later and hides', async () => {
      await ctrl.snooze(7200);

      expect(sdk.trackTreatmentInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          interactionType: 'remind_me_later',
          metadata: { remind_after_seconds: 7200 },
        }),
      );
      expect(ctrl.visible).toBe(false);
    });

    it('remindMeLater() is an alias for snooze()', async () => {
      await ctrl.remindMeLater(1800);

      expect(sdk.trackTreatmentInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          interactionType: 'remind_me_later',
          metadata: { remind_after_seconds: 1800 },
        }),
      );
    });

    it('ctaClick() tracks without hiding', async () => {
      await ctrl.ctaClick('/upgrade');

      expect(sdk.trackTreatmentInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          interactionType: 'cta_clicked',
          metadata: { cta_target: '/upgrade' },
        }),
      );
      expect(ctrl.visible).toBe(true);
    });

    it('ctaComplete() tracks and hides', async () => {
      await ctrl.ctaComplete('/upgrade');

      expect(sdk.trackTreatmentInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          interactionType: 'cta_completed',
          metadata: { cta_target: '/upgrade' },
        }),
      );
      expect(ctrl.visible).toBe(false);
    });

    it('does not track interactions when no placementId', async () => {
      const emptyCtrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      // Never loaded — no placementId
      await emptyCtrl.dismiss();
      expect(sdk.trackTreatmentInteraction).not.toHaveBeenCalled();
    });
  });

  describe('onChange()', () => {
    it('notifies listeners on load', async () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      const listener = vi.fn();
      ctrl.onChange(listener);

      await ctrl.load();

      // Called at least twice: once for isLoading=true, once for isLoading=false
      expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('unsubscribes when returned function is called', async () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      const listener = vi.fn();
      const unsub = ctrl.onChange(listener);
      unsub();

      await ctrl.load();

      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies listeners on dismiss', async () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      await ctrl.load();

      const listener = vi.fn();
      ctrl.onChange(listener);
      await ctrl.dismiss();

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('reset()', () => {
    it('clears all state back to defaults', async () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      await ctrl.load();
      expect(ctrl.placementId).toBe('pl_slot_1');

      ctrl.reset();

      expect(ctrl.state).toEqual({
        isLoading: false,
        error: '',
        placementId: '',
        visible: false,
        decision: null,
        content: null,
      });
    });

    it('notifies listeners on reset', async () => {
      ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      const listener = vi.fn();
      ctrl.onChange(listener);

      ctrl.reset();

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
//  EntitlementGate
// ---------------------------------------------------------------------------

describe('EntitlementGate', () => {
  let sdk: ReturnType<typeof createMockSdk>;

  beforeEach(() => {
    sdk = createMockSdk();
  });

  describe('initial state', () => {
    it('starts with empty/default state', () => {
      const gate = new EntitlementGate(sdk, { handle: 'brand_kit' });
      expect(gate.state).toEqual({
        isLoading: false,
        error: null,
        result: null,
        allowed: false,
        limited: false,
        denied: false,
        gatedPlacement: null,
      });
    });
  });

  describe('check()', () => {
    it('checks entitlement and returns allowed', async () => {
      sdk.checkEntitlement.mockResolvedValue({ status: 'allowed' });
      const gate = new EntitlementGate(sdk, { handle: 'brand_kit' });
      const result = await gate.check();

      expect(sdk.checkEntitlement).toHaveBeenCalledWith('brand_kit', undefined);
      expect(result?.status).toBe('allowed');
      expect(gate.allowed).toBe(true);
      expect(gate.denied).toBe(false);
      expect(gate.limited).toBe(false);
    });

    it('checks entitlement with context', async () => {
      const context = { requiredTier: 'pro' } as any;
      const gate = new EntitlementGate(sdk, { handle: 'brand_kit', context });
      await gate.check();

      expect(sdk.checkEntitlement).toHaveBeenCalledWith('brand_kit', context);
    });

    it('detects limited status', async () => {
      sdk.checkEntitlement.mockResolvedValue({ status: 'limited', limit: 100, used: 80 });
      const gate = new EntitlementGate(sdk, { handle: 'api_calls' });
      await gate.check();

      expect(gate.limited).toBe(true);
      expect(gate.allowed).toBe(false);
      expect(gate.denied).toBe(false);
    });

    it('detects denied status', async () => {
      sdk.checkEntitlement.mockResolvedValue({ status: 'denied' });
      const gate = new EntitlementGate(sdk, { handle: 'brand_kit' });
      await gate.check();

      expect(gate.denied).toBe(true);
      expect(gate.allowed).toBe(false);
    });

    it('does not fetch gated placement when autoGate is false', async () => {
      sdk.checkEntitlement.mockResolvedValue({ status: 'denied' });
      const gate = new EntitlementGate(sdk, { handle: 'brand_kit', autoGate: false });
      await gate.check();

      expect(gate.denied).toBe(true);
      expect(gate.gatedPlacement).toBeNull();
      expect(sdk.getPlacement).not.toHaveBeenCalled();
    });

    it('uses inline placement from entitlement result when available', async () => {
      const inlinePlacement = { output_id: 'out_1', category: 'upsell' };
      sdk.checkEntitlement.mockResolvedValue({ status: 'denied', placement: inlinePlacement });
      const gate = new EntitlementGate(sdk, { handle: 'brand_kit', autoGate: true });
      await gate.check();

      expect(gate.denied).toBe(true);
      expect(gate.gatedPlacement).toEqual(inlinePlacement);
      expect(sdk.getPlacement).not.toHaveBeenCalled();
    });

    it('fetches gated placement from API when autoGate is true and no inline placement', async () => {
      sdk.checkEntitlement.mockResolvedValue({ status: 'denied' });
      const mockPlacement = { output_id: 'out_2', category: 'gate' };
      sdk.getPlacement.mockResolvedValue(mockPlacement);

      const gate = new EntitlementGate(sdk, { handle: 'brand_kit', autoGate: true });
      await gate.check();

      expect(sdk.getPlacement).toHaveBeenCalledWith(
        expect.objectContaining({ entitlementHandle: 'brand_kit' }),
      );
      expect(gate.gatedPlacement).toEqual(mockPlacement);
    });

    it('passes gatePlacementRequest to getPlacement', async () => {
      sdk.checkEntitlement.mockResolvedValue({ status: 'denied' });
      sdk.getPlacement.mockResolvedValue(null);

      const gate = new EntitlementGate(sdk, {
        handle: 'brand_kit',
        autoGate: true,
        gatePlacementRequest: { slotId: 'gate_slot' },
      });
      await gate.check();

      expect(sdk.getPlacement).toHaveBeenCalledWith({
        slotId: 'gate_slot',
        entitlementHandle: 'brand_kit',
      });
    });

    it('clears gatedPlacement when allowed', async () => {
      // First check: denied with inline placement
      sdk.checkEntitlement.mockResolvedValue({ status: 'denied', placement: { output_id: 'x' } });
      const gate = new EntitlementGate(sdk, { handle: 'brand_kit', autoGate: true });
      await gate.check();
      expect(gate.gatedPlacement).not.toBeNull();

      // Second check: now allowed
      sdk.checkEntitlement.mockResolvedValue({ status: 'allowed' });
      await gate.recheck();
      expect(gate.gatedPlacement).toBeNull();
      expect(gate.allowed).toBe(true);
    });

    it('captures error on SDK failure', async () => {
      sdk.checkEntitlement.mockRejectedValue(new Error('API unavailable'));
      const gate = new EntitlementGate(sdk, { handle: 'brand_kit' });
      const result = await gate.check();

      expect(result).toBeNull();
      expect(gate.state.error).toBe('API unavailable');
      expect(gate.state.isLoading).toBe(false);
    });
  });

  describe('recheck()', () => {
    it('is an alias for check()', async () => {
      const gate = new EntitlementGate(sdk, { handle: 'brand_kit' });
      await gate.recheck();

      expect(sdk.checkEntitlement).toHaveBeenCalledTimes(1);
    });
  });

  describe('onChange()', () => {
    it('notifies listeners on check', async () => {
      const gate = new EntitlementGate(sdk, { handle: 'brand_kit' });
      const listener = vi.fn();
      gate.onChange(listener);

      await gate.check();

      // Called twice: isLoading=true then isLoading=false
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('unsubscribes correctly', async () => {
      const gate = new EntitlementGate(sdk, { handle: 'brand_kit' });
      const listener = vi.fn();
      const unsub = gate.onChange(listener);
      unsub();

      await gate.check();

      expect(listener).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
//  SdkSession
// ---------------------------------------------------------------------------

describe('SdkSession', () => {
  let sdk: ReturnType<typeof createMockSdk>;
  let session: SdkSession;

  beforeEach(() => {
    sdk = createMockSdk();
    session = new SdkSession(sdk, { colors: {}, typography: {} } as any);
  });

  describe('user context', () => {
    it('delegates identify() to SDK', () => {
      session.identify('user_2', { plan: { id: 'pro' } } as any);
      expect(sdk.identify).toHaveBeenCalledWith('user_2', { plan: { id: 'pro' } });
    });

    it('delegates resetIdentity() to SDK', () => {
      session.resetIdentity();
      expect(sdk.resetIdentity).toHaveBeenCalled();
    });

    it('delegates setUserContext() to SDK', () => {
      const ctx = { personalization: { company: 'Acme' } } as any;
      session.setUserContext(ctx);
      expect(sdk.setUserContext).toHaveBeenCalledWith(ctx);
    });

    it('delegates getUserContext() to SDK', () => {
      session.getUserContext();
      expect(sdk.getUserContext).toHaveBeenCalled();
    });

    it('delegates updateUsage() to SDK', () => {
      session.updateUsage({ api_calls: 5 });
      expect(sdk.updateUsage).toHaveBeenCalledWith({ api_calls: 5 });
    });

    it('delegates fetchUserContext() to SDK', async () => {
      await session.fetchUserContext('user_2');
      expect(sdk.fetchUserContext).toHaveBeenCalledWith('user_2');
    });

    it('delegates getTrialStatus() to SDK', async () => {
      await session.getTrialStatus();
      expect(sdk.getTrialStatus).toHaveBeenCalled();
    });

    it('delegates getUsage() to SDK', () => {
      session.getUsage();
      expect(sdk.getUsage).toHaveBeenCalled();
    });
  });

  describe('placement()', () => {
    it('returns a PlacementController bound to the session SDK', async () => {
      const ctrl = session.placement({ surfaceSlot: { id: 'slot_1', name: 'slot_1' } });
      expect(ctrl).toBeInstanceOf(PlacementController);

      await ctrl.load();
      expect(sdk.registerSurfaceSlot).toHaveBeenCalled();
    });
  });

  describe('getPlacementBySlotId()', () => {
    it('creates a controller and loads by slot ID', async () => {
      const decision = await session.getPlacementBySlotId('pricing_banner');
      expect(sdk.registerSurfaceSlot).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'pricing_banner' }),
      );
      expect(decision?.visible).toBe(true);
    });

    it('passes additional options through', async () => {
      await session.getPlacementBySlotId('banner', { userId: 'user_x', ttlMs: 3000 });
      expect(sdk.getPlacementDecision).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user_x', ttlMs: 3000 }),
      );
    });
  });

  describe('getPlacement()', () => {
    it('delegates to SDK getPlacement()', async () => {
      await session.getPlacement({ slotId: 'slot_1' });
      expect(sdk.getPlacement).toHaveBeenCalledWith({ slotId: 'slot_1' });
    });
  });

  describe('entitlement()', () => {
    it('returns an EntitlementGate bound to the session SDK', async () => {
      const gate = session.entitlement({ handle: 'brand_kit' });
      expect(gate).toBeInstanceOf(EntitlementGate);

      await gate.check();
      expect(sdk.checkEntitlement).toHaveBeenCalledWith('brand_kit', undefined);
    });
  });

  describe('checkEntitlement()', () => {
    it('delegates to SDK checkEntitlement()', async () => {
      await session.checkEntitlement('feature_x');
      expect(sdk.checkEntitlement).toHaveBeenCalledWith('feature_x', undefined);
    });
  });

  describe('trackEvent()', () => {
    it('delegates to SDK trackEvent()', async () => {
      await session.trackEvent('button_clicked', { target: 'cta_1' } as any);
      expect(sdk.trackEvent).toHaveBeenCalledWith('button_clicked', { target: 'cta_1' });
    });
  });
});
