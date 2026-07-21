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

type HarnessPlacementCategory = Playbook['placements'][number]['category'];
type HarnessAuthoredCta = Playbook['placements'][number]['payloads'][number]['surfaces'][number]['ctas'][number];

interface HarnessCanonicalCta {
  authored: Omit<HarnessAuthoredCta, 'label'>;
  runtime: PlacementOutput['cta_path'];
}

/**
 * Project the old scenario labels onto the portable Playbook category model.
 * This helper is shared by the local runtime and the exported Playbook so the
 * harness cannot silently exercise a different decision category.
 */
function canonicalPlacementCategory(slot: HarnessSlotDescriptor): HarnessPlacementCategory {
  switch (slot.id) {
    case 'slot_inline':
      return 'gated';
    case 'slot_modal':
      return 'trials';
    case 'slot_banner':
    case 'slot_toast':
    case 'slot_cli':
    case 'slot_quota_meter':
    case 'slot_credit_balance':
      return 'usage_credit_seat';
    case 'slot_button':
    case 'slot_full_page':
      return 'other_conversion';
    default:
      return 'fixed';
  }
}

/**
 * Keep authored Playbook CTA actions and their normalized SDK runtime shape in
 * one table. The runtime values mirror core's Playbook/Bundle normalization.
 */
function canonicalPlacementCta(slot: HarnessSlotDescriptor): HarnessCanonicalCta {
  switch (slot.id) {
    case 'slot_banner':
    case 'slot_modal':
      return {
        authored: { path: 'open_checkout', config: { purchase: 'pro' } },
        runtime: { type: 'open_checkout_modal', plan_handle: 'pro' },
      };
    case 'slot_inline':
      return {
        authored: { path: 'open_rt_placement', config: { placement_handle: 'modal_trial_expiring' } },
        runtime: { type: 'open_rt_placement', placement_handle: 'modal_trial_expiring' },
      };
    case 'slot_toast':
      return {
        authored: { path: 'custom', config: { url: '/app/monetization/customer-overrides' } },
        runtime: { type: 'custom', url: '/app/monetization/customer-overrides' },
      };
    case 'slot_button':
    case 'slot_full_page':
      return {
        authored: { path: 'view_plans' },
        runtime: { type: 'navigate_to_plans' },
      };
    case 'slot_cli':
      return {
        authored: { path: 'custom', config: { command: 'open billing' } },
        runtime: { type: 'custom', command: 'open billing' },
      };
    case 'slot_quota_meter':
      return {
        authored: { path: 'custom', config: { purchase_credits_pack: 'standard' } },
        runtime: { type: 'custom', purchase_credits_pack: 'standard' },
      };
    case 'slot_credit_balance':
      return {
        authored: { path: 'custom', config: { purchase_credits_pack: 'priority' } },
        runtime: { type: 'custom', purchase_credits_pack: 'priority' },
      };
    default:
      return {
        authored: { path: 'dismiss' },
        runtime: { type: 'dismiss' },
      };
  }
}

/** Match the Message Block bundle representation: extras are portable strings. */
function toCanonicalPlacementContent(content: Record<string, unknown>): Record<string, string> {
  const canonical: Record<string, string> = {};
  for (const [field, value] of Object.entries(content)) {
    const key = field === 'title' ? 'header' : field;
    if (typeof value === 'string') {
      canonical[key] = value;
      continue;
    }
    if (value == null) {
      canonical[key] = '';
      continue;
    }
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) canonical[key] = serialized;
  }
  return canonical;
}

export function buildHarnessPlacementMap(slots: HarnessSlotDescriptor[] = HARNESS_SLOTS): Record<HarnessSlotId, PlacementOutput> {
  return slots.reduce<Record<HarnessSlotId, PlacementOutput>>((acc, slot) => {
    const placement = slotPlacement(slot);
    acc[slot.id] = {
      ...placement,
      category: canonicalPlacementCategory(slot),
      cta_path: canonicalPlacementCta(slot).runtime,
    };
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
      const val = field === 'title' ? content.header ?? content.title : content[field];
      acc[slot.id][field] = typeof val === 'string' ? val : '';
    }
    return acc;
  }, {} as Record<HarnessSlotId, Record<EditableContentField, string>>);
}

