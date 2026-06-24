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
import { useUsageSnapshot } from '../react/useUsageSnapshot';
import { GATED_SURFACE_TEMPLATE_IDS } from './surface-slot-constants';

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
   * One or more access checks to evaluate before granting access.
   *
   * - `{ entitlement: 'brand_kit' }` — check an entitlement handle.
   * - `{ usage: 'core_credits', threshold: 80 }` — check a usage percentage threshold.
   *
   * When an array is passed, access is denied if **any** check fails.
   */
  check: AccessGateCheck | AccessGateCheck[];

  /**
   * Placement to display when access is denied.
   * The slot fetches the gated placement from the decision engine.
   * If no placement matches, `deniedFallback` is shown.
   */
  deniedFallback?: React.ReactNode;

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

/**
 * Access-gate surface slot — renders children when entitled, or a gated
 * placement when access is denied.
 *
 * Checks entitlements and/or usage thresholds. On failure, displays the
 * configured gated placement (or `deniedFallback` if no placement matches).
 * On success, renders `children` unmodified.
 *
 * @example
 * ```tsx
 * <AccessGateSurfaceSlot
 *   id="export-gate"
 *   check={{ entitlement: 'mp4_download' }}
 *   deniedFallback={<span>Upgrade to export</span>}
 * >
 *   <ExportButton />
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
  check,
  children,
  deniedFallback = null,
  surfaceTemplateIds,
  metadata,
  onDenied,
  ...options
}: AccessGateSurfaceSlotProps) {
  const checks = Array.isArray(check) ? check : check ? [check] : [];
  const primaryEntitlement = checks.find(
    (c): c is Extract<AccessGateCheck, { entitlement: string }> => 'entitlement' in c,
  );

  // Use the entitlement hook for the primary entitlement check.
  // For pure-usage checks, we still use an entitlement handle if available;
  // usage thresholds are evaluated from the usage snapshot separately.
  const entitlementHandle = primaryEntitlement?.entitlement ?? '';
  const { result: entitlementResult, isLoading: entitlementLoading } = useEntitlement({
    handle: entitlementHandle,
    context: primaryEntitlement?.context,
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

  // Access is denied when any check fails.
  const entitlementDenied = !!entitlementHandle && entitlementResult?.status === 'denied';
  const denied = entitlementDenied || usageDenied;

  // Fire denied callback.
  const deniedCallbackRef = React.useRef(onDenied);
  deniedCallbackRef.current = onDenied;
  React.useEffect(() => {
    if (denied && entitlementResult) {
      deniedCallbackRef.current?.(entitlementResult);
    }
  }, [denied, entitlementResult]);

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
      },
    }),
    [id, name, surfaceTemplateIds, metadata, entitlementHandle],
  );

  const { element: gatedElement, visible: gatedVisible } = useSurfaceSlot({
    ...options,
    autoLoad: denied,
    surfaceSlot,
  });

  // While the entitlement check is loading, render nothing to avoid
  // a flash of children → gate content.
  if (entitlementLoading && entitlementHandle) return null;

  // Granted — render children.
  if (!denied) return <>{children}</>;

  // Denied — render gated placement or fallback.
  if (gatedVisible && gatedElement) return <>{gatedElement}</>;
  return <>{deniedFallback}</>;
}

AccessGateSurfaceSlot.displayName = 'AccessGateSurfaceSlot';
