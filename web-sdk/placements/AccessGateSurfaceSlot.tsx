'use client';

import React, { useMemo } from 'react';
import type { PersonalizationContext, PlacementUiPath } from './types';
import type { PlacementTypeRegistry } from './registry';
import type {
  RevTurbineContextMode,
  RevTurbineEntitlementContext,
  RevTurbinePlacementDecisionOverrides,
  RevTurbineSurfaceSlotConfig,
  EntitlementResult,
} from '../customer-side';
import { useSurfaceSlot } from './useSurfaceSlot';
import { useEntitlement } from '../react/useEntitlement';
import { useRevTurbine } from '../react/useRevTurbine';
import { useUsageSnapshot } from '../react/useUsageSnapshot';
import { GATED_SURFACE_TEMPLATE_IDS } from './surface-slot-constants';
import { AccessDeniedPlaceholder } from './AccessDeniedPlaceholder';

export { GATED_SURFACE_TEMPLATE_IDS };

// ── Types ────────────────────────────────────────────────────────────────

export type AccessGateCheck =
  | { entitlement: string; context?: RevTurbineEntitlementContext }
  | { usage: string; threshold: number };

export type AccessGateSurfaceSlotProps = {
  /** Required unique identifier for this render slot. */
  id: string;
  /** Optional human-readable slot label used for analytics/debugging. */
  name?: string;

  /**
   * Shorthand entitlement gate — `can="brand_kit"` is equivalent to
   * `check={{ entitlement: 'brand_kit' }}`, mirroring the `useCan('brand_kit')`
   * hook. Merged with `check` when both are supplied. Provide `can` or `check`.
   */
  can?: string;

  /**
   * One or more access checks to evaluate before granting access.
   *
   * - `{ entitlement: 'brand_kit' }` — check an entitlement handle.
   * - `{ usage: 'core_credits', threshold: 80 }` — check a usage percentage threshold.
   *
   * A Gate checks **one entitlement** (from `can` or from `check`); any number
   * of usage thresholds may be combined with it, and access is denied if any
   * of them fails. To require two entitlements, nest two Gates. A Gate given
   * more than one entitlement check is a developer error (BUG-1541): it fails
   * closed (renders as denied) and logs one `console.error` naming the Gate id
   * and the count. Optional when `can` is provided.
   */
  check?: AccessGateCheck | AccessGateCheck[];

  /**
   * What this check would consume, per call (never a Playbook field), for a
   * `usage_limit` or `credits` entitlement: a cost above 0 is allowed while
   * `usage + cost <= limit`; `0` is always allowed (free) with a developer
   * warning; leaving it out keeps the plain check (allowed while usage is below
   * the limit) and logs a developer error (`entitlement_cost_missing`), so pass
   * `cost={0}` for a free action. Other kinds and unlimited entitlements ignore
   * it. It wins over a `context.cost` in `check`.
   */
  cost?: number;

  /**
   * Placement to display when access is denied.
   * The slot fetches the gated placement from the decision engine.
   * If no placement matches, `deniedFallback` is shown; when it is omitted,
   * the default {@link AccessDeniedPlaceholder} renders instead (D-59).
   */
  deniedFallback?: React.ReactNode;

  /**
   * Rendered instead of `children` when the entitlement is `limited` — access is
   * still granted, the usage/credit balance is just running low. Use it for a soft
   * "running low" state (e.g. the feature plus a warning). When omitted, `limited`
   * renders `children` normally, since a `limited` user is still entitled; pass
   * `null` to render nothing.
   */
  limitedFallback?: React.ReactNode;

  /** Content to render when access is granted. */
  children: React.ReactNode;

  /**
   * Surface template IDs that this slot accepts.
   * Only placements matching one of these templates can render here.
   */
  surfaceTemplateIds?: string[];
  /** Optional metadata included in slot registration/upsert payloads. */
  metadata?: Record<string, unknown>; // sdk-ok: boundary-parse — customer-provided interaction metadata
  contextMode?: RevTurbineContextMode;
  overrides?: RevTurbinePlacementDecisionOverrides;
  traits?: Record<string, string | number | boolean>;
  personalization?: PersonalizationContext;
  registry?: PlacementTypeRegistry;
  onCtaClick?: (uiPath: PlacementUiPath) => void;
  /** Callback fired when a gate check denies access. */
  onDenied?: (result: EntitlementResult) => void;
  className?: string;
  style?: React.CSSProperties;
};

/** Gate ids already reported for an entitlement-count misconfiguration (BUG-1541), per page load. */
const reportedMisconfiguredGates = new Set<string>();

/**
 * Merge the `can` shorthand and the `check` prop into the effective check list:
 * `can="x"` becomes `{ entitlement: 'x' }`, and `check` is appended as-is.
 * Exported for unit testing.
 */
export function resolveGateChecks(
  can: string | undefined,
  check: AccessGateCheck | AccessGateCheck[] | undefined,
): AccessGateCheck[] {
  const checks: AccessGateCheck[] = [];
  if (can) checks.push({ entitlement: can });
  if (check) checks.push(...(Array.isArray(check) ? check : [check]));
  return checks;
}

