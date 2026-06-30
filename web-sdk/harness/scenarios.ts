import type {
  PlacementOutput,
  RevTurbineEntitlementContext,
  RevTurbineLocalRuntimeData,
  RevTurbinePlacementRequestConfig,
  EntitlementStatus,
} from '../customer-side';

export type HarnessSlotId = string;

export interface HarnessSlotDescriptor {
  id: HarnessSlotId;
  label: string;
  description: string;
  surfaceType: PlacementOutput['surface']['type'];
  placementHandle: string;
  template?: string;
}

export const SURFACE_TYPES: PlacementOutput['surface']['type'][] = [
  'banner', 'modal', 'in_page', 'toast', 'button', 'full_page', 'cli',
];

export const HARNESS_SLOTS: HarnessSlotDescriptor[] = [
  {
    id: 'slot_banner',
    label: 'Banner',
    description: 'Top banner with CTA and dismiss',
    surfaceType: 'banner',
    placementHandle: 'banner_upgrade_prompt',
    template: 'banner_upgrade',
  },
  {
    id: 'slot_modal',
    label: 'Modal',
    description: 'Blocking modal upsell',
    surfaceType: 'modal',
    placementHandle: 'modal_trial_expiring',
    template: 'modal_upgrade',
  },
  {
    id: 'slot_inline',
    label: 'Inline Embed',
    description: 'Inline card in product surface',
    surfaceType: 'in_page',
    placementHandle: 'inline_nudge',
    template: 'in_page_card',
  },
  {
    id: 'slot_toast',
    label: 'Toast',
    description: 'Temporary toast for quick CTA',
    surfaceType: 'toast',
    placementHandle: 'toast_limit_warning',
    template: 'toast_limit',
  },
  {
    id: 'slot_button',
    label: 'Button',
    description: 'Persistent CTA button',
    surfaceType: 'button',
    placementHandle: 'button_upgrade',
    template: 'button_primary',
  },
  {
    id: 'slot_full_page',
    label: 'Full Page',
    description: 'Standalone full-page monetization message',
    surfaceType: 'full_page',
    placementHandle: 'fullpage_pricing',
    template: 'fullpage_plans',
  },
  {
    id: 'slot_cli',
    label: 'CLI',
    description: 'CLI style placement',
    surfaceType: 'cli',
    placementHandle: 'cli_upgrade',
    template: 'cli_notice',
  },
  {
    id: 'slot_quota_meter',
    label: 'Quota Meter',
    description: 'Usage meter + CTA',
    surfaceType: 'in_page',
    placementHandle: 'quota_meter_upgrade',
    template: 'quota_meter',
  },
  {
    id: 'slot_credit_balance',
    label: 'Credit Balance',
    description: 'Credit balance depletion message',
    surfaceType: 'in_page',
    placementHandle: 'credit_balance_refill',
    template: 'credit_balance_counter',
  },
];

const baseContent = {
  user_name: '{{user_name}}',
  plan_name: '{{plan_name}}',
};

