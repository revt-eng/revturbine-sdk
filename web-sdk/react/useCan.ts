'use client';

import { useEntitlement, type UseEntitlementOptions, type UseEntitlementResult } from './useEntitlement';

/**
 * Verb-parity alias of {@link useEntitlement} — the reactive counterpart to the
 * imperative `rt.can(handle)`. Takes the entitlement handle positionally (matching
 * `rt.can('handle')`), plus the same options {@link useEntitlement} accepts, and
 * returns the identical reactive result (`allowed` / `denied` / `limited` /
 * `result` / `recheck` / …).
 *
 * Use this when you want the hook name to read like the `can` verb; it is a thin
 * wrapper with no behavioral difference from `useEntitlement({ handle })`.
 *
 * @example
 * ```tsx
 * function BrandKitSection() {
 *   const { allowed, denied, result } = useCan('brand_kit');
 *   if (denied) return <UpgradePrompt reason={result?.reason} />;
 *   return <BrandKitEditor />;
 * }
 * ```
 */
export function useCan(
  handle: string,
  options?: Omit<UseEntitlementOptions, 'handle'>,
): UseEntitlementResult {
  return useEntitlement({ handle, ...options });
}
