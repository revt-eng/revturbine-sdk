import type { ExportedConfig } from '@revt-eng/schema';
import type { DemoState } from './demo-state';
import { creditAllowanceFor, generationsLimitFor, seatLimitFor } from './derived';

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

function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
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
export function activeNudges(config: ExportedConfig, state: DemoState): ActiveNudge[] {
  const out: ActiveNudge[] = [];
  const onFree = state.planHandle === 'free';

  if (onFree) {
    // Generations usage meter.
    const limit = generationsLimitFor(config, 'free');
    const pct = usagePercent(state.generationsUsed, limit);
    const tokens = {
      usage_remaining: String(Math.max(0, limit - state.generationsUsed)),
      usage_limit: String(limit),
      usage_percent: String(pct),
      reset_date: 'next month',
    };
    if (pct >= 100) out.push({ placementId: 'pl_usage_100', surface: 'modal', tokens });
    else if (pct >= 80) out.push({ placementId: 'pl_usage_80', surface: 'toast', tokens });
    else if (pct >= 50) out.push({ placementId: 'pl_usage_50', surface: 'toast', tokens });

    // Style-credit balance (creditBalance is the REMAINING balance).
    const allowance = creditAllowanceFor(config, 'free');
    const remaining = state.creditBalance;
    const creditUsedPct = usagePercent(Math.max(0, allowance - remaining), allowance);
    const creditTokens = { usage_remaining: String(remaining), usage_limit: String(allowance) };
    if (remaining <= 0) out.push({ placementId: 'pl_credit_out', surface: 'modal', tokens: creditTokens });
    else if (creditUsedPct >= 80)
      out.push({ placementId: 'pl_credit_low', surface: 'banner', tokens: creditTokens });

    // Watermark inline gate — always shown to free-plan users.
    out.push({ placementId: 'pl_gate_watermark', surface: 'inline', tokens: {} });

    // Seat limit — Free includes 1 seat; firing once the seat is filled.
    if (state.seatsUsed >= seatLimitFor(config, 'free')) {
      out.push({ placementId: 'pl_seat_limit', surface: 'banner', tokens: {} });
    }
  }

  // Monthly-Pro → annual upsell qualifier banner.
  if (state.planHandle === 'pro' && state.custom.billing_period === 'monthly') {
    out.push({ placementId: 'pl_annual_nudge', surface: 'banner', tokens: {} });
  }

  // Trial nudges — driven by the Director's trial controls.
  if (state.trial.inTrial) {
    const trialTokens = { days_remaining: String(state.trial.daysRemaining) };
    if (state.trial.trialType === 'reverse') {
      // Reverse trial: premium unlocked without a plan change; nudge to keep it.
      out.push({ placementId: 'pl_reverse_trial', surface: 'banner', tokens: trialTokens });
    } else if (state.trial.daysRemaining <= 3) {
      // Free trial nearing its end.
      out.push({ placementId: 'pl_trial_ending', surface: 'banner', tokens: trialTokens });
    }
  }

  // Payment recovery (retention) — consumes the billing-failed segment.
  if (state.custom.billing_status === 'failed') {
    out.push({ placementId: 'pl_payment_recovery', surface: 'banner', tokens: {} });
  }

  return out;
}

/** Map a denied feature's entitlement handle to its click-driven gate modal. */
export function gatePlacementForHandle(handle: string): string | null {
  switch (handle) {
    case 'batch_export':
      return 'pl_gate_batch_export';
    case 'style_packs':
      return 'pl_gate_style_packs';
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
  config: ExportedConfig,
  placementId: string,
): { body: string; ctaLabel: string } {
  const surface = (config.placements ?? []).find((p) => p.id === placementId)?.payloads?.[0]?.surfaces?.[0];
  const secondaryBody = surface?.fields?.secondary_body;
  return {
    body: typeof secondaryBody === 'string' ? secondaryBody : '',
    ctaLabel: surface?.ctas?.[1]?.label ?? '',
  };
}
