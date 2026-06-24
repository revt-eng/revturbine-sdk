import { describe, expect, it } from 'vitest';
import { ExportedConfigSchema } from '@revt-eng/schema';
import rawConfig from '../config/prism-export-config.json';
import { activeNudges } from './active-nudges';
import { JOURNEY_SETS, allJourneys, findJourney } from './journeys';

const PRISM_CONFIG = ExportedConfigSchema.parse(rawConfig);
const nudgeIds = (id: string) => activeNudges(PRISM_CONFIG, findJourney(id)!.state).map((n) => n.placementId);

/**
 * Plan 81 TASK-6 / AC-8: each built-in journey must land the simulated user on
 * the placement it advertises. Plan 83 TASK-5: journeys now load from the
 * committed JSON sets, so this also asserts the built-in set parsed.
 */
describe('built-in journeys', () => {
  const EXPECTED: Record<string, string> = {
    usage_cap: 'pl_usage_80',
    out_of_generations: 'pl_usage_100',
    credits_low: 'pl_credit_low',
    reverse_trial: 'pl_reverse_trial',
    trial_ending: 'pl_trial_ending',
    payment_recovery: 'pl_payment_recovery',
    annual_upsell: 'pl_annual_nudge',
  };

  it('the built-in set loaded from JSON', () => {
    expect(JOURNEY_SETS.some((set) => set.id === 'built-in')).toBe(true);
  });

  it('every journey id is unique and resolvable', () => {
    const ids = allJourneys().map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findJourney('baseline')).toBeDefined();
  });

  for (const [journeyId, placementId] of Object.entries(EXPECTED)) {
    it(`"${journeyId}" fires ${placementId}`, () => {
      expect(nudgeIds(journeyId)).toContain(placementId);
    });
  }

  it('"baseline" is clean — no threshold/trial/payment/seat nudge', () => {
    const ids = nudgeIds('baseline');
    for (const noisy of ['pl_usage_50', 'pl_usage_80', 'pl_usage_100', 'pl_credit_low', 'pl_credit_out', 'pl_reverse_trial', 'pl_trial_ending', 'pl_payment_recovery', 'pl_seat_limit', 'pl_annual_nudge']) {
      expect(ids, `baseline unexpectedly fired ${noisy}`).not.toContain(noisy);
    }
  });
});
