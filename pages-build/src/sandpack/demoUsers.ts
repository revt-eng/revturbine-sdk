import type { DemoUserId } from './shared';
import type { UserUsageEntry, UserPlanContext, UserTrialStatus } from '@revt-eng/schema';

/* ── Demo user context ────────────────────────────────────────────────── */

/**
 * Demo user context uses the canonical schema types directly.
 *
 * Omits the persistence envelope fields (`tenant_id`, `user_id`,
 * `created_at`, `updated_at`) since those are supplied by the SDK.
 */
export type DemoUserContext = {
  id: DemoUserId;
  plan: UserPlanContext;
  usage: Record<string, UserUsageEntry>;
  trial: UserTrialStatus;
  entitlements: Record<string, boolean>;
  email_type?: string;
  custom: Record<string, string | number | boolean | null>;
  personalization?: Record<string, string | number>;
};

export type DemoUser = {
  label: string;
  context: DemoUserContext;
};

/* ── Usage entry helper ───────────────────────────────────────────────── */

function usageEntry(
  entitlement_handle: string,
  unit: string,
  amount: number,
  limit?: number,
  reset_date?: string,
): UserUsageEntry {
  return { entitlement_handle, unit, amount, ...(limit !== undefined ? { limit } : {}), ...(reset_date ? { reset_date } : {}) };
}

/* ── Demo user data ───────────────────────────────────────────────────── */

export const demoUsers = {
  user_alice: {
    label: 'Alice (Professional / owner)',
    context: {
      id: 'user_alice',
      plan: { id: 'professional', name: 'Professional' },
      usage: {
        core_credits: usageEntry('core_credits', 'credits', 20, 30, '2026-05-01'),
        premium_credits: usageEntry('premium_credits', 'credits', 3, 10, '2026-05-01'),
      },
      trial: { in_trial: false, trial_type: 'reverse', state: 'expired', day_number: 21, days_remaining: 0 },
      entitlements: {
        data_export: true,
        bulk_export: true,
        brand_kit: true,
        analytics: true,
        branding: true,
      },
      email_type: 'business',
      custom: {
        displayName: 'Alice',
        role: 'owner',
        manage_billing: true,
        manage_seats: true,
        canOrgPurchaseCredits: true,
      },
      personalization: { first_name: 'Alice' },
    },
  },
  user_bob: {
    label: 'Bob (Professional / editor)',
    context: {
      id: 'user_bob',
      plan: { id: 'professional', name: 'Professional' },
      usage: {
        core_credits: usageEntry('core_credits', 'credits', 10, 30, '2026-05-01'),
        premium_credits: usageEntry('premium_credits', 'credits', 1, 10, '2026-05-01'),
      },
      trial: { in_trial: false, trial_type: 'reverse', state: 'expired', day_number: 18, days_remaining: 0 },
      entitlements: {
        data_export: true,
        bulk_export: true,
        brand_kit: true,
        analytics: true,
        branding: true,
      },
      email_type: 'business',
      custom: {
        displayName: 'Bob',
        role: 'editor',
        manage_billing: false,
        manage_seats: false,
        canOrgPurchaseCredits: false,
      },
      personalization: { first_name: 'Bob' },
    },
  },
  user_carol: {
    label: 'Carol (Starter / admin)',
    context: {
      id: 'user_carol',
      plan: { id: 'starter', name: 'Starter' },
      usage: {
        core_credits: usageEntry('core_credits', 'credits', 24, 30, '2026-05-01'),
        premium_credits: usageEntry('premium_credits', 'credits', 5, 5, '2026-05-01'),
      },
      trial: { in_trial: true, trial_type: 'reverse', state: 'active', day_number: 4, days_remaining: 4 },
      entitlements: {
        data_export: false,
        bulk_export: false,
        brand_kit: false,
        analytics: false,
        branding: false,
      },
      email_type: 'business',
      custom: {
        displayName: 'Carol',
        role: 'admin',
        manage_billing: false,
        manage_seats: false,
        canOrgPurchaseCredits: false,
      },
      personalization: { first_name: 'Carol' },
    },
  },
  user_dan: {
    label: 'Dan (Starter / viewer)',
    context: {
      id: 'user_dan',
      plan: { id: 'starter', name: 'Starter' },
      usage: {
        core_credits: usageEntry('core_credits', 'credits', 26, 30, '2026-05-01'),
        premium_credits: usageEntry('premium_credits', 'credits', 5, 5, '2026-05-01'),
      },
      trial: { in_trial: false, trial_type: 'reverse', state: 'expired', day_number: 16, days_remaining: 2 },
      entitlements: {
        data_export: false,
        bulk_export: false,
        brand_kit: false,
        analytics: false,
        branding: false,
      },
      email_type: 'personal',
      custom: {
        displayName: 'Dan',
        role: 'viewer',
        manage_billing: false,
        manage_seats: false,
        canOrgPurchaseCredits: false,
      },
      personalization: { first_name: 'Dan' },
    },
  },
  user_eve: {
    label: 'Eve (Enterprise / admin)',
    context: {
      id: 'user_eve',
      plan: { id: 'enterprise', name: 'Enterprise' },
      usage: {
        core_credits: usageEntry('core_credits', 'credits', 0, 999999, '2026-05-01'),
        premium_credits: usageEntry('premium_credits', 'credits', 0, 125, '2026-05-01'),
      },
      trial: { in_trial: false, trial_type: 'reverse', state: 'expired', day_number: 30, days_remaining: 0 },
      entitlements: {
        data_export: true,
        bulk_export: true,
        brand_kit: true,
        analytics: true,
        branding: true,
        sso_saml: true,
        custom_data_residency: true,
        dedicated_csm: true,
        collaboration: true,
      },
      email_type: 'business',
      custom: {
        displayName: 'Eve',
        role: 'admin',
        manage_billing: true,
        manage_seats: true,
        canOrgPurchaseCredits: true,
      },
      personalization: { first_name: 'Eve' },
    },
  },
  user_frank: {
    label: 'Frank (Enterprise / editor)',
    context: {
      id: 'user_frank',
      plan: { id: 'enterprise', name: 'Enterprise' },
      usage: {
        core_credits: usageEntry('core_credits', 'credits', 0, 999999, '2026-05-01'),
        premium_credits: usageEntry('premium_credits', 'credits', 0, 125, '2026-05-01'),
      },
      trial: { in_trial: false, trial_type: 'reverse', state: 'expired', day_number: 27, days_remaining: 0 },
      entitlements: {
        data_export: true,
        bulk_export: true,
        brand_kit: true,
        analytics: true,
        branding: true,
        sso_saml: true,
        custom_data_residency: true,
        dedicated_csm: true,
        collaboration: true,
      },
      email_type: 'business',
      custom: {
        displayName: 'Frank',
        role: 'editor',
        manage_billing: false,
        manage_seats: false,
        canOrgPurchaseCredits: false,
      },
      personalization: { first_name: 'Frank' },
    },
  },
} satisfies Record<DemoUserId, DemoUser>;