function slotPlacement(slot: HarnessSlotDescriptor): PlacementOutput {
  const outputId = `harness:${slot.id}`;

  switch (slot.id) {
    case 'slot_banner':
      return {
        output_id: outputId,
        category: 'monetization',
        surface: { type: 'banner', template: slot.template, slot_id: slot.id },
        content: {
          ...baseContent,
          title: 'You are close to your weekly limit',
          body: 'Upgrade to keep shipping without interruption.',
          cta_label: 'Upgrade plan',
          secondary_cta_label: 'View limits',
          position: 'top',
          dismissible: true,
        },
        cta_path: { type: 'navigate', path: '/app/monetization/plans', plan_handle: 'pro' },
        rule_id: 'rule-harness-banner',
        decision_id: `decision-${slot.id}`,
        config_version: 'harness-v1',
        present_upsell: true,
      };
    case 'slot_modal':
      return {
        output_id: outputId,
        category: 'trial',
        surface: { type: 'modal', template: slot.template, slot_id: slot.id },
        content: {
          ...baseContent,
          title: 'Trial ending soon',
          body: 'Move to Pro to keep access to premium exports.',
          cta_label: 'Choose Pro',
          secondary_cta_label: 'Remind me later',
          dismissible: true,
        },
        cta_path: { type: 'plan_upgrade', plan_handle: 'pro' },
        rule_id: 'rule-harness-modal',
        decision_id: `decision-${slot.id}`,
        config_version: 'harness-v1',
        present_upsell: true,
      };
    case 'slot_inline':
      return {
        output_id: outputId,
        category: 'feature_gate',
        surface: { type: 'in_page', template: slot.template, slot_id: slot.id },
        content: {
          ...baseContent,
          title: 'Unlock advanced automations',
          body: 'Your current plan does not include workflow automations.',
          cta_label: 'See plans',
          secondary_cta_label: 'Learn more',
        },
        cta_path: { type: 'open_placement', placement_handle: 'modal_trial_expiring' },
        rule_id: 'rule-harness-inline',
        decision_id: `decision-${slot.id}`,
        config_version: 'harness-v1',
        present_upsell: true,
      };
    case 'slot_toast':
      return {
        output_id: outputId,
        category: 'usage_limit',
        surface: { type: 'toast', template: slot.template, slot_id: slot.id },
        content: {
          ...baseContent,
          title: '95% usage reached',
          body: 'Add more credits to avoid service pauses.',
          cta_label: 'Add credits',
          position: 'bottom-right',
          duration: 8,
        },
        cta_path: { type: 'navigate', path: '/app/monetization/customer-overrides' },
        rule_id: 'rule-harness-toast',
        decision_id: `decision-${slot.id}`,
        config_version: 'harness-v1',
        present_upsell: true,
      };
    case 'slot_button':
      return {
        output_id: outputId,
        category: 'promotion',
        surface: { type: 'button', template: slot.template, slot_id: slot.id },
        content: {
          ...baseContent,
          cta_label: 'Upgrade now',
          style: 'primary',
        },
        cta_path: { type: 'navigate', path: '/app/monetization/plans' },
        rule_id: 'rule-harness-button',
        decision_id: `decision-${slot.id}`,
        config_version: 'harness-v1',
        present_upsell: true,
      };
    case 'slot_full_page':
      return {
        output_id: outputId,
        category: 'billing',
        surface: { type: 'full_page', template: slot.template, slot_id: slot.id },
        content: {
          ...baseContent,
          title: 'Choose the right plan for your team',
          body: 'Compare feature bundles and move to the best fit.',
          cta_label: 'Review plans',
          secondary_cta_label: 'Talk to sales',
        },
        cta_path: { type: 'navigate', path: '/pricing' },
        rule_id: 'rule-harness-full-page',
        decision_id: `decision-${slot.id}`,
        config_version: 'harness-v1',
        present_upsell: true,
      };
    case 'slot_cli':
      return {
        output_id: outputId,
        category: 'agent',
        surface: { type: 'cli', template: slot.template, slot_id: slot.id },
        content: {
          title: 'Token budget nearly exhausted',
          body: 'Upgrade to continue running large simulations.',
          cta_label: 'Open billing settings',
        },
        cta_path: { type: 'command', command: 'open billing' },
        rule_id: 'rule-harness-cli',
        decision_id: `decision-${slot.id}`,
        config_version: 'harness-v1',
        present_upsell: true,
      };
    case 'slot_quota_meter':
      return {
        output_id: outputId,
        category: 'usage',
        surface: { type: 'in_page', template: slot.template, slot_id: slot.id },
        content: {
          title: 'Credits this month',
          current_value: 87,
          max_value: 100,
          unit_label: '%',
          cta_label: 'Buy more credits',
        },
        cta_path: { type: 'purchase_credits', pack: 'standard' },
        rule_id: 'rule-harness-quota',
        decision_id: `decision-${slot.id}`,
        config_version: 'harness-v1',
        present_upsell: true,
      };
    case 'slot_credit_balance':
      return {
        output_id: outputId,
        category: 'credits',
        surface: { type: 'in_page', template: slot.template, slot_id: slot.id },
        content: {
          title: 'Credit balance',
          remaining_credits: 14,
          threshold_credits: 20,
          cta_label: 'Refill credits',
        },
        cta_path: { type: 'purchase_credits', pack: 'priority' },
        rule_id: 'rule-harness-credit-balance',
        decision_id: `decision-${slot.id}`,
        config_version: 'harness-v1',
        present_upsell: true,
      };
    default:
      return {
        output_id: outputId,
        category: 'fallback',
        surface: { type: slot.surfaceType, slot_id: slot.id },
        content: {
          title: slot.label,
          body: slot.description,
          cta_label: 'Take action',
        },
        cta_path: { type: 'dismiss' },
        rule_id: 'rule-harness-fallback',
        decision_id: `decision-${slot.id}`,
        config_version: 'harness-v1',
        present_upsell: true,
      };
  }
}

export function buildHarnessPlacementMap(slots: HarnessSlotDescriptor[] = HARNESS_SLOTS): Record<HarnessSlotId, PlacementOutput> {
  return slots.reduce<Record<HarnessSlotId, PlacementOutput>>((acc, slot) => {
    acc[slot.id] = slotPlacement(slot);
    return acc;
  }, {} as Record<HarnessSlotId, PlacementOutput>);
}

/** The content fields that are editable in the harness UI. */
export const EDITABLE_CONTENT_FIELDS = [
  'title',
  'body',
  'cta_label',
  'secondary_cta_label',
  'image_url',
] as const;

export type EditableContentField = typeof EDITABLE_CONTENT_FIELDS[number];

/** Extract the default editable string content for each slot. */
export function buildDefaultContentOverrides(slots: HarnessSlotDescriptor[] = HARNESS_SLOTS): Record<HarnessSlotId, Record<EditableContentField, string>> {
  const map = buildHarnessPlacementMap(slots);
  return slots.reduce<Record<HarnessSlotId, Record<EditableContentField, string>>>((acc, slot) => {
    const content = map[slot.id].content;
    acc[slot.id] = {} as Record<EditableContentField, string>;
    for (const field of EDITABLE_CONTENT_FIELDS) {
      const val = content[field];
      acc[slot.id][field] = typeof val === 'string' ? val : '';
    }
    return acc;
  }, {} as Record<HarnessSlotId, Record<EditableContentField, string>>);
}

export function buildLookupConfigKey(config: RevTurbinePlacementRequestConfig): string {
  return [
    config.slotId || '',
    config.surfaceType || '',
    config.entitlementHandle || '',
    config.planHandle || '',
    config.placementHandle || '',
  ].join('::');
}

