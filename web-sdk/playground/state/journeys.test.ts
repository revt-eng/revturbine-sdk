import { describe, expect, it } from 'vitest';
import { ExportedConfigSchema } from '@revt-eng/schema';
import rawConfig from '../config/prism-export-config.json';
import { activeNudges } from './active-nudges';
import { pickSmartRail } from './smart-rail';
import { JOURNEY_SETS, allJourneys, findJourney } from './journeys';
import { DEFAULT_DEMO_STATE } from './demo-state';

const PRISM_CONFIG = ExportedConfigSchema.parse(rawConfig);
const nudgeIds = (id: string) => activeNudges(PRISM_CONFIG, findJourney(id)!.state).map((n) => n.placementId);
const railId = (id: string) => pickSmartRail(PRISM_CONFIG, findJourney(id)!.state).placementId;

/**
 * Plan 81 TASK-6 / AC-8: each built-in journey must land the simulated user on
 * the placement it advertises. Usage / credit / trial-proximity journeys now
 * resolve through the smart rail (pickSmartRail); reverse-trial / retention /
 * conversion journeys still resolve through the nudge host (activeNudges).
 */
describe('the baseline journey is the single canonical start state', () => {
  // App start (JourneyManager opens on the 'baseline' journey), Reset
  // (DEFAULT_DEMO_STATE), and selecting "New free user" must all land on the
  // SAME state. Guard against the three drifting apart (e.g. a default change
  // that misses the journey JSON).
  it('matches DEFAULT_DEMO_STATE exactly', () => {
    expect(findJourney('baseline')!.state).toEqual(DEFAULT_DEMO_STATE);
  });
});

describe('built-in journeys', () => {
  // Journeys whose advertised surface lives in the smart rail.
  const EXPECTED_RAIL: Record<string, string> = {
    usage_cap: 'pl_usage_80',
    out_of_generations: 'pl_usage_100',
    credits_low: 'pl_credit_low',
    trial_ending: 'pl_trial_ending',
  };
  // Journeys whose advertised surface lives in the nudge host.
  const EXPECTED_NUDGE: Record<string, string> = {
    reverse_trial: 'pl_reverse_trial',
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

  for (const [journeyId, placementId] of Object.entries(EXPECTED_RAIL)) {
    it(`"${journeyId}" surfaces ${placementId} in the smart rail`, () => {
      expect(railId(journeyId)).toBe(placementId);
    });
  }

  for (const [journeyId, placementId] of Object.entries(EXPECTED_NUDGE)) {
    it(`"${journeyId}" fires ${placementId}`, () => {
      expect(nudgeIds(journeyId)).toContain(placementId);
    });
  }

  it('"baseline" is clean — Explore-Pro default, no warning nudge', () => {
    expect(pickSmartRail(PRISM_CONFIG, findJourney('baseline')!.state).kind).toBe('explore');
    const ids = nudgeIds('baseline');
    for (const noisy of ['pl_reverse_trial', 'pl_payment_recovery', 'pl_seat_limit', 'pl_annual_nudge']) {
      expect(ids, `baseline unexpectedly fired ${noisy}`).not.toContain(noisy);
    }
  });
});
