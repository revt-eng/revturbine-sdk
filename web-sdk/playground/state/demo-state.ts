/** Plan handles defined by the Prism demo config. */
export type PrismPlanHandle = 'free' | 'pro' | 'enterprise';

/** Email classification read by the email-type segments. */
export type EmailType = 'business' | 'personal';

/** Simulated billing health read by the billing segments. */
export type BillingStatus = 'ok' | 'late' | 'failed';

/** Simulated billing cadence read by the monthly→annual nudge segment. */
export type BillingPeriod = 'monthly' | 'annual';

/** Trial kind, mirroring the SDK's free/reverse trial model. */
export type TrialKind = 'free' | 'reverse';

/**
 * Custom segmentation attributes surfaced to the SDK as `UserContext.custom`.
 *
 * The Prism config's segment predicates read these exact field names: the
 * scaffold targeting builder spreads `custom` into the flat segment-evaluation
 * traits, so these keys are a contract with
 * `revturbine-demo-data/customers/prism/export-config.json`. Keep them in sync.
 */
export interface PrismCustomTraits {
  email_type: EmailType;
  engagement_score: number;
  days_since_signup: number;
  days_since_active: number;
  has_purchased: boolean;
  billing_status: BillingStatus;
  billing_period: BillingPeriod;
}

/** Free/reverse trial simulation state. */
export interface PrismTrialState {
  inTrial: boolean;
  trialType: TrialKind | null;
  dayNumber: number;
  daysRemaining: number;
}

/**
 * The single source of truth for the playground. Held by `DemoProvider`,
 * persisted to localStorage, and mapped into the SDK `UserContext` + trial
 * status on every change.
 */
export interface DemoState {
  userId: string;
  planHandle: PrismPlanHandle;
  /** Generations consumed this period (drives the usage meter + thresholds). */
  generationsUsed: number;
  /** Remaining style-credit balance (drives the credit counter + thresholds). */
  creditBalance: number;
  /** Team seats in use (drives the seat-limit nudge against the plan's seat cap). */
  seatsUsed: number;
  custom: PrismCustomTraits;
  trial: PrismTrialState;
}

/** The default starting point: a brand-new, free-plan, personal-email user. */
export const DEFAULT_DEMO_STATE: DemoState = {
  userId: 'prism-demo-user',
  planHandle: 'free',
  generationsUsed: 0,
  creditBalance: 20,
  seatsUsed: 0,
  custom: {
    email_type: 'personal',
    engagement_score: 40,
    days_since_signup: 1,
    days_since_active: 0,
    has_purchased: false,
    billing_status: 'ok',
    billing_period: 'monthly',
  },
  trial: {
    inTrial: false,
    trialType: null,
    dayNumber: 0,
    daysRemaining: 0,
  },
};

/** Narrowing guard for plan-handle values coming out of form controls. */
export function isPrismPlanHandle(value: string): value is PrismPlanHandle {
  return value === 'free' || value === 'pro' || value === 'enterprise';
}

/**
 * A stable key over every context dimension the SDK resolves placements
 * against: plan, usage, credits, all segmentation traits, and trial state. The
 * playground uses this as the `RevTurbineProvider` `key`, so the SDK subtree
 * remounts and re-resolves every placement whenever a Director control changes
 * — including the segmentation + trial dimensions that have no dedicated slot
 * yet. Listed field-by-field (not a blanket `JSON.stringify(state)`) so it is
 * obvious — and testable — which dimensions force a re-resolution.
 */
export function resolutionKey(state: DemoState): string {
  const { custom: c, trial: t } = state;
  return JSON.stringify([
    state.planHandle,
    state.generationsUsed,
    state.creditBalance,
    state.seatsUsed,
    c.email_type,
    c.engagement_score,
    c.days_since_signup,
    c.days_since_active,
    c.has_purchased,
    c.billing_status,
    c.billing_period,
    t.inTrial,
    t.trialType,
    t.dayNumber,
    t.daysRemaining,
  ]);
}
