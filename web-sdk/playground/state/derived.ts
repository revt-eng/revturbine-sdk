import type { ExportedConfig } from '@revt-eng/schema';
import type { PrismPlanHandle } from './demo-state';

const PLAN_ID_BY_HANDLE: Record<PrismPlanHandle, string> = {
  free: 'plan_prism_free',
  pro: 'plan_prism_pro',
  enterprise: 'plan_prism_enterprise',
};

function entitlementId(config: ExportedConfig, handle: string): string | undefined {
  return config.entitlements.find((e) => e.unique_handle === handle)?.id;
}

/** Find the `type_fields` of the rule binding `entitlementHandle` to `planHandle`. */
function ruleTypeFields(
  config: ExportedConfig,
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
export function planName(config: ExportedConfig, planHandle: PrismPlanHandle): string {
  return config.plans.find((p) => p.unique_handle === planHandle)?.name ?? planHandle;
}

/** Monthly generations limit for a plan, derived from the config rule. */
export function generationsLimitFor(config: ExportedConfig, planHandle: PrismPlanHandle): number {
  return numberField(ruleTypeFields(config, 'generations', planHandle), 'limit_value') ?? 30;
}

/** Style-credit allowance for a plan, derived from the config rule. */
export function creditAllowanceFor(config: ExportedConfig, planHandle: PrismPlanHandle): number {
  const fields = ruleTypeFields(config, 'credits', planHandle);
  return numberField(fields, 'initial_grant') ?? numberField(fields, 'allowance') ?? 0;
}

/** Generations-per-minute burst limit for a plan, derived from the config rule. */
export function burstRateFor(config: ExportedConfig, planHandle: PrismPlanHandle): number {
  return numberField(ruleTypeFields(config, 'burst_rate', planHandle), 'rate_value') ?? 3;
}

/** Max team seats for a plan, derived from the config seat rule. */
export function seatLimitFor(config: ExportedConfig, planHandle: PrismPlanHandle): number {
  return numberField(ruleTypeFields(config, 'seats', planHandle), 'max_seats') ?? 1;
}

/**
 * Per-image overage price for a plan, derived from the `price_per_unit`
 * entitlement rule (`generation_overage`). Returns null for plans without an
 * overage rule (e.g. Free, which hard-blocks at the cap).
 */
export function overagePriceFor(
  config: ExportedConfig,
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
  config: ExportedConfig,
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