/** Build the harness runtime placement catalog with editable Message Block content applied. */
export function buildHarnessPlacementCatalog(
  slots: HarnessSlotDescriptor[] = HARNESS_SLOTS,
  contentOverrides: Record<HarnessSlotId, Record<string, string>> = buildDefaultContentOverrides(slots),
): Record<HarnessSlotId, PlacementOutput> {
  const basePlacements = buildHarnessPlacementMap(slots);
  return slots.reduce<Record<HarnessSlotId, PlacementOutput>>((acc, slot) => {
    const placement = basePlacements[slot.id];
    const overrides = contentOverrides[slot.id] ?? {};
    const content: Record<string, string> = toCanonicalPlacementContent(placement.content);
    for (const field of EDITABLE_CONTENT_FIELDS) {
      const value = overrides[field];
      if (typeof value === 'string' && value.trim().length > 0) {
        content[field === 'title' ? 'header' : field] = value;
      }
    }
    acc[slot.id] = {
      ...placement,
      surface: {
        ...placement.surface,
        template: slot.template,
        slot_id: slot.id,
        type: slot.surfaceType,
      },
      content,
    };
    return acc;
  }, {} as Record<HarnessSlotId, PlacementOutput>);
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
  contentOverrides: Record<HarnessSlotId, Record<string, string>> = buildDefaultContentOverrides(slots),
): RevTurbineLocalRuntimeData {
  const placements = buildHarnessPlacementCatalog(slots, contentOverrides);
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
  Playbook,
  RevTurbineConfig,
  Theme,
} from '@revt-eng/schema';
import {
  normalizeConfigArtifactOrThrow,
  type ConfigArtifact,
} from '../config-artifact';

export type { Playbook, RevTurbineConfig };

export const EXPORTED_CONFIG_VERSION = '1.0.0';

/** localStorage key for auto-persisted harness state. */
export const HARNESS_LOCALSTORAGE_KEY = 'revturbine:harness-config';

/** localStorage key for activation and trigger state that is not part of a Playbook. */
export const HARNESS_LOCALSTATE_STORAGE_KEY = 'revturbine:harness-local-state';

/** Harness-local activation and trigger state, intentionally separate from Playbook strategy. */
export interface HarnessLocalState {
  activeSlots: Record<HarnessSlotId, boolean>;
  slotTriggers: Record<HarnessSlotId, Set<string>>;
}

const HARNESS_THEME_ID = '00000000-0000-0000-0000-000000000001';