/**
 * Access-gate surface slot — renders children when entitled (allowed *or*
 * `limited`), or a gated placement when access is `denied`.
 *
 * Checks entitlements and/or usage thresholds. On denial, displays the configured
 * gated placement (or `deniedFallback` if no placement matches). On success,
 * renders `children` — or `limitedFallback` when the entitlement is `limited`.
 *
 * @example
 * ```tsx
 * // `can` shorthand — mirrors useCan('mp4_download')
 * <AccessGateSurfaceSlot id="export-gate" can="mp4_download" deniedFallback={<span>Upgrade to export</span>}>
 *   <ExportButton />
 * </AccessGateSurfaceSlot>
 *
 * // soft-warn while still granting access when the balance runs low
 * <AccessGateSurfaceSlot id="credits-gate" can="core_credits" limitedFallback={<LowBalanceNotice />}>
 *   <RecordButton />
 * </AccessGateSurfaceSlot>
 *
 * <AccessGateSurfaceSlot
 *   id="usage-gate"
 *   check={[
 *     { entitlement: 'core_credits' },
 *     { usage: 'core_credits', threshold: 100 },
 *   ]}
 *   deniedFallback={<QuotaExhausted />}
 * >
 *   <RecordButton />
 * </AccessGateSurfaceSlot>
 * ```
 */