export interface HarnessEntitlementPayload {
  handle: string;
  allowed: boolean;
  status: string;
  reason?: string;
  /** Entitlement type (feature, usage_limit, credits, seat, capability_tier, etc.) */
  kind?: EntitlementType;
  /** Limit value for metered entitlements (usage_limit, credits, seat) */
  limit?: number;
  /** Simulated current usage for metered entitlements */
  current_usage?: number;
  /** Unit label (e.g. "API calls", "credits", "seats") */
  unit?: string;
  /** Period for time-based limits (e.g. "monthly", "daily") */
  period?: string;
  /** Enforcement mode for usage_limit (e.g. "hard", "soft") */
  enforcement?: string;
  /** Tier name for capability_tier entitlements */
  tier_name?: string;
  /** Whether rollover is enabled for credits */
  rollover?: boolean;
}

export const DEFAULT_ENTITLEMENT_PAYLOADS: HarnessEntitlementPayload[] = [
  { handle: 'feature_advanced_automation', allowed: false, status: 'denied', reason: 'harness_simulated_denial', kind: 'feature' },
  { handle: 'api_calls', allowed: true, status: 'allowed', kind: 'usage_limit', limit: 10000, current_usage: 2500, unit: 'calls', period: 'monthly', enforcement: 'hard' },
  { handle: 'exports', allowed: true, status: 'allowed', kind: 'usage_limit', limit: 500, current_usage: 120, unit: 'exports', period: 'monthly', enforcement: 'soft' },
];

export function createLocalRuntimeData(
  activeSlots: Record<HarnessSlotId, boolean>,
  userId: string,
  userName: string,
  planHandle: string,
  entitlementPayloads: HarnessEntitlementPayload[],
  slots: HarnessSlotDescriptor[] = HARNESS_SLOTS,
  matchedSegmentIds: string[] = [],
): RevTurbineLocalRuntimeData {
  const placements = buildHarnessPlacementMap(slots);
  const placementsByLookupKey: Record<string, PlacementOutput | null> = {};

  for (const slot of slots) {
    const key = buildLookupConfigKey({
      slotId: slot.id,
      surfaceType: slot.surfaceType,
      placementHandle: slot.placementHandle,
      planHandle,
    });

    placementsByLookupKey[key] = activeSlots[slot.id] ? placements[slot.id] : null;
  }

  const entitlementByHandle: Record<string, { status: EntitlementStatus; allowed: boolean; reason?: string }> = {};
  for (const ep of entitlementPayloads) {
    entitlementByHandle[ep.handle] = ep.allowed
      ? { status: (ep.status || 'allowed') as EntitlementStatus, allowed: true }
      : { status: (ep.status || 'denied') as EntitlementStatus, allowed: false, reason: ep.reason };
  }

  return {
    placementsByLookupKey,
    entitlementByHandle,
    userContextByUserId: {
      [userId]: {
        userId,
        segmentIds: ['sdk_harness', planHandle, ...matchedSegmentIds],
        traits: {
          user_name: userName,
          plan_name: planHandle,
          harness_mode: 'local',
        },
        plan: planHandle,
        usage: Object.fromEntries(
          entitlementPayloads.map((ep) => [ep.handle, ep.allowed ? 25 : 95]),
        ),
      },
    },
    trialStatus: {
      inTrial: planHandle === 'trial',
      planHandle,
      dayNumber: planHandle === 'trial' ? 6 : undefined,
      daysRemaining: planHandle === 'trial' ? 8 : undefined,
    },
  };
}

export function createEntitlementContext(usagePercent: number): RevTurbineEntitlementContext {
  return {
    used: Math.round((usagePercent / 100) * 1000),
    balance: Math.max(0, 1000 - Math.round((usagePercent / 100) * 1000)),
    requiredTier: 'pro',
  };
}

/**
 * Resolve the effective entitlement payloads for a user on a given plan.
 *
 * For each known entitlement, finds the matching rule(s) for the plan and derives
 * an allowed/denied status:
 * - **feature** rules: allowed when `enabled` is true.
 * - **metered** rules (usage_limit, credits, seat): allowed when `current_usage < limit`.
 * - **No matching rule**: the entitlement is denied for this plan.
 *
 * The returned array always covers every entitlement (one entry each), making it
 * suitable for seeding `entitlementByHandle` in the local runtime.
 */
export function resolveEntitlementPayloads(
  planId: string,
  entitlements: HarnessEntitlement[],
  rules: HarnessEntitlementRule[],
): HarnessEntitlementPayload[] {
  return entitlements.map((ent) => {
    // Find rules that apply to this plan and entitlement. Empty `segment_ids`
    // means "match all segments" (the plan #39 successor to `segment_id === null`).
    const matching = rules.filter(
      (r) =>
        r.targets.some((t) => t.kind === 'plan' && t.id === planId) &&
        r.entitlement_id === ent.id &&
        (r.segment_ids?.length ?? 0) === 0,
    );
    if (matching.length === 0) {
      return { handle: ent.unique_handle, allowed: false, status: 'denied', reason: 'no_rule_for_plan', kind: ent.type };
    }
    // Use the first matching rule
    const rule = matching[0];
    const tf = rule.type_fields;

    // Base fields shared across all resolved payloads
    const base = { handle: ent.unique_handle, kind: ent.type };

    if (tf.kind === 'feature') {
      return tf.enabled
        ? { ...base, allowed: true, status: 'allowed' }
        : { ...base, allowed: false, status: 'denied', reason: 'feature_disabled' };
    }
    if (tf.kind === 'capability_tier') {
      return { ...base, allowed: true, status: 'allowed', tier_name: tf.tier_name };
    }
    // Metered / quantifiable: compare usage to limit
    const limit = ruleLimit(rule);
    const withinLimit = rule.current_usage < limit;
    const metered: Partial<HarnessEntitlementPayload> = {
      limit,
      current_usage: rule.current_usage,
    };
    if (tf.kind === 'usage_limit') {
      metered.unit = tf.unit;
      metered.period = tf.period;
      metered.enforcement = tf.enforcement;
    } else if (tf.kind === 'credits') {
      metered.unit = tf.unit;
      metered.period = tf.period;
      metered.rollover = tf.rollover;
    } else if (tf.kind === 'seat') {
      metered.unit = 'seats';
    }
    return {
      ...base,
      ...metered,
      allowed: withinLimit,
      status: withinLimit ? 'allowed' : 'denied',
      ...(!withinLimit ? { reason: 'limit_exceeded' } : {}),
    };
  });
}

