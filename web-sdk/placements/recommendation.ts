/**
 * Per-placement plan-recommendation token resolution (plan #47).
 *
 * Resolves the `{{recommended_plan_handle}}` / `{{recommended_plan_name}}`
 * personalization tokens for a single placement, dispatching on that
 * placement's authored `recommendation_strategy` (Appendix C.3):
 *
 *  - `next_tier_up` (default) — the next plan up the tier hierarchy, via the
 *    shared `recommendNextPlanUp` helper. Unchanged from plan #46.
 *  - `custom` — a PM-forced plan, looked up by `unique_handle` from the
 *    authored `recommendation_plan_override`.
 *  - `best_value` — reserved for a future scoring model; until it ships this
 *    falls back to `next_tier_up` so authored Best-Value placements degrade
 *    gracefully rather than rendering empty.
 *
 * This module is the single source of truth for the dispatch and is
 * cross-language parity-locked: `server-python`'s
 * `revturbine.core.helpers.resolve_recommended_plan_tokens` mirrors it
 * byte-for-byte (see `tests/parity/fixtures/plan_recommendation_custom_*`).
 * Matching uses exact `unique_handle` comparison, identical to
 * `recommendNextPlanUp`, so callers must pass already-normalized handles.
 */
import { recommendNextPlanUp } from '@revt-eng/core';

/** The spec-defined per-placement recommendation strategy. */
export type RecommendationStrategy = 'next_tier_up' | 'best_value' | 'custom';

/** Minimal plan shape the dispatcher reads (mirrors `PlanIR`). */
export interface RecommendationPlanInput {
  source_id: string;
  unique_handle: string;
  name: string;
  tier_position: number;
  sort_order: number;
}

/** The resolved recommendation tokens. Empty strings when unresolved. */
export interface RecommendedPlanTokens {
  recommended_plan_handle: string;
  recommended_plan_name: string;
}

const EMPTY: RecommendedPlanTokens = {
  recommended_plan_handle: '',
  recommended_plan_name: '',
};

/**
 * Resolve the recommended-plan tokens for one placement by strategy.
 *
 * Edge cases all resolve to empty tokens (the top-of-ladder convention from
 * plan #46): empty plan list, unknown current plan, top of the hierarchy,
 * and — for `custom` — a missing/unknown override or an override equal to the
 * user's current plan.
 *
 * @param input.strategy            The placement's `recommendation_strategy`.
 * @param input.planOverride        The `unique_handle` to force (only read when `strategy === 'custom'`).
 * @param input.currentPlanHandle   The user's current commercial plan handle (already normalized by the caller).
 * @param input.plans               The tenant's plan hierarchy.
 */
export function resolveRecommendedPlanTokens(input: {
  strategy: RecommendationStrategy;
  planOverride?: string;
  currentPlanHandle: string;
  plans: readonly RecommendationPlanInput[];
}): RecommendedPlanTokens {
  const { strategy, planOverride, currentPlanHandle, plans } = input;
  if (plans.length === 0) return EMPTY;

  if (strategy === 'custom') {
    const override = planOverride ?? '';
    if (override === '' || override === currentPlanHandle) return EMPTY;
    const plan = plans.find((p) => p.unique_handle === override);
    if (!plan) return EMPTY;
    return { recommended_plan_handle: plan.unique_handle, recommended_plan_name: plan.name };
  }

  // 'next_tier_up' (default) and 'best_value' both resolve via the plan
  // hierarchy. best_value falls back here until its scoring model ships.
  // TODO(plan #48): Best Value scoring model — entitlement-value weights.
  if (currentPlanHandle === '') return EMPTY;
  const nextHandle = recommendNextPlanUp(currentPlanHandle, plans);
  if (nextHandle === null) return EMPTY;
  const next = plans.find((p) => p.unique_handle === nextHandle);
  return {
    recommended_plan_handle: nextHandle,
    recommended_plan_name: next?.name ?? nextHandle,
  };
}
