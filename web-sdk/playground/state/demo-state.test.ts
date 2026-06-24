import { describe, expect, it } from 'vitest';
import { DEFAULT_DEMO_STATE, resolutionKey, type DemoState } from './demo-state';

/**
 * Guards plan 81 TASK-2 / AC-1: every Director-controllable context dimension
 * must force the SDK subtree to re-resolve. The playground keys the
 * RevTurbineProvider on `resolutionKey`, so this asserts the key moves for each
 * dimension a control can change — and stays put for fields that don't affect
 * placement resolution (e.g. userId).
 */
describe('resolutionKey', () => {
  const base = DEFAULT_DEMO_STATE;
  const baseKey = resolutionKey(base);

  const mutations: Array<[string, DemoState]> = [
    ['plan', { ...base, planHandle: 'pro' }],
    ['generationsUsed', { ...base, generationsUsed: base.generationsUsed + 1 }],
    ['creditBalance', { ...base, creditBalance: base.creditBalance + 1 }],
    ['email_type', { ...base, custom: { ...base.custom, email_type: 'business' } }],
    ['engagement_score', { ...base, custom: { ...base.custom, engagement_score: 99 } }],
    ['days_since_signup', { ...base, custom: { ...base.custom, days_since_signup: 10 } }],
    ['days_since_active', { ...base, custom: { ...base.custom, days_since_active: 20 } }],
    ['has_purchased', { ...base, custom: { ...base.custom, has_purchased: true } }],
    ['billing_status', { ...base, custom: { ...base.custom, billing_status: 'failed' } }],
    ['billing_period', { ...base, custom: { ...base.custom, billing_period: 'annual' } }],
    ['trial.inTrial', { ...base, trial: { ...base.trial, inTrial: true } }],
    ['trial.trialType', { ...base, trial: { ...base.trial, trialType: 'reverse' } }],
    ['trial.dayNumber', { ...base, trial: { ...base.trial, dayNumber: 5 } }],
    ['trial.daysRemaining', { ...base, trial: { ...base.trial, daysRemaining: 5 } }],
  ];

  it.each(mutations)('changes when %s changes', (_label, mutated) => {
    expect(resolutionKey(mutated)).not.toBe(baseKey);
  });

  it('ignores fields that do not affect resolution (userId)', () => {
    expect(resolutionKey({ ...base, userId: 'someone-else' })).toBe(baseKey);
  });
});
