/**
 * @module @revt-eng/web-sdk/views
 *
 * The decision shapes a caller reads, independent of *how* the decision was
 * obtained (plan 186 TASK-1).
 *
 * A React hook resolves a decision over time, so its result carries lifecycle
 * fields — `isLoading`, `error`, a re-run callback. A server-rendered caller
 * awaits the decision, so it has none of those: by the time it holds a value,
 * the value is final. What both share is the decision itself, and that shared
 * part lives here.
 *
 * This module deliberately contains **types only and no runtime imports**, and
 * deliberately sits outside `react/`. Every module under `react/` opens with
 * `'use client'`, so a React Server Component importing one receives an opaque
 * client reference rather than a usable value — the server binding could not
 * reuse these shapes if they stayed there.
 *
 * Plan: docs/dev-lifecycle/inprogress/186-server-rendering-sdk-and-api-token-management.md
 */

import type {
  EntitlementResult,
  PlacementOutput,
  RevTurbinePlacementContent,
  RevTurbinePlacementDecision,
} from './customer-side';

/**
 * A resolved entitlement decision.
 *
 * The three booleans are conveniences over {@link EntitlementView.result} and
 * are mutually exclusive once resolved. Note that `allowed` and `limited` are
 * not opposites: a `limited` result still grants access when the evaluator
 * permits it, so gate paywall UI on `denied`, never on `!allowed`.
 *
 * Callers that need to distinguish "denied" from "not yet decided" want the
 * client-side {@link UseEntitlementResult}, whose `isLoading` carries that
 * distinction. On the server the question does not arise — the value is awaited,
 * so it is always decided.
 */
export interface EntitlementView {
  /** The full entitlement result from the evaluator. `null` until resolved. */
  result: EntitlementResult | null;
  /** `true` when the entitlement is allowed outright. */
  allowed: boolean;
  /** `true` when access is granted but the balance is approaching its limit. */
  limited: boolean;
  /** `true` when the entitlement is denied. */
  denied: boolean;
  /** The upgrade surface to render on denial, when one was resolved. */
  gatedPlacement: PlacementOutput | null;
}

/**
 * A resolved placement decision.
 *
 * Carries what to render and whether to render it — not how to interact with
 * it. Interaction callbacks (`dismiss`, `ctaClick`, …) and viewport-exposure
 * wiring are inherently client-side and live on
 * {@link UsePlacementResult} instead.
 */
export interface PlacementView {
  /** The resolved placement identifier. */
  placementId: string;
  /** Whether the placement should be rendered. */
  visible: boolean;
  /** The full decision from the engine. `null` until resolved. */
  decision: RevTurbinePlacementDecision | null;
  /** Resolved content with personalization tokens expanded. `null` until resolved. */
  content: RevTurbinePlacementContent['content'] | null;
}
