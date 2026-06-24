import { describe, expect, it } from 'vitest';
import { ExportedConfigSchema } from '@revt-eng/schema';
import rawConfig from '../config/prism-export-config.json';
import { overagePriceFor, recommendedPlanName } from './derived';

const PRISM_CONFIG = ExportedConfigSchema.parse(rawConfig);

/** Plan 84 TASK-4/5: the price_per_unit overage helper + plan-recommendation helper. */
describe('overagePriceFor (price_per_unit)', () => {
  it('returns null for Free (hard-blocks at the cap, no overage rule)', () => {
    expect(overagePriceFor(PRISM_CONFIG, 'free')).toBeNull();
  });

  it('returns the per-image price for plans that allow overage', () => {
    expect(overagePriceFor(PRISM_CONFIG, 'pro')).toMatchObject({ amountCents: 5, currency: 'usd', unit: 'image' });
    expect(overagePriceFor(PRISM_CONFIG, 'enterprise')?.amountCents).toBe(3);
  });
});

describe('recommendedPlanName (recommendation_strategy)', () => {
  it('next_tier_up from Free recommends Pro on the out-of-generations modal', () => {
    expect(recommendedPlanName(PRISM_CONFIG, 'pl_usage_100', 'free')).toBe('Pro');
  });

  it('next_tier_up from Pro recommends Enterprise', () => {
    expect(recommendedPlanName(PRISM_CONFIG, 'pl_usage_100', 'pro')).toBe('Enterprise');
  });

  it('returns null for an unknown placement', () => {
    expect(recommendedPlanName(PRISM_CONFIG, 'pl_does_not_exist', 'free')).toBeNull();
  });
});
