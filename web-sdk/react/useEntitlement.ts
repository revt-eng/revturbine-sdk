'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRevTurbine } from './useRevTurbine';
import { EntitlementGate } from '../controllers';
import type {
  EntitlementResult,
  PlacementOutput,
  RevTurbineEntitlementContext,
  RevTurbinePlacementRequestConfig,
} from '../customer-side';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface UseEntitlementOptions {
  /** The entitlement handle to check (e.g. 'brand_kit', 'mp4_download'). */
  handle: string;
  /** Optional context (usage, required tier, etc.). */
  context?: RevTurbineEntitlementContext;
  /** Whether to fetch automatically on mount. Defaults to `true`. */
  autoCheck?: boolean;
  /**
   * When true, auto-resolve and return a gated placement for denied entitlements.
   * Defaults to `false` for backward compatibility.
   */
  autoGate?: boolean;
  /**
   * Optional placement request fields used when auto-gating needs to fetch
   * a placement and one is not attached directly to the entitlement response.
   */
  gatePlacementRequest?: Omit<RevTurbinePlacementRequestConfig, 'entitlementHandle'>;
}

export interface UseEntitlementResult {
  /** Whether the entitlement check is in progress. */
  isLoading: boolean;
  /** Error message if the check failed. */
  error: string | null;
  /** The entitlement result from the SDK. `null` until resolved. */
  result: EntitlementResult | null;
  /** Convenience: `true` when the entitlement is allowed. */
  allowed: boolean;
  /** Convenience: `true` when usage is limited (partially exhausted). */
  limited: boolean;
  /** Convenience: `true` when the entitlement is denied. */
  denied: boolean;
  /** Resolved gated placement when `denied` and `autoGate` are active. */
  gatedPlacement: PlacementOutput | null;
  /** Re-run the entitlement check. */
  recheck: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

/**
 * React hook that wraps `sdk.checkEntitlement()`.
 *
 * Returns a reactive entitlement result that can drive access-gate UI.
 *
 * @example
 * ```tsx
 * function BrandKitSection() {
 *   const { allowed, denied, result } = useEntitlement({ handle: 'brand_kit' });
 *   if (denied) return <UpgradePrompt reason={result?.reason} />;
 *   return <BrandKitEditor />;
 * }
 * ```
 */
export function useEntitlement({
  handle,
  context,
  autoCheck = true,
  autoGate = false,
  gatePlacementRequest,
}: UseEntitlementOptions): UseEntitlementResult {
  const { sdk, isReady } = useRevTurbine();
  const [, forceUpdate] = useState(0);
  const gateRef = useRef<EntitlementGate | null>(null);

  // Re-create gate when SDK or handle changes
  useEffect(() => {
    if (!sdk) {
      gateRef.current = null;
      return;
    }

    const gate = new EntitlementGate(sdk, {
      handle,
      context,
      autoGate,
      gatePlacementRequest,
    });

    gateRef.current = gate;

    const unsub = gate.onChange(() => {
      forceUpdate((v) => v + 1);
    });

    return () => {
      unsub();
      gateRef.current = null;
    };
  // Deps intentionally limited — featureKey identity triggers refetch -- handle identity is the key dependency
  }, [sdk, handle]);

  const recheck = useCallback(async () => {
    await gateRef.current?.check();
  }, []);

  useEffect(() => {
    if (autoCheck && isReady && gateRef.current) {
      void gateRef.current.check();
    }
  }, [autoCheck, isReady]);

  const state = gateRef.current?.state;
  return {
    isLoading: state?.isLoading ?? false,
    error: state?.error ?? null,
    result: state?.result ?? null,
    allowed: state?.allowed ?? false,
    limited: state?.limited ?? false,
    denied: state?.denied ?? false,
    gatedPlacement: state?.gatedPlacement ?? null,
    recheck,
  };
}
