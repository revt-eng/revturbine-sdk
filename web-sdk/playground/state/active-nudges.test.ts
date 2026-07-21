import { describe, expect, it } from 'vitest';
// Parse the raw JSON with the package's public schema export rather than
// importing the playground's configured singleton.
import { RevTurbineConfigSchema } from '@revt-eng/schema';
import rawConfig from '../config/prism-export-config.json';
import { DEFAULT_DEMO_STATE, type DemoState } from './demo-state';
import { activeNudges, gatePlacementForHandle, interpolate } from './active-nudges';

const PRISM_CONFIG = RevTurbineConfigSchema.parse(rawConfig);

/**
 * Guards plan 81 TASK-3 / AC-2: the playground (standing in for the customer
 * app that owns usage tracking) must pick the correct threshold / qualifier /
 * inline-gate placement for a given simulated state, since the local-runtime
 * resolver does not evaluate threshold_percent itself.
 */
const free = (over: Partial<DemoState> = {}): DemoState => ({ ...DEFAULT_DEMO_STATE, planHandle: 'free', ...over });
const ids = (s: DemoState) => activeNudges(PRISM_CONFIG, s).map((n) => n.placementId);

describe('activeNudges', () => {
  it('shows the watermark inline gate to every free user', () => {
    expect(ids(free({ generationsUsed: 0, creditBalance: 20 }))).toContain('pl_gate_watermark');
  });

  it('no longer fires usage or credit warnings (moved to the smart rail)', () => {
    // Usage + credit proximity warnings are owned by pickSmartRail now.
    expect(ids(free({ generationsUsed: 30 }))).not.toContain('pl_usage_100');
    expect(ids(free({ generationsUsed: 24 }))).not.toContain('pl_usage_80');
    expect(ids(free({ creditBalance: 0 }))).not.toContain('pl_credit_out');
    expect(ids(free({ creditBalance: 3 }))).not.toContain('pl_credit_low');
  });

  it('fires the annual qualifier only for monthly Pro', () => {
    const monthlyPro: DemoState = { ...DEFAULT_DEMO_STATE, planHandle: 'pro', custom: { ...DEFAULT_DEMO_STATE.custom, billing_period: 'monthly' } };
    const annualPro: DemoState = { ...DEFAULT_DEMO_STATE, planHandle: 'pro', custom: { ...DEFAULT_DEMO_STATE.custom, billing_period: 'annual' } };
    expect(ids(monthlyPro)).toContain('pl_annual_nudge');
    expect(ids(annualPro)).not.toContain('pl_annual_nudge');
  });

  it('does not stack the annual nudge on top of an active trial', () => {
    const monthlyProInTrial: DemoState = {
      ...DEFAULT_DEMO_STATE,
      planHandle: 'pro',
      custom: { ...DEFAULT_DEMO_STATE.custom, billing_period: 'monthly' },
      trial: { inTrial: true, trialType: 'reverse', dayNumber: 0, daysRemaining: 7 },
    };
    expect(ids(monthlyProInTrial)).toContain('pl_reverse_trial');
    expect(ids(monthlyProInTrial)).not.toContain('pl_annual_nudge');
  });

  it('shows no free-plan nudges once upgraded to Pro', () => {
    const pro: DemoState = { ...DEFAULT_DEMO_STATE, planHandle: 'pro', generationsUsed: 30, creditBalance: 0 };
    const got = ids(pro);
    for (const free of ['pl_usage_100', 'pl_credit_out', 'pl_gate_watermark']) {
      expect(got).not.toContain(free);
    }
  });

});