/**
 * Default trigger event names that each slot type listens to.
 * Derived from placement categories in the requirements:
 * (roadmap/docs/requirements — placement categories & SDK integration points).
 */
export const DEFAULT_SLOT_TRIGGERS: Record<HarnessSlotId, string[]> = {
  slot_banner: ['usage_limit_approaching', 'usage_limit_reached', 'plan_upgrade_nudge'],
  slot_modal: ['trial_expiring', 'trial_expired', 'cancel_intent'],
  slot_inline: ['feature_gated', 'plan_upgrade_nudge'],
  slot_toast: ['usage_limit_approaching', 'usage_limit_reached', 'credit_balance_low'],
  slot_button: ['plan_upgrade_nudge', 'referral_offer'],
  slot_full_page: ['trial_expired', 'cancel_intent', 'plan_upgrade_nudge'],
  slot_cli: ['usage_limit_reached', 'credit_balance_low'],
  slot_quota_meter: ['usage_limit_approaching', 'usage_limit_reached'],
  slot_credit_balance: ['credit_balance_low'],
};

/** All trigger event names available for slot configuration. */
export const ALL_TRIGGER_EVENTS = [
  'trial_midpoint',
  'trial_expiring',
  'trial_expired',
  'usage_limit_approaching',
  'usage_limit_reached',
  'credit_balance_low',
  'seat_limit_reached',
  'feature_gated',
  'cancel_intent',
  'payment_failed',
  'auto_renewal_reminder',
  'onboarding_complete',
  'invite_teammate_prompt',
  'referral_offer',
  'plan_upgrade_nudge',
] as const;

// ---------------------------------------------------------------------------
// Plans, Entitlements & Rules
// ---------------------------------------------------------------------------
// These types mirror the canonical schema shapes from revturbine-scaffold
// (plan.json, entitlement.json, entitlement_rule.json) but are simplified
// for harness/demo use. Field names align with the schema so trigger payloads
// and SDK interactions produce contract-valid data.

/**
 * Canonical entitlement type from the schema.
 * Matches `Entitlement.type` in revturbine-scaffold/schemas/v1.0.0/entitlements/entitlement.json
 */
export type EntitlementType =
  | 'feature'
  | 'capability_tier'
  | 'usage_limit'
  | 'usage_pricing'
  | 'usage_rate'
  | 'credits'
  | 'seat';

/** Subset of entitlement types that are metered/quantifiable (have limits or balances). */
export const METERED_ENTITLEMENT_TYPES: ReadonlySet<EntitlementType> = new Set([
  'usage_limit', 'usage_pricing', 'usage_rate', 'credits', 'seat',
]);

/** All entitlement type values for dropdown selectors. */
export const ENTITLEMENT_TYPES: EntitlementType[] = [
  'feature', 'capability_tier', 'usage_limit', 'credits', 'seat',
];

/**
 * Predicate operator for segment auto-assignment.
 * Evaluates a user context field against a value.
 */
export type SegmentPredicateOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'in';

export const SEGMENT_PREDICATE_OPERATORS: SegmentPredicateOperator[] = [
  'eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'in',
];

/**
 * A single predicate rule for segment auto-assignment.
 * `field` can be:
 *   - `plan_handle` — the user's current plan handle
 *   - `usage_percent` — the global usage percent slider value
 *   - `trait.<key>` — any user trait value
 */
export interface SegmentPredicate {
  field: string;
  operator: SegmentPredicateOperator;
  value: string;
}

/** Context object passed to segment predicate evaluation. */
export interface SegmentEvalContext {
  planHandle: string;
  usagePercent: number;
  traits: Record<string, unknown>;
}

/** Evaluate a single predicate against the user context. */
function evaluatePredicate(pred: SegmentPredicate, ctx: SegmentEvalContext): boolean {
  let fieldValue: unknown;
  if (pred.field === 'plan_handle') {
    fieldValue = ctx.planHandle;
  } else if (pred.field === 'usage_percent') {
    fieldValue = ctx.usagePercent;
  } else if (pred.field.startsWith('trait.')) {
    const traitKey = pred.field.slice(6);
    fieldValue = ctx.traits[traitKey];
  } else {
    return false;
  }

  const numericField = typeof fieldValue === 'number' ? fieldValue : Number(fieldValue);
  const numericValue = Number(pred.value);
  const strField = String(fieldValue ?? '');

  switch (pred.operator) {
    case 'eq': return strField === pred.value;
    case 'neq': return strField !== pred.value;
    case 'gt': return !isNaN(numericField) && !isNaN(numericValue) && numericField > numericValue;
    case 'lt': return !isNaN(numericField) && !isNaN(numericValue) && numericField < numericValue;
    case 'gte': return !isNaN(numericField) && !isNaN(numericValue) && numericField >= numericValue;
    case 'lte': return !isNaN(numericField) && !isNaN(numericValue) && numericField <= numericValue;
    case 'contains': return strField.includes(pred.value);
    case 'in': return pred.value.split(',').map((v) => v.trim()).includes(strField);
    default: return false;
  }
}