function isRecord(value: unknown): value is Record<string, unknown> { // sdk-ok: boundary-parse
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function harnessTemplateId(slot: HarnessSlotDescriptor): string {
  return slot.template ?? `harness_template_${slot.id}`;
}

function harnessPlacementId(slot: HarnessSlotDescriptor): string {
  return `harness_placement_${slot.id}`;
}

function harnessMessageBlockId(slot: HarnessSlotDescriptor): string {
  return `harness_message_${slot.id}`;
}

function toMessageBlockContent(placement: PlacementOutput): Record<string, unknown> {
  return toCanonicalPlacementContent(placement.content);
}

function toPlacementCtas(slot: HarnessSlotDescriptor, placement: PlacementOutput): HarnessAuthoredCta[] {
  const cta = canonicalPlacementCta(slot);
  const primaryLabel = placement.content.cta_label;
  const secondaryLabel = placement.content.secondary_cta_label;
  const ctas: HarnessAuthoredCta[] = [{
    label: typeof primaryLabel === 'string' ? primaryLabel : 'Take action',
    ...cta.authored,
  }];
  if (typeof secondaryLabel === 'string' && secondaryLabel.length > 0) {
    ctas.push({ label: secondaryLabel, path: 'dismiss' });
  }
  return ctas;
}

function toExportedTheme(theme: HarnessTheme): Theme {
  return {
    id: HARNESS_THEME_ID,
    name: 'Harness Theme',
    mode: theme.dark_mode ? 'dark' : 'light',
    tokens: {
      primary_color: theme.primary_color,
      accent_color: theme.accent_color,
      font_family: theme.font_family,
      border_radius: theme.border_radius,
    },
  };
}

function toPortableEntitlementType(type: EntitlementType): Playbook['entitlements'][number]['type'] {
  if (type === 'usage_pricing') return 'price_per_unit';
  if (type === 'usage_rate') return 'rate_limit';
  return type;
}

/** Serialise the full harness state into a canonical Playbook JSON-safe object. */
export function buildExportedConfig(params: {
  plans: HarnessPlan[];
  entitlements: HarnessEntitlement[];
  entitlementRules: HarnessEntitlementRule[];
  segments: HarnessSegment[];
  contentOverrides: Record<HarnessSlotId, Record<string, string>>;
  theme: HarnessTheme;
  slots: HarnessSlotDescriptor[];
}): Playbook {
  const nowIso = new Date().toISOString();
  const placementCatalog = buildHarnessPlacementCatalog(params.slots, params.contentOverrides);
  const planHandleById = new Map(params.plans.map((plan) => [plan.id, plan.unique_handle]));
  const entitlementHandleById = new Map(
    params.entitlements.map((entitlement) => [entitlement.id, entitlement.unique_handle]),
  );
  const segmentHandleById = new Map(params.segments.map((segment) => [segment.id, segment.handle]));
  const surfaceTemplates = [...new Map(params.slots.map((slot) => [
    harnessTemplateId(slot),
    {
      id: harnessTemplateId(slot),
      surface_type: slot.surfaceType,
      fields: Object.keys(placementCatalog[slot.id].content).sort().map((field) => ({
        name: field,
        type: 'string',
        required: false,
      })),
    },
  ])).values()];

  return {
    artifact_type: 'playbook',
    format_version: EXPORTED_CONFIG_VERSION,
    playbook_handle: 'default',
    playbook_version_id: null,
    tenant_id: 'tenant_harness',
    environment_id: 'default',
    exported_at: nowIso,
    plans: params.plans.map((p, index) => ({
      unique_handle: p.unique_handle,
      name: p.name,
      tier_position: index,
      sort_order: index,
      visibility: 'public',
    })),
    entitlements: params.entitlements.map((e) => ({
      unique_handle: e.unique_handle,
      name: e.name,
      type: toPortableEntitlementType(e.type),
      ...(e.unit ? { unit: e.unit } : {}),
    })),
    entitlement_rules: params.entitlementRules.map((r) => ({
      id: r.id,
      entitlement_id: entitlementHandleById.get(r.entitlement_id) ?? r.entitlement_id,
      targets: r.targets.map((target) => ({
        ...target,
        id: target.kind === 'plan'
          ? planHandleById.get(target.id) ?? target.id
          : target.id,
      })),
      segment_ids: r.segment_ids.map((segmentId) => segmentHandleById.get(segmentId) ?? segmentId),
      type_fields: r.type_fields as Record<string, unknown>,
      current_usage: r.current_usage,
    })),
    segments: params.segments.map((s) => ({
      name: s.name,
      handle: s.handle,
      ...(s.predicates && s.predicates.length > 0 ? { predicates: s.predicates } : {}),
    })),
    theme: toExportedTheme(params.theme),
    placement_slots: params.slots.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      surface_type: s.surfaceType,
      placement_handle: s.placementHandle,
      ...(s.template ? { template: s.template } : {}),
    })),
    surface_templates: surfaceTemplates,
    placements: params.slots.map((slot, order) => ({
      id: harnessPlacementId(slot),
      name: slot.label,
      category: canonicalPlacementCategory(slot),
      trigger: { type: 'surface_render', slot_id: slot.id },
      order,
      payloads: [{
        id: `harness_inline_${slot.id}`,
        target: { plan_ids: [], segment_chips: [] },
        surfaces: [{
          template_id: harnessTemplateId(slot),
          fields: {},
          ctas: toPlacementCtas(slot, placementCatalog[slot.id]),
        }],
        surface_slot_ids: [slot.id],
        recommendation_strategy: 'next_tier_up',
      }],
    })),
    message_blocks: params.slots.map((slot) => ({
      block_id: harnessMessageBlockId(slot),
      tenant_id: 'tenant_harness',
      name: `${slot.label} content`,
      surface_template_id: harnessTemplateId(slot),
      default_content: toMessageBlockContent(placementCatalog[slot.id]),
      status: 'active',
      created_at: nowIso,
      updated_at: nowIso,
    })),
    placement_payloads: params.slots.map((slot) => ({
      payload_id: `harness_content_${slot.id}`,
      placement_id: harnessPlacementId(slot),
      target: { plan_ids: [], segment_chips: [] },
      created_at: nowIso,
      updated_at: nowIso,
      source_mode: 'content_linked',
      surface_slot_ids: [slot.id],
      content_link: { message_block_id: harnessMessageBlockId(slot) },
    })),
    content_ui_paths: [],
  };
}

function defaultLegacyLocalState(slots: HarnessSlotDescriptor[]): HarnessLocalState {
  const activeSlots = slots.reduce<Record<HarnessSlotId, boolean>>((acc, slot) => {
    acc[slot.id] = false;
    return acc;
  }, {} as Record<HarnessSlotId, boolean>);
  const slotTriggers = slots.reduce<Record<HarnessSlotId, Set<string>>>((acc, slot) => {
    acc[slot.id] = new Set(DEFAULT_SLOT_TRIGGERS[slot.id] ?? []);
    return acc;
  }, {} as Record<HarnessSlotId, Set<string>>);
  return { activeSlots, slotTriggers };
}

