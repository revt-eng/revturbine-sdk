import type { RevTurbineConfig } from '@revt-eng/schema';
import {
  REVERSE_TRIAL_PROMPT_DAY,
  trialDaysRemaining,
  type DemoState,
  type PrismPlanHandle,
} from './demo-state';
import { seatLimitFor } from './derived';

/** How a nudge placement should be presented on the Prism stage. */
export type NudgeSurface = 'toast' | 'banner' | 'modal' | 'inline';

/** A placement the playground should currently render, resolved by id. */
export interface ActiveNudge {
  /** Placement id in the Prism config (resolved by name via the SDK). */
  placementId: string;
  surface: NudgeSurface;
  /**
   * Personalization tokens the SDK content references (e.g. `{{usage_remaining}}`).
   * The playground supplies these because it owns the live usage numbers; the
   * SDK owns the copy + CTA.
   */
  tokens: Record<string, string>;
}


/**
 * Compute which threshold / qualifier / inline-gate placements should render
 * right now, from the simulated user state (plan 81 TASK-3).
 *
 * The local-runtime resolver selects placements by template / entitlement /
 * plan — it does **not** compare a placement's `threshold_percent` against live
 * usage. So the playground, standing in for the customer app that owns usage
 * tracking, decides which tier fired and asks the SDK for that specific
 * placement by id. One usage nudge and one credit nudge at a time (highest
 * crossed tier wins); the click-driven feature-gate modals are handled
 * separately (see {@link gatePlacementForHandle}).
 */
export function activeNudges(config: RevTurbineConfig, state: DemoState): ActiveNudge[] {
  const out: ActiveNudge[] = [];
  const onFree = state.planHandle === 'free';

  if (onFree) {
    // Usage + credit proximity warnings now live in the smart rail (see
    // pickSmartRail). The nudge host keeps the always-on watermark notice.
    out.push({ placementId: 'pl_gate_watermark', surface: 'inline', tokens: {} });
  }

  // Seat limit — fires on any plan with a finite seat cap once it is filled
  // (Free 1, Pro 5; Enterprise is effectively unlimited so it never trips).
  const seatCap = seatLimitFor(config, state.planHandle);
  if (seatCap < 999999 && state.seatsUsed >= seatCap) {
    out.push({
      placementId: state.planHandle === 'free' ? 'pl_seat_limit' : 'pl_seat_limit_pro',
      surface: 'banner',
      tokens: {},
    });
  }

  // Monthly-Pro → annual upsell qualifier banner. No special-casing for trials:
  // banners compete for the single banner slot below, so a more urgent banner
  // (e.g. the reverse-trial one) simply outranks this.
  if (state.planHandle === 'pro' && state.custom.billing_period === 'monthly') {
    out.push({ placementId: 'pl_annual_nudge', surface: 'banner', tokens: {} });
  }

  // Reverse trial (premium unlocked — a positive banner) stays in the nudge
  // host; the free-trial-ending proximity warning moved to the smart rail.
  // A reverse trial starts at signup (config start_policy: "signup"), so its
  // countdown tracks days_since_signup — advancing that slider counts it down —
  // and the banner retires once the trial window has elapsed.
  if (state.trial.inTrial && state.trial.trialType === 'reverse') {
    const daysLeft = trialDaysRemaining(state.custom.days_since_signup);
    if (daysLeft > 0) {
      // Early in the trial, an ambient "you're trying Pro" banner. From the
      // prompt day onward (config show_upgrade_prompt_at_day), escalate to a
      // blocking conversion modal — convert before the trial ends.
      if (state.custom.days_since_signup >= REVERSE_TRIAL_PROMPT_DAY) {
        out.push({
          placementId: 'pl_trial_ending',
          surface: 'modal',
          tokens: { days_remaining: String(daysLeft) },
        });
      } else {
        out.push({
          placementId: 'pl_reverse_trial',
          surface: 'banner',
          tokens: { days_remaining: String(daysLeft) },
        });
      }
    }
  }

  // Payment recovery (retention) — consumes the billing-failed segment.
  if (state.custom.billing_status === 'failed') {
    out.push({ placementId: 'pl_payment_recovery', surface: 'banner', tokens: {} });
  }

  // Banners compete for the single banner slot rather than stacking — the most
  // urgent one wins (mirroring the engine's single-slot ranking, not a config
  // dedup). Inline + modal surfaces are unaffected.
  return pickWinningBanner(out);
}

/**
 * Priority for the one banner slot — higher wins. Payment recovery is the most
 * urgent (account-blocking retention); a hit limit (seat) beats trial status,
 * which beats the soft annual upsell.
 */
const BANNER_PRIORITY: Record<string, number> = {
  pl_payment_recovery: 4,
  pl_seat_limit: 3,
  pl_seat_limit_pro: 3,
  pl_reverse_trial: 2,
  pl_annual_nudge: 1,
};

/** Keep only the highest-priority banner; leave inline/modal surfaces intact. */
function pickWinningBanner(nudges: ActiveNudge[]): ActiveNudge[] {
  const banners = nudges.filter((n) => n.surface === 'banner');
  if (banners.length <= 1) return nudges;
  const winner = banners.reduce((best, b) =>
    (BANNER_PRIORITY[b.placementId] ?? 0) > (BANNER_PRIORITY[best.placementId] ?? 0) ? b : best,
  );
  return nudges.filter((n) => n.surface !== 'banner' || n === winner);
}

/**
 * Map a blocked action's handle to its click-driven gate modal. Usage/credit
 * exhaustion is plan-aware (Free vs the paid variants); the feature/rate gates
 * are the same on every plan.
 */
export function gatePlacementForHandle(handle: string, planHandle: PrismPlanHandle = 'free'): string | null {
  const paid = planHandle !== 'free';
  switch (handle) {
    case 'batch_export':
      return 'pl_gate_batch_export';
    case 'style_packs':
      return 'pl_gate_style_packs';
    case 'burst_rate':
      return 'pl_rate_limit';
    case 'generations':
      // Only Free hard-blocks at the cap (paid plans continue into overage), so
      // the usage gate is always the Free 100% placement.
      return 'pl_usage_100';
    case 'credits':
      return paid ? 'pl_credit_out_pro' : 'pl_credit_out';
    default:
      return null;
  }
}

/** Replace `{{token}}` references in placement copy with the supplied values. */
export function interpolate(text: string, tokens: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) =>
    key in tokens ? tokens[key] : whole,
  );
}

/**
 * The authored secondary body + second CTA label for a modal placement, read
 * straight from the config. The local-runtime decision content only carries
 * `header` / `body` / `cta_label`, so a two-CTA modal's `secondary_body` and
 * second CTA never reach the SDK decision — the playground sources them from
 * the bundled config (which it owns) to render the modal as authored.
 */
export function authoredSecondary(
  config: RevTurbineConfig,
  placementId: string,
): { body: string; ctaLabel: string } {
  const surface = (config.placements ?? []).find((p) => p.id === placementId)?.payloads?.[0]?.surfaces?.[0];
  const secondaryBody = surface?.fields?.secondary_body;
  return {
    body: typeof secondaryBody === 'string' ? secondaryBody : '',
    ctaLabel: surface?.ctas?.[1]?.label ?? '',
  };
}