/**
 * Evaluate all segment predicates and return the list of matched segment IDs.
 * A segment matches when ALL its predicates evaluate to true (AND logic).
 * Segments with no predicates never auto-match.
 * The special `_all` segment is always excluded.
 */
export function evaluateSegmentPredicates(
  segments: HarnessSegment[],
  ctx: SegmentEvalContext,
): string[] {
  const matched: string[] = [];
  for (const seg of segments) {
    if (seg.handle === '_all') continue;
    if (!seg.predicates || seg.predicates.length === 0) continue;
    if (seg.predicates.every((p) => evaluatePredicate(p, ctx))) {
      matched.push(seg.id);
    }
  }
  return matched;
}

/**
 * Simplified segment for harness use. Aligns with `Segment` schema fields:
 * segment_id, name, handle. Extended with optional predicate rules for
 * automatic user assignment.
 */
export interface HarnessSegment {
  id: string;
  name: string;
  handle: string;
  predicates?: SegmentPredicate[];
}

/**
 * Simplified plan for harness use. Aligns with `Plan` schema fields:
 * id, unique_handle, name.
 */
export interface HarnessPlan {
  id: string;
  unique_handle: string;
  name: string;
}

/**
 * Simplified entitlement for harness use. Aligns with `Entitlement` schema fields:
 * id, unique_handle, name, type, unit.
 */
export interface HarnessEntitlement {
  id: string;
  unique_handle: string;
  name: string;
  type: EntitlementType;
  unit?: string;
}

/**
 * Entitlement rule type_fields discriminated union, matching EntitlementRuleFields
 * from the canonical schema. Simplified to the fields material for trigger payloads.
 */
export type HarnessEntitlementRuleFields =
  | { kind: 'feature'; enabled: boolean }
  | { kind: 'capability_tier'; tier_name: string }
  | { kind: 'usage_limit'; limit_value: number; unit: string; period: string; enforcement: string }
  | { kind: 'credits'; allowance: number; period: string; rollover: boolean; unit?: string }
  | { kind: 'seat'; included_seats: number; max_seats?: number | null };

/**
 * Simplified entitlement rule for harness use.
 * Aligns with `EntitlementRule` schema: id, entitlement_id, targets[], segment_ids, type_fields.
 * Adds `current_usage` for harness simulation (not part of the canonical schema —
 * usage data comes from metering at runtime).
 */
export interface HarnessEntitlementRule {
  id: string;
  entitlement_id: string;
  targets: Array<{ kind: 'plan' | 'plan_variation' | 'addon' | 'addon_variation'; id: string }>;
  /** Segment scope. Empty array means all segments (matches every user). */
  segment_ids: string[];
  type_fields: HarnessEntitlementRuleFields;
  /** Simulated current usage for the harness (runtime concept, not persisted in schema). */
  current_usage: number;
}

/** Helper: extract the limit value from a rule's type_fields. */
export function ruleLimit(rule: HarnessEntitlementRule): number {
  switch (rule.type_fields.kind) {
    case 'usage_limit': return rule.type_fields.limit_value;
    case 'credits': return rule.type_fields.allowance;
    case 'seat': return rule.type_fields.included_seats;
    case 'feature': return rule.type_fields.enabled ? 1 : 0;
    case 'capability_tier': return 1;
    default: return 0;
  }
}

/** The trigger events that are usage/entitlement-specific. */
export const USAGE_TRIGGER_EVENTS = new Set([
  'usage_limit_approaching',
  'usage_limit_reached',
  'credit_balance_low',
  'seat_limit_reached',
]);

export const DEFAULT_SEGMENTS: HarnessSegment[] = [
  { id: 'seg_all', name: 'All Segments', handle: '_all' },
  { id: 'seg_smb', name: 'SMB', handle: 'smb', predicates: [
    { field: 'plan_handle', operator: 'in', value: 'trial,starter' },
  ] },
  { id: 'seg_mid_market', name: 'Mid-Market', handle: 'mid_market', predicates: [
    { field: 'plan_handle', operator: 'eq', value: 'pro' },
  ] },
  { id: 'seg_enterprise', name: 'Enterprise', handle: 'enterprise', predicates: [
    { field: 'plan_handle', operator: 'eq', value: 'enterprise' },
  ] },
];

export const DEFAULT_PLANS: HarnessPlan[] = [
  { id: 'plan_trial', unique_handle: 'trial', name: 'Trial' },
  { id: 'plan_starter', unique_handle: 'starter', name: 'Starter' },
  { id: 'plan_pro', unique_handle: 'pro', name: 'Pro' },
  { id: 'plan_enterprise', unique_handle: 'enterprise', name: 'Enterprise' },
];

export const DEFAULT_ENTITLEMENTS: HarnessEntitlement[] = [
  { id: 'ent_api_calls', unique_handle: 'api_calls', name: 'API Calls', type: 'usage_limit', unit: 'calls' },
  { id: 'ent_seats', unique_handle: 'seats', name: 'Seats', type: 'seat', unit: 'seats' },
  { id: 'ent_automations', unique_handle: 'automations', name: 'Automations', type: 'feature' },
  { id: 'ent_credits', unique_handle: 'credits', name: 'Credits', type: 'credits', unit: 'credits' },
  { id: 'ent_exports', unique_handle: 'exports', name: 'Exports', type: 'usage_limit', unit: 'exports' },
];