function readLegacyLocalState(raw: unknown, slots: HarnessSlotDescriptor[]): HarnessLocalState | undefined { // sdk-ok: boundary-parse
  if (!isRecord(raw) || !Array.isArray(raw.slot_configs)) return undefined;

  const localState = defaultLegacyLocalState(slots);
  const knownSlotIds = new Set(slots.map((slot) => slot.id));
  for (const slotConfig of raw.slot_configs) {
    if (!isRecord(slotConfig) || typeof slotConfig.slot_id !== 'string') continue;
    if (!knownSlotIds.has(slotConfig.slot_id) || typeof slotConfig.active !== 'boolean') continue;

    localState.activeSlots[slotConfig.slot_id] = slotConfig.active;
    if (Array.isArray(slotConfig.triggers)) {
      localState.slotTriggers[slotConfig.slot_id] = new Set(
        slotConfig.triggers.filter((trigger): trigger is string => typeof trigger === 'string'),
      );
    }
  }
  return localState;
}

function applyMessageBlockContent(
  target: Record<EditableContentField, string>,
  content: Record<string, unknown>, // sdk-ok: boundary-parse
): void {
  for (const field of EDITABLE_CONTENT_FIELDS) {
    const value = field === 'title' ? content.header ?? content.title : content[field];
    if (typeof value === 'string') target[field] = value;
  }
}

function loadCanonicalContent(
  cfg: Playbook,
  slots: HarnessSlotDescriptor[],
): {
  contentOverrides: Record<HarnessSlotId, Record<EditableContentField, string>>;
  canonicalSlotIds: Set<string>;
} {
  const contentOverrides = buildDefaultContentOverrides(slots);
  const canonicalSlotIds = new Set<string>();
  const knownSlotIds = new Set(slots.map((slot) => slot.id));
  const blocksById = new Map((cfg.message_blocks ?? []).map((block) => [block.block_id, block]));
  const slotByPlacementId = new Map<string, string>();
  for (const placement of cfg.placements ?? []) {
    if (placement.trigger.type === 'surface_render') {
      slotByPlacementId.set(placement.id, placement.trigger.slot_id);
    }
  }

  for (const payload of cfg.placement_payloads ?? []) {
    const blockId = payload.content_link?.message_block_id;
    if (!blockId) continue;
    const block = blocksById.get(blockId);
    if (!block) continue;

    const explicitSlotId = payload.surface_slot_ids?.find((slotId) => knownSlotIds.has(slotId));
    const slotId = explicitSlotId ?? slotByPlacementId.get(payload.placement_id);
    if (!slotId || !knownSlotIds.has(slotId)) continue;

    applyMessageBlockContent(contentOverrides[slotId], block.default_content);
    canonicalSlotIds.add(slotId);
  }

  return { contentOverrides, canonicalSlotIds };
}

function applyLegacyContentOverrides(
  raw: unknown, // sdk-ok: boundary-parse
  contentOverrides: Record<HarnessSlotId, Record<EditableContentField, string>>,
  canonicalSlotIds: Set<string>,
): void {
  if (!isRecord(raw) || !isRecord(raw.content_overrides)) return;

  for (const [slotId, fields] of Object.entries(raw.content_overrides)) {
    if (canonicalSlotIds.has(slotId) || !(slotId in contentOverrides) || !isRecord(fields)) continue;
    applyMessageBlockContent(contentOverrides[slotId], fields);
  }
}

function legacyItemId(value: unknown, fallback: string): string { // sdk-ok: boundary-parse
  return isRecord(value) && typeof value.id === 'string' ? value.id : fallback;
}

function toHarnessEntitlementType(type: Playbook['entitlements'][number]['type']): EntitlementType {
  if (type === 'price_per_unit') return 'usage_pricing';
  if (type === 'rate_limit') return 'usage_rate';
  return type;
}

/**
 * Parse and validate a Playbook or legacy RevTurbineConfig, returning harness-ready
 * state slices.  Throws on invalid input.
 */
