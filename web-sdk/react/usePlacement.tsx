import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type RevTurbinePlacementConfig,
  type RevTurbineSurfaceSlotConfig,
  type RevTurbinePlacementContent,
  type RevTurbinePlacementDecision,
  type RevTurbinePlacementDecisionOverrides,
  type RevTurbineContextMode,
} from '../customer-side';
import { PlacementController } from '../controllers';
import type { PlacementExposureMode } from '../controllers';
import { exposureManager, type ExposureBasis } from '../telemetry';
import { useRevTurbine } from './useRevTurbine';

/**
 * Options for the {@link usePlacement} hook.
 */
export type UsePlacementOptions = {
  /** Placement configuration (name, scope key, metadata). */
  placement?: RevTurbinePlacementConfig;
  /** Canonical surface slot configuration (preferred over `placement`). */
  surfaceSlot?: RevTurbineSurfaceSlotConfig;
  /** Target user ID. Falls back to the SDK's current user context. */
  userId?: string;
  /** Context resolution mode. Default `'auto'`. */
  contextMode?: RevTurbineContextMode;
  /** Override segment, plan, or usage for testing. */
  overrides?: RevTurbinePlacementDecisionOverrides;
  /** Custom traits to include in the decision request. */
  traits?: Record<string, string | number | boolean>;
  /** Decision cache TTL in milliseconds. */
  ttlMs?: number;
  /** Automatically load a decision on mount. Default `true`. */
  autoLoad?: boolean;
  /**
   * Whether a visible decision auto-tracks a resolution-time impression. Default
   * `true`. Set `false` to suppress it — e.g. when you attach {@link
   * UsePlacementResult.exposureRef} and want the impression to fire on viewport
   * exposure instead (plan 144 TASK-9 / REQ-15). Read at mount.
   */
  autoTrackImpression?: boolean;
  /**
   * When the presentation-writing `impression` fires (plan 144 TASK-11 / REQ-17).
   * `legacy_resolution` (default) fires at resolution as today; `render` at
   * render; `viewport` on viewport exposure (falling back to resolution when
   * `IntersectionObserver` is unavailable). Only `viewport` moves the dashboard
   * denominator — attach {@link UsePlacementResult.exposureRef} to the visual
   * root to use it. Read at mount.
   */
  placementExposure?: PlacementExposureMode;
};

/**
 * Result returned by the {@link usePlacement} hook.
 */
export type UsePlacementResult = {
  isLoading: boolean;
  error: string;
  placementId: string;
  visible: boolean;
  decision: RevTurbinePlacementDecision | null;
  content: RevTurbinePlacementContent['content'] | null;
  refresh: () => Promise<void>;
  dismiss: (cooldownMs?: number) => Promise<void>;
  snooze: (seconds?: number) => Promise<void>;
  remindMeLater: (seconds?: number) => Promise<void>;
  ctaClick: (ctaTarget?: string) => Promise<void>;
  ctaComplete: (ctaTarget?: string) => Promise<void>;
  /**
   * Ref callback to attach to the placement's true visual root (plan 144
   * TASK-9). RevTurbine observes when that element enters the viewport for
   * viewport-qualified exposure; when `IntersectionObserver` is unavailable it
   * falls back to render (`exposure_basis: 'render_fallback'`, AC-10). Attaching
   * it is optional and never adds a wrapper element (REQ-18/REQ-19).
   */
  exposureRef: (element: Element | null) => void;
  /**
   * How the placement's visual root was exposed, or `null` before it enters the
   * viewport (plan 144 TASK-9). `'render_fallback'` when `IntersectionObserver`
   * is unavailable (AC-10). Only meaningful once {@link
   * UsePlacementResult.exposureRef} is attached.
   */
  exposureBasis: ExposureBasis | null;
};

/**
 * React hook for loading a placement decision and managing interactions.
 *
 * Handles registration, decision fetching, impression tracking,
 * and exposes interaction methods (dismiss, remind me later, CTA click/complete).
 *
 * @example
 * ```tsx
 * const { visible, content, ctaClick, dismiss } = usePlacement({
 *   placement: { name: 'pricing_banner' },
 *   userId: 'user_123',
 * });
 *
 * if (!visible) return null;
 * return (
 *   <div>
 *     <h2>{content?.header}</h2>
 *     <button onClick={() => ctaClick()}>{content?.cta_label}</button>
 *   </div>
 * );
 * ```
 */
