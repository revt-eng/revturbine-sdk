import type { RevTurbineConfig } from '@revt-eng/schema';
import type { DemoState, PrismPlanHandle } from './demo-state';

/**
 * The plan whose *limits* apply right now. A reverse trial grants the premium
 * plan's entitlements (config `reverse_trial_rules.premium_plan_id` = "pro")
 * without changing the user's plan, so for limit purposes — the usage cap and
 * rate limit — the user is effectively on Pro while the reverse trial is active.
 * Credits and seats are not part of the trial grant, so callers that meter those
 * keep using `state.planHandle`.
 *
 * NOTE: this is a playground convenience. A real customer app should read the
 * effective entitlements from the SDK rather than recompute them here — see the
 * abstraction to-do in the Prism project notes.
 */
export function effectivePlanHandle(state: DemoState): PrismPlanHandle {
  if (state.trial.inTrial && state.trial.trialType === 'reverse') return 'pro';
  return state.planHandle;
}

const PLAN_ID_BY_HANDLE: Record<PrismPlanHandle, string> = {
  free: 'plan_prism_free',
  pro: 'plan_prism_pro',
  enterprise: 'plan_prism_enterprise',
};

function entitlementId(config: RevTurbineConfig, handle: string): string | undefined {
  return config.entitlements.find((e) => e.unique_handle === handle)?.id;
}

/** Find the `type_fields` of the rule binding `entitlementHandle` to `planHandle`. */
function ruleTypeFields(
  config: RevTurbineConfig,
  entitlementHandle: string,
  planHandle: PrismPlanHandle,
): Record<string, unknown> | undefined {
  const entId = entitlementId(config, entitlementHandle);
  if (!entId) return undefined;
  const planId = PLAN_ID_BY_HANDLE[planHandle];
  const rule = config.entitlement_rules.find(
    (r) => r.entitlement_id === entId && r.targets.some((t) => t.kind === 'plan' && t.id === planId),
  );
  return rule?.type_fields;
}

function numberField(fields: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = fields?.[key];
  return typeof value === 'number' ? value : undefined;
}

/** Customer-facing plan name for a handle (e.g. `free` → "Free"). */
export function planName(config: RevTurbineConfig, planHandle: PrismPlanHandle): string {
  return config.plans.find((p) => p.unique_handle === planHandle)?.name ?? planHandle;
}

/** Monthly generations limit for a plan, derived from the config rule. */
export function generationsLimitFor(config: RevTurbineConfig, planHandle: PrismPlanHandle): number {
  return numberField(ruleTypeFields(config, 'generations', planHandle), 'limit_value') ?? 30;
}

/** Style-credit allowance for a plan, derived from the config rule. */
export function creditAllowanceFor(config: RevTurbineConfig, planHandle: PrismPlanHandle): number {
  const fields = ruleTypeFields(config, 'credits', planHandle);
  return numberField(fields, 'initial_grant') ?? numberField(fields, 'allowance') ?? 0;
}

/** Generations-per-minute burst limit for a plan, derived from the config rule. */
export function burstRateFor(config: RevTurbineConfig, planHandle: PrismPlanHandle): number {
  return numberField(ruleTypeFields(config, 'burst_rate', planHandle), 'rate_value') ?? 3;
}

/** Max team seats for a plan, derived from the config seat rule. */
export function seatLimitFor(config: RevTurbineConfig, planHandle: PrismPlanHandle): number {
  return numberField(ruleTypeFields(config, 'seats', planHandle), 'max_seats') ?? 1;
}

/**
 * Per-image overage price for a plan, derived from the `price_per_unit`
 * entitlement rule (`generation_overage`). Returns null for plans without an
 * overage rule (e.g. Free, which hard-blocks at the cap).
 */
export function overagePriceFor(
  config: RevTurbineConfig,
  planHandle: PrismPlanHandle,
): { amountCents: number; currency: string; unit: string } | null {
  const fields = ruleTypeFields(config, 'generation_overage', planHandle);
  const amountCents = numberField(fields, 'amount_cents');
  if (amountCents === undefined) return null;
  const currency = typeof fields?.currency === 'string' ? fields.currency : 'usd';
  const unit = typeof fields?.unit === 'string' ? fields.unit : 'unit';
  return { amountCents, currency, unit };
}

/**
 * The plan a placement recommends, resolving its payload `recommendation_strategy`
 * (`next_tier_up` | `best_value` | `custom`) against the current plan. Returns
 * null when the placement has no payload. Call this only for placements that
 * carry a deliberate recommendation (e.g. the out-of-generations modal).
 */
export function recommendedPlanName(
  config: RevTurbineConfig,
  placementId: string,
  currentPlanHandle: PrismPlanHandle,
): string | null {
  const payload = config.placements?.find((p) => p.id === placementId)?.payloads?.[0];
  if (!payload) return null;
  const strategy = payload.recommendation_strategy ?? 'next_tier_up';

  if (strategy === 'custom') {
    const overrideId = payload.recommendation_plan_override;
    return config.plans.find((p) => p.id === overrideId || p.unique_handle === overrideId)?.name ?? null;
  }
  if (strategy === 'best_value') {
    return config.plans.find((p) => p.unique_handle === 'pro')?.name ?? null;
  }
  // next_tier_up — the plan one position above the current one.
  const tierOf = (p: { tier_position?: number; sort_order?: number }) => p.tier_position ?? p.sort_order ?? 0;
  const current = config.plans.find((p) => p.unique_handle === currentPlanHandle);
  if (!current) return null;
  const next = config.plans
    .filter((p) => tierOf(p) > tierOf(current))
    .sort((a, b) => tierOf(a) - tierOf(b))[0];
  return next?.name ?? null;
}
