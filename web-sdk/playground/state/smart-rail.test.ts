import { describe, expect, it } from 'vitest';
import { ExportedConfigSchema } from '@revt-eng/schema';
import rawConfig from '../config/prism-export-config.json';
import { DEFAULT_DEMO_STATE, type DemoState } from './demo-state';
import { creditAllowanceFor } from './derived';
import { pickSmartRail } from './smart-rail';

const PRISM_CONFIG = ExportedConfigSchema.parse(rawConfig);
const free = (over: Partial<DemoState> = {}): DemoState => ({ ...DEFAULT_DEMO_STATE, planHandle: 'free', ...over });
const pick = (s: DemoState) => pickSmartRail(PRISM_CONFIG, s);

describe('pickSmartRail', () => {
  it('shows the Explore-Pro default when nothing is near a limit', () => {
    const p = pick(free({ generationsUsed: 5, creditBalance: 20 }));
    expect(p.kind).toBe('explore');
    expect(p.placementId).toBe('pl_sidebar_engagement');
  });

  it('carries the current plan on the Explore default so the card can upsell the next tier', () => {
    // Pro with headroom: still Explore, but the card should target Enterprise, not Pro.
    const proIdle: DemoState = { ...DEFAULT_DEMO_STATE, planHandle: 'pro', creditBalance: 1000 };
    const p = pick(proIdle);
    expect(p.kind).toBe('explore');
    expect(p.plan).toBe('pro');
    // Enterprise with headroom: Explore + enterprise → the rail hides this entirely.
    const ent: DemoState = { ...DEFAULT_DEMO_STATE, planHandle: 'enterprise', creditBalance: creditAllowanceFor(PRISM_CONFIG, 'enterprise') };
    expect(pick(ent).kind).toBe('explore');
    expect(pick(ent).plan).toBe('enterprise');
  });

  it('surfaces a usage warning once past 80% (limit 30)', () => {
    expect(pick(free({ generationsUsed: 20 })).kind).toBe('explore'); // 66% — quiet
    expect(pick(free({ generationsUsed: 24 })).placementId).toBe('pl_usage_80'); // 80%
    expect(pick(free({ generationsUsed: 30 })).placementId).toBe('pl_usage_100'); // 100%
  });

  it('surfaces a credit warning once 80% consumed (grant 20)', () => {
    expect(pick(free({ creditBalance: 20 })).kind).toBe('explore'); // 0% used
    expect(pick(free({ creditBalance: 3 })).placementId).toBe('pl_credit_low'); // 85% used
    expect(pick(free({ creditBalance: 0 })).placementId).toBe('pl_credit_out'); // exhausted
  });

  it('surfaces a free-trial-ending warning in the final days', () => {
    const ending = free({ trial: { inTrial: true, trialType: 'free', dayNumber: 5, daysRemaining: 2 } });
    expect(pick(ending).placementId).toBe('pl_trial_ending');
    const early = free({ trial: { inTrial: true, trialType: 'free', dayNumber: 1, daysRemaining: 6 } });
    expect(pick(early).kind).toBe('explore');
  });

  it('ranks the most urgent (closest to its limit) when several warn', () => {
    // usage 90% (27/30) vs credit 85% (3/20 left) — usage is closer, so it wins.
    const both = free({ generationsUsed: 27, creditBalance: 3 });
    expect(pick(both).kind).toBe('usage');
    // credit exhausted (100%) beats usage at 90%.
    const creditOut = free({ generationsUsed: 27, creditBalance: 0 });
    expect(pick(creditOut).kind).toBe('credit');
  });

  it('lifts the usage cap to Pro during a reverse trial', () => {
    // 40 generations is over Free's cap of 30 (would warn at 100%), but a
    // reverse trial grants Pro's 2,000 cap — so 40 is quiet.
    const reverse = free({
      generationsUsed: 40,
      trial: { inTrial: true, trialType: 'reverse', dayNumber: 0, daysRemaining: 7 },
    });
    expect(pick(reverse).kind).toBe('explore');
  });

  it('treats paid-plan over-limit usage as overage', () => {
    const proOverage: DemoState = { ...DEFAULT_DEMO_STATE, planHandle: 'pro', generationsUsed: 2050 };
    const p = pick(proOverage);
    expect(p.kind).toBe('usage');
    expect(p.overage).toBe(true);
    expect(p.placementId).toBe('pl_overage_active');
  });

  it('routes Pro warnings to the Pro-specific placements', () => {
    // Pro grants 1,000 credits on switch, so start full unless testing credits.
    const pro = (over: Partial<DemoState>): DemoState => ({
      ...DEFAULT_DEMO_STATE,
      planHandle: 'pro',
      creditBalance: 1000,
      ...over,
    });
    // 80% of 2,000 generations (not yet over the limit).
    expect(pick(pro({ generationsUsed: 1700 })).placementId).toBe('pl_usage_80_pro');
    // Credits: balance low against the 1,000 allowance.
    expect(pick(pro({ creditBalance: 50 })).placementId).toBe('pl_credit_low_pro');
    expect(pick(pro({ creditBalance: 0 })).placementId).toBe('pl_credit_out_pro');
  });
});