export function usePlacement({
  placement,
  surfaceSlot,
  userId,
  contextMode = 'auto',
  overrides,
  traits,
  ttlMs,
  autoLoad = true,
  autoTrackImpression,
  placementExposure,
}: UsePlacementOptions): UsePlacementResult {
  const { sdk, isReady } = useRevTurbine();
  const [, forceUpdate] = useState(0);
  const controllerRef = useRef<PlacementController | null>(null);
  const exposureCleanupRef = useRef<(() => void) | null>(null);

  const resolvedUserId = userId || (sdk ? sdk.getUserContext().user_id : '');
  const placementKey = useMemo(
    () => JSON.stringify({ placement: placement ?? null, surfaceSlot: surfaceSlot ?? null }),
    [placement, surfaceSlot],
  );

  // Re-create controller when SDK or placement config changes
  useEffect(() => {
    if (!sdk) {
      controllerRef.current = null;
      return;
    }

    const ctrl = new PlacementController(sdk, {
      placement: placement ?? undefined,
      surfaceSlot: surfaceSlot ?? undefined,
      userId: resolvedUserId || undefined,
      contextMode,
      overrides,
      traits,
      ttlMs,
      autoTrackImpression,
      placementExposure,
    });

    controllerRef.current = ctrl;
    forceUpdate((v) => v + 1);

    const unsub = ctrl.onChange(() => {
      forceUpdate((v) => v + 1);
    });

    return () => {
      unsub();
      controllerRef.current = null;
    };
  // Deps intentionally limited — surfaceKey identity triggers refetch -- keyed on serialized placementKey for referential stability
  }, [sdk, placementKey]);

  // Update controller user/options when they change (without recreating)
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl || !sdk) return;
    // Options that can change between loads are passed fresh to load()
    // through the controller's options, but PlacementController reads them
    // from the constructor. For simplicity, if key options change we reset.
  }, [resolvedUserId, contextMode, overrides, traits, ttlMs, sdk]);

  const loadDecision = useCallback(async () => {
    const ctrl = controllerRef.current;
    if (!ctrl || !isReady || !resolvedUserId) return;
    await ctrl.load();
  }, [isReady, resolvedUserId]);

  useEffect(() => {
    if (!autoLoad) return;
    void loadDecision();
  }, [autoLoad, loadDecision]);

  // Ref callback for the placement's true visual root. Observe when it enters
  // the viewport and hand the exposure basis to the controller (plan 144
  // TASK-9). Stable identity (refs + module singleton), so it never re-attaches.
  const exposureRef = useCallback((element: Element | null) => {
    exposureCleanupRef.current?.();
    exposureCleanupRef.current = null;
    if (!element) return;
    // The root rendered → `placement_rendered` (and, in `render` mode, the
    // impression). Then observe for viewport exposure → `placement_exposed`
    // (and, in `viewport` mode, the impression).
    controllerRef.current?.markRendered();
    exposureCleanupRef.current = exposureManager.observe(element, {}, (basis) => {
      controllerRef.current?.markVisible(basis);
    });
  }, []);

  // Stop observing when the hook unmounts.
  useEffect(() => {
    return () => {
      exposureCleanupRef.current?.();
      exposureCleanupRef.current = null;
    };
  }, []);

  const ctrl = controllerRef.current;
  const state = ctrl?.state;

  return {
    isLoading: state?.isLoading ?? false,
    error: state?.error ?? '',
    placementId: state?.placementId ?? '',
    visible: state?.visible ?? false,
    decision: state?.decision ?? null,
    content: state?.content ?? null,
    refresh: async () => { await ctrl?.refresh(); },
    dismiss: async (cooldownMs = 24 * 60 * 60 * 1000) => { await ctrl?.dismiss(cooldownMs); },
    snooze: async (seconds = 3600) => { await ctrl?.snooze(seconds); },
    remindMeLater: async (seconds = 3600) => { await ctrl?.remindMeLater(seconds); },
    ctaClick: async (ctaTarget) => { await ctrl?.ctaClick(ctaTarget); },
    ctaComplete: async (ctaTarget) => { await ctrl?.ctaComplete(ctaTarget); },
    exposureRef,
    exposureBasis: state?.exposureBasis ?? null,
  };
}
