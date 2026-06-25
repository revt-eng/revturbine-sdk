import type { ExportedConfig } from '@revt-eng/schema';
import type { DemoState } from './demo-state';
import { creditAllowanceFor, effectivePlanHandle, generationsLimitFor } from './derived';

/** Which dimension the smart rail is surfacing (or the default upsell). */
export type SmartRailKind = 'usage' | 'credit' | 'trial' | 'explore';

export interface SmartRailPick {
  kind: SmartRailKind;
  /** The Prism placement whose authored copy + CTA + trace this card uses. */
  placementId: string;
  /** 0..100+ closeness to the limit; higher = more urgent (matches the engine). */
  proximity: number;
  /** Counter display (usage/credit only). */
  used?: number;
  limit?: number;
  /** True when a paid plan is past its included allowance (billed overage). */
  overage?: boolean;
  /** Trial display. */
  daysRemaining?: number;
  /** The plan the user is on — lets the default Explore card upsell the *next* tier. */
  plan?: DemoState['planHandle'];
}

/** The warning band — a dimension only surfaces once it crosses this. */
export const WARNING_AT = 80;

/**
 * Decide the single card the smart rail shows. The usage / credit / trial
 * "counters" only become candidates once they cross the warning band (so a
 * user is never nagged while there's headroom); the most urgent one — highest
 * proximity to its limit — wins. With nothing near a limit, the Explore-Pro
 * card (a category-4 conversion placement) shows as the gentle default.
 *
 * This mirrors the engine's own ranking (resolveLocalPlacementFromCandidates:
 * usage/credit/trial is one category, sorted by proximity, and beats the
 * conversion category). The app owns live usage, so it computes proximity here
 * and asks the SDK to render the winner — the realistic local-runtime pattern.
 */
export function pickSmartRail(config: ExportedConfig, state: DemoState): SmartRailPick {
  const candidates: SmartRailPick[] = [];

  // Usage (generations). A reverse trial lifts the cap to the premium plan's,
  // so meter against the effective plan (matches what StudioProvider allows).
  const paid = state.planHandle !== 'free';
  const usageLimit = generationsLimitFor(config, effectivePlanHandle(state));
  const usagePct = usageLimit > 0 ? Math.round((state.generationsUsed / usageLimit) * 100) : 0;
  if (usagePct >= WARNING_AT) {
    const overage = paid && state.generationsUsed > usageLimit;
    candidates.push({
      kind: 'usage',
      placementId: overage
        ? 'pl_overage_active'
        : paid
          ? 'pl_usage_80_pro'
          : usagePct >= 100
            ? 'pl_usage_100'
            : 'pl_usage_80',
      proximity: usagePct,
      used: state.generationsUsed,
      limit: usageLimit,
      overage,
    });
  }

  // Style credits (consumed against the grant/allowance).
  const creditLimit = creditAllowanceFor(config, state.planHandle);
  const creditConsumed = Math.max(0, creditLimit - state.creditBalance);
  const creditPct = creditLimit > 0 ? Math.round((creditConsumed / creditLimit) * 100) : 0;
  if (creditPct >= WARNING_AT) {
    candidates.push({
      kind: 'credit',
      placementId:
        creditPct >= 100
          ? paid
            ? 'pl_credit_out_pro'
            : 'pl_credit_out'
          : paid
            ? 'pl_credit_low_pro'
            : 'pl_credit_low',
      proximity: creditPct,
      used: creditConsumed,
      limit: creditLimit,
    });
  }

  // Free trial nearing its end (reverse trials are a positive banner, not a
  // proximity warning, so they stay in the main nudge host).
  if (state.trial.inTrial && state.trial.trialType === 'free' && state.trial.daysRemaining <= 3) {
    const total = state.trial.dayNumber + state.trial.daysRemaining;
    const elapsedPct = total > 0 ? Math.round((state.trial.dayNumber / total) * 100) : 0;
    candidates.push({
      kind: 'trial',
      placementId: 'pl_trial_ending',
      proximity: elapsedPct,
      daysRemaining: state.trial.daysRemaining,
    });
  }

  if (candidates.length === 0) {
    return { kind: 'explore', placementId: 'pl_sidebar_engagement', proximity: 0, plan: state.planHandle };
  }
  candidates.sort((a, b) => b.proximity - a.proximity);
  return { ...candidates[0], plan: state.planHandle };
}
