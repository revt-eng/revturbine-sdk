/**
 * The "why am I seeing this?" decision trace (plan 81 TASK-7). For every
 * rendered surface — keyed by its slot id (fixed slots) or placement id
 * (nudges / gates) — this maps the surface to the RevTurbine capability it
 * demonstrates, the condition that fired it, and the spec that defines it.
 * It is the playground's teaching layer: a viewer can connect each surface to
 * the capability without reading the SDK.
 */
export interface CapabilityTrace {
  /** The capability this surface demonstrates. */
  capability: string;
  /** Why it fired — the plan / segment / threshold / trial condition. */
  why: string;
  /** The spec that defines the capability. */
  spec: string;
}

const TRACES: Record<string, CapabilityTrace> = {
  // ── Fixed surface-render slots (keyed by slot id) ──────────────────────────
  header_upgrade_cta: {
    capability: 'Fixed placement',
    why: 'Persistent upgrade CTA shown to free-plan users.',
    spec: 'placement-studio-ui.md — Fixed placements',
  },
  quota_meter: {
    capability: 'Usage-limit meter',
    why: 'Live generations remaining against the plan’s monthly usage limit.',
    spec: 'plans-entitlements-studio-ui.md §2.3 — Usage limit',
  },
  credit_counter: {
    capability: 'Credits balance',
    why: 'Remaining style-credit balance for the current plan.',
    spec: 'plans-entitlements-studio-ui.md §2.3 — Credits',
  },
  sidebar: {
    capability: 'Segment targeting',
    why: 'Targeted to new users (segment seg_eng_new — first 3 days since signup).',
    spec: 'targeting-studio-ui.md §4.0 — Segments',
  },

  // ── Entitlement gates (keyed by placement id) ──────────────────────────────
  pl_gate_batch_export: {
    capability: 'Feature gate (hard)',
    why: 'batch_export is denied on Free (rule enabled:false); attempting it opens a blocking gate.',
    spec: 'sdk.md §3 — Access gates',
  },
  pl_gate_style_packs: {
    capability: 'Feature gate (soft)',
    why: 'style_packs is denied on Free; the soft gate offers an upgrade but lets you continue.',
    spec: 'sdk.md §3 — Access gates',
  },
  pl_gate_watermark: {
    capability: 'Capability tier',
    why: 'Free is on the Watermarked-720p tier; Pro unlocks the Clean-4K tier.',
    spec: 'plans-entitlements-studio-ui.md §2.3 — Capability tier',
  },
  pl_rate_limit: {
    capability: 'Rate limit (hard)',
    why: 'Free is capped at 3 generations/min (burst_rate, hard_block); exceeding it opens a blocking gate.',
    spec: 'plans-entitlements-studio-ui.md §2.3 — Rate limit',
  },

  // ── Usage / credit threshold nudges ────────────────────────────────────────
  pl_usage_50: {
    capability: 'Usage threshold',
    why: 'Free plan crossed 50% of the generations usage limit.',
    spec: 'overall-app-ux-structure.md §3.4 — Usage alerts',
  },
  pl_usage_80: {
    capability: 'Usage threshold',
    why: 'Free plan crossed 80% of the generations usage limit.',
    spec: 'overall-app-ux-structure.md §3.4 — Usage alerts',
  },
  pl_usage_100: {
    capability: 'Usage threshold (hard)',
    why: 'Free plan reached 100% of the generations usage limit (hard_block).',
    spec: 'plans-entitlements-studio-ui.md §2.3 — Enforcement',
  },
  pl_credit_low: {
    capability: 'Credit threshold',
    why: 'Free plan spent 80% of its style credits.',
    spec: 'overall-app-ux-structure.md §3.4 — Credit alerts',
  },
  pl_credit_out: {
    capability: 'Credit threshold (exhausted)',
    why: 'Free plan’s style credits are exhausted; offers a top-up or upgrade.',
    spec: 'plans-entitlements-studio-ui.md §2.3 — Credits',
  },
  pl_overage_active: {
    capability: 'Usage overage (price_per_unit)',
    why: 'A Pro/Enterprise user passed their included generations; further use bills per image (allow_overage).',
    spec: 'plans-entitlements-studio-ui.md §2.3 — Overage pricing',
  },
  pl_usage_80_pro: {
    capability: 'Usage threshold (Pro)',
    why: 'A Pro plan crossed 80% of its 2,000 monthly generations.',
    spec: 'overall-app-ux-structure.md §3.4 — Usage alerts',
  },
  pl_credit_low_pro: {
    capability: 'Credit threshold (Pro)',
    why: 'A Pro plan spent 80% of its 1,000 monthly style credits.',
    spec: 'overall-app-ux-structure.md §3.4 — Credit alerts',
  },
  pl_credit_out_pro: {
    capability: 'Credit threshold exhausted (Pro)',
    why: 'A Pro plan’s 1,000 monthly style credits are exhausted; offers a top-up or Enterprise.',
    spec: 'plans-entitlements-studio-ui.md §2.3 — Credits',
  },
  pl_seat_limit_pro: {
    capability: 'Seat limit (Pro)',
    why: 'The Pro plan’s 5-seat cap is filled; Enterprise unlocks unlimited seats.',
    spec: 'plans-entitlements-studio-ui.md §2.3 — Seat',
  },

  // ── Conversion / trials / retention / seat ─────────────────────────────────
  pl_annual_nudge: {
    capability: 'Qualifier + segment',
    why: 'Monthly Pro subscriber (segment seg_plan_nudge_annual) — nudged to annual billing.',
    spec: 'placement-studio-ui.md — Conversion / expansion',
  },
  pl_sidebar_engagement: {
    capability: 'Segment targeting',
    why: 'Targeted to new users (seg_eng_new).',
    spec: 'targeting-studio-ui.md §4.0 — Segments',
  },
  pl_reverse_trial: {
    capability: 'Reverse trial',
    why: 'Premium entitlements are granted on the Free plan during the reverse trial (no plan change).',
    spec: 'plans-entitlements-studio-ui.md §2.4 — Trials',
  },
  pl_trial_ending: {
    capability: 'Free trial',
    why: 'A free trial is within its final days; nudged to convert before it ends.',
    spec: 'plans-entitlements-studio-ui.md §2.4 — Trials',
  },
  pl_payment_recovery: {
    capability: 'Retention (payment recovery)',
    why: 'Billing failed (segment seg_billing_failed); a non-dismissible banner asks to update payment.',
    spec: 'placement-studio-ui.md — Retention',
  },
  pl_seat_limit: {
    capability: 'Seat limit',
    why: 'The Free plan’s seat cap (1) is filled; upgrade to Pro for 5 seats.',
    spec: 'plans-entitlements-studio-ui.md §2.3 — Seat',
  },
};

/** The decision trace for a rendered surface, by slot id or placement id. */
export function traceFor(key: string): CapabilityTrace | null {
  return TRACES[key] ?? null;
}

/** All keys with a trace — used by the trace-coverage test. */
export function tracedKeys(): string[] {
  return Object.keys(TRACES);
}
