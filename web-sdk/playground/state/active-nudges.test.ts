import { describe, expect, it } from 'vitest';
// Parse the raw JSON with the bare-aliased schema rather than importing
// PRISM_CONFIG from prism-config.ts: the latter pulls in `@revt-eng/schema/zod`,
// a subpath the vitest alias does not rewrite (see prism-export-config.test.ts).
import { ExportedConfigSchema } from '@revt-eng/schema';
import rawConfig from '../config/prism-export-config.json';
import { DEFAULT_DEMO_STATE, type DemoState } from './demo-state';
import { activeNudges, gatePlacementForHandle, interpolate } from './active-nudges';

const PRISM_CONFIG = ExportedConfigSchema.parse(rawConfig);

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

  it('fires the right generations tier (50 / 80 / 100%)', () => {
    // limit = 30 for free.
    expect(ids(free({ generationsUsed: 10 }))).not.toContain('pl_usage_50'); // 33%
    expect(ids(free({ generationsUsed: 15 }))).toContain('pl_usage_50'); // 50%
    expect(ids(free({ generationsUsed: 24 }))).toContain('pl_usage_80'); // 80%
    expect(ids(free({ generationsUsed: 30 }))).toContain('pl_usage_100'); // 100%
    // Only the highest crossed tier shows.
    const at100 = ids(free({ generationsUsed: 30 }));
    expect(at100).not.toContain('pl_usage_50');
    expect(at100).not.toContain('pl_usage_80');
  });

  it('renders the usage-exhausted tier as a modal, warnings as toasts', () => {
    const nudges = activeNudges(PRISM_CONFIG, free({ generationsUsed: 30 }));
    expect(nudges.find((n) => n.placementId === 'pl_usage_100')?.surface).toBe('modal');
    const warn = activeNudges(PRISM_CONFIG, free({ generationsUsed: 24 }));
    expect(warn.find((n) => n.placementId === 'pl_usage_80')?.surface).toBe('toast');
  });

  it('fires credit nudges by remaining balance (allowance 20)', () => {
    expect(ids(free({ creditBalance: 20 }))).not.toContain('pl_credit_low'); // 0% used
    expect(ids(free({ creditBalance: 3 }))).toContain('pl_credit_low'); // 85% used → banner
    expect(activeNudges(PRISM_CONFIG, free({ creditBalance: 3 })).find((n) => n.placementId === 'pl_credit_low')?.surface).toBe('banner');
    expect(ids(free({ creditBalance: 0 }))).toContain('pl_credit_out'); // exhausted → modal
    expect(activeNudges(PRISM_CONFIG, free({ creditBalance: 0 })).find((n) => n.placementId === 'pl_credit_out')?.surface).toBe('modal');
  });

  it('fires the annual qualifier only for monthly Pro', () => {
    const monthlyPro: DemoState = { ...DEFAULT_DEMO_STATE, planHandle: 'pro', custom: { ...DEFAULT_DEMO_STATE.custom, billing_period: 'monthly' } };
    const annualPro: DemoState = { ...DEFAULT_DEMO_STATE, planHandle: 'pro', custom: { ...DEFAULT_DEMO_STATE.custom, billing_period: 'annual' } };
    expect(ids(monthlyPro)).toContain('pl_annual_nudge');
    expect(ids(annualPro)).not.toContain('pl_annual_nudge');
  });

  it('shows no free-plan nudges once upgraded to Pro', () => {
    const pro: DemoState = { ...DEFAULT_DEMO_STATE, planHandle: 'pro', generationsUsed: 30, creditBalance: 0 };
    const got = ids(pro);
    for (const free of ['pl_usage_100', 'pl_credit_out', 'pl_gate_watermark']) {
      expect(got).not.toContain(free);
    }
  });

  it('supplies personalization tokens for the usage meter', () => {
    const n = activeNudges(PRISM_CONFIG, free({ generationsUsed: 24 })).find((x) => x.placementId === 'pl_usage_80');
    expect(n?.tokens.usage_remaining).toBe('6');
    expect(n?.tokens.usage_limit).toBe('30');
    expect(n?.tokens.usage_percent).toBe('80');
  });
});

describe('activeNudges — breadth (trials / retention / seat)', () => {
  it('fires the seat-limit nudge for a Free user at their seat cap', () => {
    expect(ids(free({ seatsUsed: 1 }))).toContain('pl_seat_limit'); // free cap = 1
    expect(ids(free({ seatsUsed: 0 }))).not.toContain('pl_seat_limit');
    // Pro includes 5 seats — 1 used is well under the cap.
    const pro: DemoState = { ...DEFAULT_DEMO_STATE, planHandle: 'pro', seatsUsed: 1 };
    expect(ids(pro)).not.toContain('pl_seat_limit');
  });

  it('fires the reverse-trial banner while a reverse trial is active', () => {
    const reverse = free({ trial: { inTrial: true, trialType: 'reverse', dayNumber: 2, daysRemaining: 5 } });
    expect(ids(reverse)).toContain('pl_reverse_trial');
    expect(ids(reverse)).not.toContain('pl_trial_ending');
  });

  it('fires the trial-ending banner near the end of a free trial', () => {
    const ending = free({ trial: { inTrial: true, trialType: 'free', dayNumber: 5, daysRemaining: 2 } });
    expect(ids(ending)).toContain('pl_trial_ending');
    const early = free({ trial: { inTrial: true, trialType: 'free', dayNumber: 1, daysRemaining: 6 } });
    expect(ids(early)).not.toContain('pl_trial_ending');
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
    expect(gatePlacementForHandle('unknown')).toBeNull();
  });
});

describe('interpolate', () => {
  it('replaces known tokens and leaves unknown ones intact', () => {
    expect(interpolate('{{usage_remaining}}/{{usage_limit}} left', { usage_remaining: '6', usage_limit: '30' })).toBe('6/30 left');
    expect(interpolate('hi {{missing}}', {})).toBe('hi {{missing}}');
  });
});