export const DEFAULT_ENTITLEMENT_RULES: HarnessEntitlementRule[] = [
  // Trial
  { id: 'rule_1', entitlement_id: 'ent_api_calls', targets: [{ kind: 'plan', id: 'plan_trial' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 1000, unit: 'calls', period: 'per_month', enforcement: 'soft_block' }, current_usage: 800 },
  { id: 'rule_2', entitlement_id: 'ent_seats', targets: [{ kind: 'plan', id: 'plan_trial' }], segment_ids: [], type_fields: { kind: 'seat', included_seats: 3 }, current_usage: 2 },
  { id: 'rule_3', entitlement_id: 'ent_credits', targets: [{ kind: 'plan', id: 'plan_trial' }], segment_ids: [], type_fields: { kind: 'credits', allowance: 50, period: 'per_month', rollover: false, unit: 'credits' }, current_usage: 42 },
  { id: 'rule_4', entitlement_id: 'ent_exports', targets: [{ kind: 'plan', id: 'plan_trial' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 10, unit: 'exports', period: 'per_month', enforcement: 'hard_block' }, current_usage: 8 },
  // Starter
  { id: 'rule_5', entitlement_id: 'ent_api_calls', targets: [{ kind: 'plan', id: 'plan_starter' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 5000, unit: 'calls', period: 'per_month', enforcement: 'soft_block' }, current_usage: 4200 },
  { id: 'rule_6', entitlement_id: 'ent_seats', targets: [{ kind: 'plan', id: 'plan_starter' }], segment_ids: [], type_fields: { kind: 'seat', included_seats: 10 }, current_usage: 7 },
  { id: 'rule_7', entitlement_id: 'ent_credits', targets: [{ kind: 'plan', id: 'plan_starter' }], segment_ids: [], type_fields: { kind: 'credits', allowance: 200, period: 'per_month', rollover: false, unit: 'credits' }, current_usage: 150 },
  { id: 'rule_8', entitlement_id: 'ent_exports', targets: [{ kind: 'plan', id: 'plan_starter' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 100, unit: 'exports', period: 'per_month', enforcement: 'soft_block' }, current_usage: 65 },
  // Pro
  { id: 'rule_9', entitlement_id: 'ent_api_calls', targets: [{ kind: 'plan', id: 'plan_pro' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 50000, unit: 'calls', period: 'per_month', enforcement: 'allow_overage' }, current_usage: 12000 },
  { id: 'rule_10', entitlement_id: 'ent_seats', targets: [{ kind: 'plan', id: 'plan_pro' }], segment_ids: [], type_fields: { kind: 'seat', included_seats: 50 }, current_usage: 22 },
  { id: 'rule_11', entitlement_id: 'ent_automations', targets: [{ kind: 'plan', id: 'plan_pro' }], segment_ids: [], type_fields: { kind: 'feature', enabled: true }, current_usage: 1 },
  { id: 'rule_12', entitlement_id: 'ent_credits', targets: [{ kind: 'plan', id: 'plan_pro' }], segment_ids: [], type_fields: { kind: 'credits', allowance: 1000, period: 'per_month', rollover: true, unit: 'credits' }, current_usage: 400 },
  { id: 'rule_13', entitlement_id: 'ent_exports', targets: [{ kind: 'plan', id: 'plan_pro' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 500, unit: 'exports', period: 'per_month', enforcement: 'allow_overage' }, current_usage: 120 },
  // Enterprise
  { id: 'rule_14', entitlement_id: 'ent_api_calls', targets: [{ kind: 'plan', id: 'plan_enterprise' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 500000, unit: 'calls', period: 'per_month', enforcement: 'allow_overage' }, current_usage: 85000 },
  { id: 'rule_15', entitlement_id: 'ent_seats', targets: [{ kind: 'plan', id: 'plan_enterprise' }], segment_ids: [], type_fields: { kind: 'seat', included_seats: 500 }, current_usage: 180 },
  { id: 'rule_16', entitlement_id: 'ent_automations', targets: [{ kind: 'plan', id: 'plan_enterprise' }], segment_ids: [], type_fields: { kind: 'feature', enabled: true }, current_usage: 1 },
  { id: 'rule_17', entitlement_id: 'ent_credits', targets: [{ kind: 'plan', id: 'plan_enterprise' }], segment_ids: [], type_fields: { kind: 'credits', allowance: 10000, period: 'per_month', rollover: true, unit: 'credits' }, current_usage: 3200 },
  { id: 'rule_18', entitlement_id: 'ent_exports', targets: [{ kind: 'plan', id: 'plan_enterprise' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 5000, unit: 'exports', period: 'per_month', enforcement: 'allow_overage' }, current_usage: 800 },
];

let ruleCounter = DEFAULT_ENTITLEMENT_RULES.length + 1;
export function nextRuleId(): string {
  return `rule_${ruleCounter++}`;
}

// ---------------------------------------------------------------------------
// Theme defaults
// ---------------------------------------------------------------------------

export interface HarnessTheme {
  primary_color: string;
  accent_color: string;
  font_family: string;
  border_radius: string;
  dark_mode: boolean;
}

export const DEFAULT_THEME: HarnessTheme = {
  primary_color: '#1a73e8',
  accent_color: '#ff6d00',
  font_family: 'system-ui, -apple-system, sans-serif',
  border_radius: '8px',
  dark_mode: true,
};

// ---------------------------------------------------------------------------
// RevTurbineConfig — build / load
// ---------------------------------------------------------------------------

import type {
  RevTurbineConfig,
  Theme,
} from '@revt-eng/schema';

export type { RevTurbineConfig };

export const EXPORTED_CONFIG_VERSION = '1.0.0';

/** localStorage key for auto-persisted harness state. */
export const HARNESS_LOCALSTORAGE_KEY = 'revturbine:harness-config';

const HARNESS_THEME_ID = '00000000-0000-0000-0000-000000000001';

function toExportedTheme(theme: HarnessTheme): Theme {
  const nowIso = new Date().toISOString();
  return {
    theme_id: HARNESS_THEME_ID,
    tenant_id: 'tenant_harness',
    name: 'Harness Theme',
    version: EXPORTED_CONFIG_VERSION,
    active: true,
    colors: {
      primary: theme.primary_color,
      accent: theme.accent_color,
      text: '#212121',
      text_secondary: '#616161',
      surface: '#ffffff',
      surface_border: '#e5e7eb',
    },
    typography: {
      font_family: theme.font_family,
    },
    shape: {
      border_radius: theme.border_radius,
    },
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/** Serialise the full harness state into an RevTurbineConfig JSON-safe object. */
export function buildExportedConfig(params: {
  plans: HarnessPlan[];
  entitlements: HarnessEntitlement[];
  entitlementRules: HarnessEntitlementRule[];
  segments: HarnessSegment[];
  activeSlots: Record<HarnessSlotId, boolean>;
  slotTriggers: Record<HarnessSlotId, Set<string>>;
  contentOverrides: Record<HarnessSlotId, Record<string, string>>;
  theme: HarnessTheme;
  userId: string;
  userName: string;
  planHandle: string;
  usagePercent: number;
  entitlementAllowed: boolean;
  traitsInput: string;
  selectedSegmentId: string;
  rulesPlanFilter: string;
  eventName: string;
  entitlementPayloads: HarnessEntitlementPayload[];
  slots: HarnessSlotDescriptor[];
}): RevTurbineConfig {
  return {
    version: EXPORTED_CONFIG_VERSION,
    exported_at: new Date().toISOString(),
    plans: params.plans.map((p) => ({ id: p.id, unique_handle: p.unique_handle, name: p.name })),
    entitlements: params.entitlements.map((e) => ({
      id: e.id,
      unique_handle: e.unique_handle,
      name: e.name,
      type: e.type,
      ...(e.unit ? { unit: e.unit } : {}),
    })),
    entitlement_rules: params.entitlementRules.map((r) => ({
      id: r.id,
      entitlement_id: r.entitlement_id,
      targets: r.targets,
      segment_ids: r.segment_ids,
      type_fields: r.type_fields as Record<string, unknown>,
      current_usage: r.current_usage,
    })),
    segments: params.segments.map((s) => ({
      id: s.id,
      name: s.name,
      handle: s.handle,
      ...(s.predicates && s.predicates.length > 0 ? { predicates: s.predicates } : {}),
    })),
    slot_configs: params.slots.map((slot) => ({
      slot_id: slot.id,
      active: params.activeSlots[slot.id] ?? false,
      triggers: [...(params.slotTriggers[slot.id] ?? [])],
    })),
    content_overrides: Object.fromEntries(
      params.slots.map((slot) => [slot.id, { ...(params.contentOverrides[slot.id] ?? {}) }]),
    ),
    theme: toExportedTheme(params.theme),
    placement_slots: params.slots.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      surface_type: s.surfaceType,
      placement_handle: s.placementHandle,
      ...(s.template ? { template: s.template } : {}),
    })),
    content_ui_paths: [],
  };
}

/**
 * Parse and validate an RevTurbineConfig JSON object, returning harness-ready
 * state slices.  Throws on invalid input.
 */
export function loadExportedConfig(raw: unknown): {
  plans: HarnessPlan[];
  entitlements: HarnessEntitlement[];
  entitlementRules: HarnessEntitlementRule[];
  segments: HarnessSegment[];
  activeSlots: Record<HarnessSlotId, boolean>;
  slotTriggers: Record<HarnessSlotId, Set<string>>;
  contentOverrides: Record<HarnessSlotId, Record<string, string>>;
  theme: HarnessTheme;
  userId: string;
  userName: string;
  planHandle: string;
  usagePercent: number;
  entitlementAllowed: boolean;
  traitsInput: string;
  selectedSegmentId: string;
  rulesPlanFilter: string;
  eventName: string;
  entitlementPayloads: HarnessEntitlementPayload[];
  slots: HarnessSlotDescriptor[];
} {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid config: not an object');
  const cfg = raw as RevTurbineConfig;

  if (!cfg.version) throw new Error('Invalid config: missing version');
  if (!Array.isArray(cfg.plans)) throw new Error('Invalid config: plans must be an array');
  if (!Array.isArray(cfg.entitlements)) throw new Error('Invalid config: entitlements must be an array');
  if (!Array.isArray(cfg.entitlement_rules)) throw new Error('Invalid config: entitlement_rules must be an array');
  if (!Array.isArray(cfg.segments)) throw new Error('Invalid config: segments must be an array');

  const plans: HarnessPlan[] = cfg.plans.map((p) => ({
    id: String(p.id),
    unique_handle: String(p.unique_handle),
    name: String(p.name),
  }));

  const entitlements: HarnessEntitlement[] = cfg.entitlements.map((e) => ({
    id: String(e.id),
    unique_handle: String(e.unique_handle),
    name: String(e.name),
    type: e.type as EntitlementType,
    ...(e.unit ? { unit: String(e.unit) } : {}),
  }));

  const entitlementRules: HarnessEntitlementRule[] = cfg.entitlement_rules.map((r) => ({
    id: String(r.id),
    entitlement_id: String(r.entitlement_id),
    targets: Array.isArray(r.targets) ? r.targets : [],
    segment_ids: Array.isArray(r.segment_ids) ? r.segment_ids : [],
    type_fields: r.type_fields as HarnessEntitlementRuleFields,
    current_usage: Number(r.current_usage) || 0,
  }));

  const segments: HarnessSegment[] = cfg.segments.map((s) => ({
    id: String(s.id),
    name: String(s.name),
    handle: String(s.handle),
    ...(Array.isArray(s.predicates) && s.predicates.length > 0
      ? {
          predicates: s.predicates.map((p) => ({
            field: String(p.field),
            operator: String(p.operator) as SegmentPredicateOperator,
            value: String(p.value),
          })),
        }
      : {}),
  }));

  // Placement slots — use config if present, otherwise defaults
  const slots: HarnessSlotDescriptor[] = Array.isArray(cfg.placement_slots) && cfg.placement_slots.length > 0
    ? cfg.placement_slots.map((s) => ({
        id: String(s.id),
        label: String(s.label),
        description: String(s.description),
        surfaceType: String(s.surface_type) as PlacementOutput['surface']['type'],
        placementHandle: String(s.placement_handle),
        ...(s.template ? { template: String(s.template) } : {}),
      }))
    : [...HARNESS_SLOTS];

  // Slot configs — merge onto slot list
  const activeSlots: Record<HarnessSlotId, boolean> = {} as Record<HarnessSlotId, boolean>;
  const slotTriggers: Record<HarnessSlotId, Set<string>> = {} as Record<HarnessSlotId, Set<string>>;
  for (const slot of slots) {
    activeSlots[slot.id] = false;
    slotTriggers[slot.id] = new Set(DEFAULT_SLOT_TRIGGERS[slot.id] ?? []);
  }
  if (Array.isArray(cfg.slot_configs)) {
    for (const sc of cfg.slot_configs) {
      const slotId = sc.slot_id as HarnessSlotId;
      activeSlots[slotId] = sc.active;
      slotTriggers[slotId] = new Set(sc.triggers ?? []);
    }
  }

  // Content overrides
  const contentOverrides = buildDefaultContentOverrides(slots);
  if (cfg.content_overrides && typeof cfg.content_overrides === 'object') {
    for (const [slotId, fields] of Object.entries(cfg.content_overrides)) {
      if (slotId in contentOverrides && fields && typeof fields === 'object') {
        contentOverrides[slotId as HarnessSlotId] = {
          ...contentOverrides[slotId as HarnessSlotId],
          ...fields,
        } as Record<EditableContentField, string>;
      }
    }
  }

  // Theme
  const theme: HarnessTheme = { ...DEFAULT_THEME };
  if (cfg.theme && typeof cfg.theme === 'object') {
    const colors = cfg.theme.colors;
    const typography = cfg.theme.typography;
    const shape = cfg.theme.shape;

    if (typeof colors?.primary === 'string') theme.primary_color = colors.primary;
    if (typeof colors?.accent === 'string') theme.accent_color = colors.accent;
    if (typeof typography?.font_family === 'string') theme.font_family = typography.font_family;
    if (typeof shape?.border_radius === 'string') theme.border_radius = shape.border_radius;
  }

  // Harness-local defaults (user_context, trial, entitlement_payloads are no
  // longer part of RevTurbineConfig — they are harness session state).
  const userId = 'user_harness_01';
  const userName = 'Taylor Harness';
  const planHandle = 'starter';
  const usagePercent = 72;
  const entitlementAllowed = false;
  const traitsInput = '{\n  "region": "us-east",\n  "workspace": "sdk-harness"\n}';
  const selectedSegmentId = '';
  const rulesPlanFilter = '';
  const eventName = 'manual_trigger';

  // Reset rule counter so new rules get ids after the imported ones
  ruleCounter = entitlementRules.length + 1;

  // Derive entitlement payloads from imported rules
  const firstPlan = plans[0];
  const entitlementPayloads: HarnessEntitlementPayload[] = firstPlan
    ? resolveEntitlementPayloads(firstPlan.id, entitlements, entitlementRules)
    : [...DEFAULT_ENTITLEMENT_PAYLOADS];

  return {
    plans,
    entitlements,
    entitlementRules,
    segments,
    activeSlots,
    slotTriggers,
    contentOverrides,
    theme,
    userId,
    userName,
    planHandle,
    usagePercent,
    entitlementAllowed,
    traitsInput,
    selectedSegmentId,
    rulesPlanFilter,
    eventName,
    entitlementPayloads,
    slots,
  };
}

// ---------------------------------------------------------------------------
// localStorage persistence helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to load a previously-saved RevTurbineConfig from localStorage.
 * Returns `null` if no config is found or the stored value is invalid.
 */
export function loadConfigFromLocalStorage(): ReturnType<typeof loadExportedConfig> | null {
  try {
    const raw = localStorage.getItem(HARNESS_LOCALSTORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return loadExportedConfig(parsed);
  } catch {
    return null;
  }
}

/**
 * Persist an RevTurbineConfig to localStorage.
 */
export function saveConfigToLocalStorage(config: RevTurbineConfig): void {
  try {
    localStorage.setItem(HARNESS_LOCALSTORAGE_KEY, JSON.stringify(config));
  } catch {
    // Silently ignore quota errors
  }
}
