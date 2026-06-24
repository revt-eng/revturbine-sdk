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
}: UsePlacementOptions): UsePlacementResult {
  const { sdk, isReady } = useRevTurbine();
  const [, forceUpdate] = useState(0);
  const controllerRef = useRef<PlacementController | null>(null);

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
  };
}