describe('activeNudges — breadth (trials / retention / seat)', () => {
  it('fires the seat-limit nudge on any plan at its seat cap', () => {
    expect(ids(free({ seatsUsed: 1 }))).toContain('pl_seat_limit'); // free cap = 1
    expect(ids(free({ seatsUsed: 0 }))).not.toContain('pl_seat_limit');
    // Pro includes 5 seats — under the cap is quiet, at the cap fires the Pro
    // seat placement.
    const pro = (n: number): DemoState => ({ ...DEFAULT_DEMO_STATE, planHandle: 'pro', seatsUsed: n });
    expect(ids(pro(1))).not.toContain('pl_seat_limit_pro');
    expect(ids(pro(5))).toContain('pl_seat_limit_pro');
    // Enterprise is effectively unlimited — never fires.
    expect(ids({ ...DEFAULT_DEMO_STATE, planHandle: 'enterprise', seatsUsed: 50 })).not.toContain('pl_seat_limit');
  });

  it('fires the reverse-trial banner while a reverse trial is active', () => {
    const reverse = free({ trial: { inTrial: true, trialType: 'reverse', dayNumber: 2, daysRemaining: 5 } });
    expect(ids(reverse)).toContain('pl_reverse_trial');
    expect(ids(reverse)).not.toContain('pl_trial_ending');
  });

  it('counts the reverse trial down off days_since_signup, escalates to a modal, then retires', () => {
    const onReverse = (daysSinceSignup: number) =>
      free({
        custom: { ...DEFAULT_DEMO_STATE.custom, days_since_signup: daysSinceSignup },
        trial: { inTrial: true, trialType: 'reverse', dayNumber: 0, daysRemaining: 7 },
      });
    const find = (s: DemoState, id: string) => activeNudges(PRISM_CONFIG, s).find((n) => n.placementId === id);
    // Early (day 2): ambient banner, 5 of 7 days remaining.
    expect(find(onReverse(2), 'pl_reverse_trial')?.tokens.days_remaining).toBe('5');
    expect(find(onReverse(2), 'pl_trial_ending')).toBeUndefined();
    // From the prompt day (5): escalates to a conversion modal.
    const day5 = find(onReverse(5), 'pl_trial_ending');
    expect(day5?.surface).toBe('modal');
    expect(day5?.tokens.days_remaining).toBe('2');
    expect(find(onReverse(5), 'pl_reverse_trial')).toBeUndefined();
    expect(find(onReverse(6), 'pl_trial_ending')?.tokens.days_remaining).toBe('1');
    // Past the 7-day window → nothing.
    expect(activeNudges(PRISM_CONFIG, onReverse(7)).map((n) => n.placementId)).not.toContain('pl_trial_ending');
    expect(activeNudges(PRISM_CONFIG, onReverse(7)).map((n) => n.placementId)).not.toContain('pl_reverse_trial');
  });

  it('no longer fires the free-trial-ending warning (moved to the smart rail)', () => {
    const ending = free({ trial: { inTrial: true, trialType: 'free', dayNumber: 5, daysRemaining: 2 } });
    expect(ids(ending)).not.toContain('pl_trial_ending');
  });

  it('shows one winning banner when several qualify (competition, not stacking)', () => {
    // Billing failed (payment banner) AND at the seat cap (seat banner) — only
    // the higher-priority payment-recovery banner survives.
    const both = free({
      seatsUsed: 1,
      custom: { ...DEFAULT_DEMO_STATE.custom, billing_status: 'failed' },
    });
    const banners = activeNudges(PRISM_CONFIG, both).filter((n) => n.surface === 'banner');
    expect(banners).toHaveLength(1);
    expect(banners[0].placementId).toBe('pl_payment_recovery');
    // The inline watermark notice is unaffected by banner competition.
    expect(ids(both)).toContain('pl_gate_watermark');
  });

  it('fires payment recovery only when billing has failed', () => {
    expect(ids(free({ custom: { ...DEFAULT_DEMO_STATE.custom, billing_status: 'failed' } }))).toContain('pl_payment_recovery');
    expect(ids(free({ custom: { ...DEFAULT_DEMO_STATE.custom, billing_status: 'ok' } }))).not.toContain('pl_payment_recovery');
  });
});

describe('gatePlacementForHandle', () => {
  it('maps gated feature handles to their gate modals', () => {
    expect(gatePlacementForHandle('batch_export')).toBe('pl_gate_batch_export');
    expect(gatePlacementForHandle('style_packs')).toBe('pl_gate_style_packs');
    expect(gatePlacementForHandle('burst_rate')).toBe('pl_rate_limit');
    expect(gatePlacementForHandle('unknown')).toBeNull();
  });

  it('maps usage/credit exhaustion to a blocking gate (plan-aware)', () => {
    // Hitting the generation cap (Free hard-blocks; paid plans run into overage).
    expect(gatePlacementForHandle('generations', 'free')).toBe('pl_usage_100');
    // Running out of style credits — Free vs the paid variant.
    expect(gatePlacementForHandle('credits', 'free')).toBe('pl_credit_out');
    expect(gatePlacementForHandle('credits', 'pro')).toBe('pl_credit_out_pro');
  });
});

describe('interpolate', () => {
  it('replaces known tokens and leaves unknown ones intact', () => {
    expect(interpolate('{{usage_remaining}}/{{usage_limit}} left', { usage_remaining: '6', usage_limit: '30' })).toBe('6/30 left');
    expect(interpolate('hi {{missing}}', {})).toBe('hi {{missing}}');
  });
});
