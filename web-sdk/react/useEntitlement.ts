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
 * Until the first check resolves, `allowed` and `denied` are both `false` and
 * `result` is `null` — the three-state model. Consumers decide from the triple
 * (`isLoading` / `allowed` / `denied`), never from `denied` alone; the SDK is
 * fail-closed, so "not yet allowed" is the default. Evaluation is local to the
 * loaded Playbook — there is no per-check network call.
 *
 * @example
 * ```tsx
 * function BrandKitSection() {
 *   const { allowed, denied, result } = useEntitlement({ handle: 'brand_kit' });
 *   if (denied) return <UpgradePrompt reason={result?.reason} />;
 *   return <BrandKitEditor />;
 * }
 * ```
 *
 * @public
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

  // Plan 194 REQ-3: a changed `context` must re-evaluate. The gate captures
  // `context` at construction and the effect below keyed only on
  // `[sdk, handle]`, so `<Gate check={{ entitlement, context }}>` ignored a
  // changed context entirely. Keying on a serialized form rather than the
  // object keeps callers free to pass an inline literal — whose identity
  // changes every render, and would otherwise rebuild the gate forever.
  const contextKey = JSON.stringify(context ?? null);

  // Re-create gate when SDK, handle, or context changes
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
    // Plan 194 REQ-3. Without this the gate re-rendered only when it re-checked
    // itself, and nothing re-checked it after `update()` / `identify()` — so a
    // mounted gate kept rendering a decision made against the previous user
    // context. The deps below are `[sdk, handle]`, both unchanged by a context
    // change, so the effect that creates this gate never re-runs either.
    const unwatch = gate.watchUserContext();

    return () => {
      unsub();
      unwatch();
      // BL-0179 — release the Playbook-settled subscription the gate may hold
      // while waiting out a config race, or an unmounted gate keeps a listener
      // (and re-checks) alive on the SDK.
      gate.dispose();
      gateRef.current = null;
    };
  // `contextKey` (not `context`) so an inline literal does not rebuild the gate
  // on every render — see the note where it is computed.
  }, [sdk, handle, contextKey]);

  const recheck = useCallback(async () => {
    await gateRef.current?.check();
  }, []);

  useEffect(() => {
    if (autoCheck && isReady && gateRef.current) {
      void gateRef.current.check();
    }
  // These deps must be a SUPERSET of the gate-building effect's above, or a
  // gate can be rebuilt without ever being checked — and an unchecked gate has
  // `result === null` with `isLoading === false`, which `<Gate>` reads as
  // "unresolved" and renders as nothing, forever.
  //
  // `handle` and `contextKey` were here for that reason. `sdk` was not, and
  // that was BL-0251: a host whose provider options change identity once the
  // session settles (revturbine-web's dogfood provider memoizes them on the
  // Better Auth session) publishes a NEW sdk instance with `isReady` still
  // true. The gate above was rebuilt against it; this effect did not re-run,
  // so nothing ever checked it, and every page whose body sits inside a
  // `<Gate>` rendered blank until it was remounted by navigating away and
  // back. A hard refresh hit it every time, because that is exactly when the
  // session resolves after the gate has mounted.
  }, [autoCheck, isReady, handle, contextKey, sdk]);

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