export function loadExportedConfig(raw: unknown): {
  plans: HarnessPlan[];
  entitlements: HarnessEntitlement[];
  entitlementRules: HarnessEntitlementRule[];
  segments: HarnessSegment[];
  legacyLocalState?: HarnessLocalState;
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
  const cfg = normalizeConfigArtifactOrThrow(raw, 'harness config', {
    tenantId: 'tenant_harness',
    environmentId: 'default',
  });
  if (!cfg) throw new Error('Invalid config: not an object');
  if (!Array.isArray(cfg.plans)) throw new Error('Invalid config: plans must be an array');
  if (!Array.isArray(cfg.entitlements)) throw new Error('Invalid config: entitlements must be an array');
  if (!Array.isArray(cfg.entitlement_rules)) throw new Error('Invalid config: entitlement_rules must be an array');
  if (!Array.isArray(cfg.segments)) throw new Error('Invalid config: segments must be an array');

  const plans: HarnessPlan[] = cfg.plans.map((p) => ({
    id: legacyItemId(p, p.unique_handle),
    unique_handle: String(p.unique_handle),
    name: String(p.name),
  }));

  const entitlements: HarnessEntitlement[] = cfg.entitlements.map((e) => ({
    id: legacyItemId(e, e.unique_handle),
    unique_handle: String(e.unique_handle),
    name: String(e.name),
    type: toHarnessEntitlementType(e.type),
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
    id: legacyItemId(s, s.handle),
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

  const legacyLocalState = readLegacyLocalState(raw, slots);
  const canonicalContent = loadCanonicalContent(cfg, slots);
  const contentOverrides = canonicalContent.contentOverrides;
  applyLegacyContentOverrides(raw, contentOverrides, canonicalContent.canonicalSlotIds);

  // Theme
  const theme: HarnessTheme = { ...DEFAULT_THEME };
  if (isRecord(cfg.theme)) {
    const tokens = isRecord(cfg.theme.tokens) ? cfg.theme.tokens : undefined;
    if (typeof tokens?.primary_color === 'string') theme.primary_color = tokens.primary_color;
    if (typeof tokens?.accent_color === 'string') theme.accent_color = tokens.accent_color;
    if (typeof tokens?.font_family === 'string') theme.font_family = tokens.font_family;
    if (typeof tokens?.border_radius === 'string') theme.border_radius = tokens.border_radius;
    if (cfg.theme.mode === 'dark' || cfg.theme.mode === 'light') {
      theme.dark_mode = cfg.theme.mode === 'dark';
    }

    // One-window compatibility for harness files written before canonical Theme tokens.
    const colors = isRecord(cfg.theme.colors) ? cfg.theme.colors : undefined;
    const typography = isRecord(cfg.theme.typography) ? cfg.theme.typography : undefined;
    const shape = isRecord(cfg.theme.shape) ? cfg.theme.shape : undefined;
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
    ...(legacyLocalState ? { legacyLocalState } : {}),
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
 * Attempt to load a previously-saved Playbook or RevTurbineConfig from localStorage.
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
 * Persist a Playbook or deprecated RevTurbineConfig to localStorage.
 */
export function saveConfigToLocalStorage(config: ConfigArtifact): void {
  try {
    localStorage.setItem(HARNESS_LOCALSTORAGE_KEY, JSON.stringify(config));
  } catch {
    // Silently ignore quota errors
  }
}

/** Load activation and trigger state independently from the portable Playbook. */
export function loadHarnessLocalState(defaults: HarnessLocalState): HarnessLocalState | null {
  try {
    const raw = localStorage.getItem(HARNESS_LOCALSTATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;

    const activeSlots = { ...defaults.activeSlots };
    if (isRecord(parsed.activeSlots)) {
      for (const [slotId, active] of Object.entries(parsed.activeSlots)) {
        if (slotId in activeSlots && typeof active === 'boolean') activeSlots[slotId] = active;
      }
    }

    const slotTriggers = Object.entries(defaults.slotTriggers).reduce<Record<HarnessSlotId, Set<string>>>(
      (acc, [slotId, triggers]) => {
        acc[slotId] = new Set(triggers);
        return acc;
      },
      {} as Record<HarnessSlotId, Set<string>>,
    );
    if (isRecord(parsed.slotTriggers)) {
      for (const [slotId, triggers] of Object.entries(parsed.slotTriggers)) {
        if (!(slotId in slotTriggers) || !Array.isArray(triggers)) continue;
        slotTriggers[slotId] = new Set(
          triggers.filter((trigger): trigger is string => typeof trigger === 'string'),
        );
      }
    }
    return { activeSlots, slotTriggers };
  } catch {
    return null;
  }
}

/** Persist activation and trigger state outside the portable Playbook. */
export function saveHarnessLocalState(state: HarnessLocalState): void {
  try {
    localStorage.setItem(HARNESS_LOCALSTATE_STORAGE_KEY, JSON.stringify({
      version: 1,
      activeSlots: state.activeSlots,
      slotTriggers: Object.fromEntries(
        Object.entries(state.slotTriggers).map(([slotId, triggers]) => [slotId, [...triggers].sort()]),
      ),
    }));
  } catch {
    // Silently ignore quota errors
  }
}