export function AccessGateSurfaceSlot({
  id,
  name,
  can,
  check,
  cost,
  children,
  deniedFallback,
  limitedFallback,
  surfaceTemplateIds,
  metadata,
  onDenied,
  ...options
}: AccessGateSurfaceSlotProps) {
  const checks = resolveGateChecks(can, check);
  const entitlementChecks = checks.filter(
    (c): c is Extract<AccessGateCheck, { entitlement: string }> => 'entitlement' in c,
  );
  const primaryEntitlement = entitlementChecks[0];
  // BUG-1541 (Kent and Mark, 2026-11-02): one entitlement per Gate; nest Gates
  // for two. A second entitlement check used to be dropped silently, so the
  // Gate could open without checking it. It is now a developer error: the Gate
  // fails closed and says so once.
  const entitlementCount = entitlementChecks.length;
  const misconfigured = entitlementCount > 1;
  React.useEffect(() => {
    if (!misconfigured) return;
    // Once per Gate id per session (page load), not once per mount: a list of
    // remounting Gates must not flood the console.
    const key = `${id}|${entitlementCount}`;
    if (reportedMisconfiguredGates.has(key)) return;
    reportedMisconfiguredGates.add(key);
    console.error(
      `[RevTurbine] <Gate id="${id}"> was given ${entitlementCount} entitlement checks, but a Gate checks exactly one entitlement. `
      + 'It fails closed (renders as denied). Nest one Gate inside another to require two entitlements.',
    );
  }, [misconfigured, entitlementCount, id]);

  // Use the entitlement hook for the primary entitlement check.
  // For pure-usage checks, we still use an entitlement handle if available;
  // usage thresholds are evaluated from the usage snapshot separately.
  const entitlementHandle = primaryEntitlement?.entitlement ?? '';
  const {
    result: entitlementResult,
    isLoading: entitlementLoading,
    error: entitlementError,
  } = useEntitlement({
    handle: entitlementHandle,
    context: primaryEntitlement?.context,
    // ST-1696 cost rule: the Gate's `cost` wins over a `context.cost` in `check`.
    cost,
    autoCheck: !!entitlementHandle,
    autoGate: true,
  });

  // Evaluate usage-threshold checks.
  const usageChecks = checks.filter(
    (c): c is Extract<AccessGateCheck, { usage: string }> => 'usage' in c,
  );
  const { usage } = useUsageSnapshot();
  const usageDenied = usageChecks.some((uc) => {
    const entry = usage[uc.usage];
    if (!entry || entry.limit == null || entry.limit === 0) return false;
    const pct = (entry.current / entry.limit) * 100;
    return pct >= uc.threshold;
  });

  // Access is denied when any check fails. `allowed: false` counts as a deny
  // regardless of status: an at-cap limit rule with blocking enforcement
  // (including the unset-enforcement default) resolves `limited` +
  // `allowed: false` — gating on status alone granted access at the cap
  // (plan 179 TASK-10).
  const entitlementDenied =
    !!entitlementHandle &&
    // A check that errored denies (plan 194 REQ-4) — the SDK is fail-closed,
    // and "we could not answer" is not a grant.
    (entitlementError !== null ||
      (!!entitlementResult &&
        (entitlementResult.status === 'denied' || entitlementResult.allowed === false)));
  // ST-1696: while a `user` promise is still PENDING the SDK answers every
  // check `user_id_required`. That is "the user is on its way", not a decision
  // about this user: the gate stays closed and silent (no children, no
  // fallback, no gate placement, no `onDenied`) and re-evaluates when the
  // promise settles or `identify()` arrives. Once the SDK is in the loud
  // missing-user error state (omitted / blank id, a rejected or blank-resolved
  // promise) the gate behaves as it did in 0.15.0: the denied path.
  const { sdk: gateSdk } = useRevTurbine();
  // A `user_id_required` answer is also stale (not a verdict) in the beat after
  // the user arrived but before this gate re-checked, so that case waits too.
  const userPending = entitlementResult?.reason === 'user_id_required'
    && typeof gateSdk?.isUserPending === 'function'
    && (gateSdk.isUserPending() || gateSdk.getUserContext().user_id !== '');
  const denied = !userPending && (entitlementDenied || usageDenied || misconfigured);
  // Limited — still entitled (degrade / running low), unless it also denies.
  const limited = !!entitlementHandle && entitlementResult?.status === 'limited';

  // Fire denied callback.
  const deniedCallbackRef = React.useRef(onDenied);
  deniedCallbackRef.current = onDenied;
  React.useEffect(() => {
    if (denied && entitlementResult) {
      deniedCallbackRef.current?.(entitlementResult);
    }
  }, [denied, entitlementResult]);

  // D-60: a gate placement fires only while access is denied or limited.
  // The slot reports its own check result so the resolver never has to guess.
  const entitlementStatus: 'denied' | 'limited' | 'allowed' | undefined = denied
    ? (entitlementResult?.status === 'limited' && !usageDenied && entitlementError === null ? 'limited' : 'denied')
    : entitlementResult?.status;

  // Load gated placement from the decision engine when denied.
  const surfaceSlot = useMemo<RevTurbineSurfaceSlotConfig>(
    () => ({
      id,
      name: name || id,
      surfaceTemplateIds: surfaceTemplateIds ?? (GATED_SURFACE_TEMPLATE_IDS as string[]),
      metadata: {
        ...metadata,
        surface_slot_category: 'gated',
        entitlement_handle: entitlementHandle ?? null,
        ...(entitlementStatus ? { entitlement_status: entitlementStatus } : {}),
      },
    }),
    [id, name, surfaceTemplateIds, metadata, entitlementHandle, entitlementStatus],
  );

  const {
    element: gatedElement,
    visible: gatedVisible,
    isLoading: gatedLoading,
    decision: gatedDecision,
    hiddenReason: gatedHiddenReason,
  } = useSurfaceSlot({
    ...options,
    autoLoad: denied,
    surfaceSlot,
  });

  // Deny until resolved — render nothing until a real answer exists.
  //
  // This used to key on `entitlementLoading` alone, which is false during
  // server rendering: the gate is constructed inside a `useEffect`, effects do
  // not run on the server, so there is no gate to be "loading". `result` was
  // null, `denied` computed false, and the gate emitted its CHILDREN into the
  // server HTML (plan 194 REQ-4).
  //
  // That is a fail-open in the one place the client cannot correct: a crawler
  // or a JS-disabled reader saw the paid affordance permanently, and everyone
  // else saw it flash until hydration closed the gate. It also contradicted
  // `useCan`'s own deny-until-ready contract.
  //
  // Keying on "no result yet" covers both the loading window and the
  // no-effects-ran window with one condition. `null` rather than
  // `deniedFallback` on purpose: the server has run no check, so rendering the
  // upsell would flash an upgrade prompt at users who are in fact entitled.
  // A SETTLED error is a decision, not a pending one: the check ran and could
  // not answer, so it denies and shows the fallback. Folding it into
  // "unresolved" would render nothing forever after a failed check — safe, but
  // a blank where the upsell belongs. `useCan` settles the same way
  // (`can: false`) when a check throws.
  const entitlementUnresolved =
    !!entitlementHandle && entitlementResult === null && entitlementError === null;
  if (entitlementUnresolved || (entitlementLoading && entitlementHandle)) return null;
  // Fail-closed while the user is pending (ST-1696, decision D-3): render
  // nothing even when `deniedFallback` is supplied, so the upsell never flashes
  // at a user who is entitled once the promise resolves.
  if (userPending) return null;

  // Granted (allowed, or limited with the evaluator's allowed verdict).
  if (!denied) {
    // Limited: still granted, but running low — show the soft-warn slot if given.
    if (limited && limitedFallback !== undefined) return <>{limitedFallback}</>;
    return <>{children}</>;
  }

  // Denied — render gated placement or fallback.
  if (gatedVisible && gatedElement) return <>{gatedElement}</>;
  if (deniedFallback !== undefined) return <>{deniedFallback}</>;
  // D-59: no Access Gate placement answered for this entitlement — show the
  // default denied state once the gate decision has settled, never a blank.
  if (!gatedLoading && gatedDecision && gatedHiddenReason === 'no_match') {
    return <AccessDeniedPlaceholder entitlementHandle={entitlementHandle} />;
  }
  return null;
}

AccessGateSurfaceSlot.displayName = 'AccessGateSurfaceSlot';
