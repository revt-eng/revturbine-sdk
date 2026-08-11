'use client';

import { useEntitlement, type UseEntitlementOptions, type UseEntitlementResult } from './useEntitlement';

/**
 * Result of {@link useCan} — the entitlement check reduced to the shape a `can`
 * question actually needs.
 */
export interface UseCanResult {
  /**
   * `true` when the user may proceed. This is `allowed || limited` (equivalently,
   * not `denied`): a `limited` entitlement still grants access — it just means the
   * usage/credit balance is running low. Deny-until-ready, matching the SDK's
   * fail-closed contract: `can` is `false` until the check resolves, and stays
   * `false` if the check errors. Evaluation is local to the loaded Playbook (no
   * per-check network call), so the unresolved window is one microtask once
   * initialization completes; in hosted mode the first load spans the initial
   * config fetch. Gate paywall UI on `!can && !isLoading` so entitled users never
   * see an upsell flash; never gate on `!allowed` (that would also block
   * `limited` users who are still entitled).
   */
  can: boolean;
  /**
   * `true` when access is granted but the balance is approaching its limit (the
   * "running low" state). Surface a soft warning while still allowing the action.
   */
  limited: boolean;
  /**
   * `true` until the entitlement check first resolves (including while the SDK
   * initializes), and again while a recheck is in flight. Settles to `false`
   * once a result — or an error — has landed. Pair with `can`:
   * `!can && isLoading` is "still deciding"; `!can && !isLoading` is a settled
   * deny.
   */
  isLoading: boolean;
  /**
   * The full entitlement result (`status`, `reason`, `current_tier`, `placement`,
   * …), or `null` until the check resolves — the escape hatch for details beyond
   * `can` / `limited`.
   */
  result: UseEntitlementResult['result'];
}

/**
 * Reactive counterpart to the imperative `rt.can(handle)` — the entitlement check
 * as a `can` question. Takes the entitlement handle positionally (matching
 * `rt.can('handle')`), plus the same options {@link useEntitlement} accepts, and
 * returns a curated `{ can, limited, isLoading, result }`.
 *
 * Deny-until-ready: `can` is `false` while the check is unresolved, flipping
 * within one microtask in local mode once the Playbook is in memory. Use
 * `isLoading` to distinguish "still deciding" from a settled deny.
 *
 * For the full reactive surface (`allowed` / `denied` / `error` /
 * `gatedPlacement` / `recheck`), use {@link useEntitlement} directly.
 *
 * @example
 * ```tsx
 * function BatchExport() {
 *   const { can, limited, isLoading } = useCan('batch_export');
 *   if (!can && isLoading) return null;   // still deciding — render nothing yet
 *   if (!can) return <UpgradePrompt />;   // settled deny
 *   return <BatchExportButton warnLowBalance={limited} />;
 * }
 * ```
 */
export function useCan(
  handle: string,
  options?: Omit<UseEntitlementOptions, 'handle'>,
): UseCanResult {
  const { denied, limited, result, isLoading, error } = useEntitlement({ handle, ...options });
  const resolved = result !== null;
  return {
    can: resolved && !denied,
    limited,
    isLoading: isLoading || (!resolved && error === null),
    result,
  };
}
