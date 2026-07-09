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
   * usage/credit balance is running low. Fail-open, matching the SDK: `can` is also
   * `true` before the check resolves and if the entitlement service is unreachable.
   * Gate on `!can` to block; never gate on `!allowed` (that would also block
   * `limited` users who are still entitled).
   */
  can: boolean;
  /**
   * `true` when access is granted but the balance is approaching its limit (the
   * "running low" state). Surface a soft warning while still allowing the action.
   */
  limited: boolean;
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
 * returns a curated `{ can, limited, result }`.
 *
 * For the full reactive surface (`allowed` / `denied` / `isLoading` / `error` /
 * `gatedPlacement` / `recheck`), use {@link useEntitlement} directly.
 *
 * @example
 * ```tsx
 * function BatchExport() {
 *   const { can, limited } = useCan('batch_export');
 *   if (!can) return <UpgradePrompt />;
 *   return <BatchExportButton warnLowBalance={limited} />;
 * }
 * ```
 */
export function useCan(
  handle: string,
  options?: Omit<UseEntitlementOptions, 'handle'>,
): UseCanResult {
  const { denied, limited, result } = useEntitlement({ handle, ...options });
  return { can: !denied, limited, result };
}
