'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
import type {
  RevTurbineContextMode,
  RevTurbinePlacementDecisionOverrides,
  RevTurbineSurfaceSlotConfig,
  RevTurbineComponentType,
} from '../customer-side';
import { usePlacement, type UsePlacementResult } from '../react/usePlacement';
import { PlacementRenderer } from '../placements/PlacementRenderer';
import type { PersonalizationContext, PlacementUiPath } from '../placements/types';
import type { PlacementTypeRegistry } from '../placements/registry';
import { usePlacementPersonalization } from './usePlacementPersonalization';

export type UseSurfaceSlotOptions = {
  surfaceSlot: RevTurbineSurfaceSlotConfig;
  contextMode?: RevTurbineContextMode;
  overrides?: RevTurbinePlacementDecisionOverrides;
  traits?: Record<string, string | number | boolean>;
  ttlMs?: number;
  /**
   * Whether to load the placement decision automatically.
   * Managed internally by each surface slot component.
   * @internal
   */
  autoLoad?: boolean;
  /** Personalization context for token resolution in rendered content. */
  personalization?: PersonalizationContext;
  /** Custom registry for slot type resolution. */
  registry?: PlacementTypeRegistry;
  /** Component types this slot accepts. Matching is exact. */
  acceptedComponentTypes?: readonly RevTurbineComponentType[];
  /** Callback when CTA is clicked. Receives the parsed ui_path. */
  onCtaClick?: (uiPath: PlacementUiPath) => void;
  /**
   * Called after the user dismisses the placement (plan 233 TASK-9).
   *
   * Fires once per dismissal, after the interaction is recorded.
   */
  onDismissed?: () => void;
  /** Custom CSS class for the rendered placement. */
  className?: string;
  /** Custom inline styles for the rendered placement. */
  style?: React.CSSProperties;
};

/**
 * Why a slot is rendering nothing.
 *
 * `null` while visible. The distinction matters because a slot that always
 * renders `fallback` when `!visible` shows its fallback content the instant the
 * user dismisses — a "ghost" that reappears in place of the thing just closed.
 * The escalated integration needed three attempts and a MutationObserver to
 * work around it (plan 233 TASK-9).
 *
 * @public
 */
export type SurfaceSlotHiddenReason = 'dismissed' | 'no_match' | null;

export type UseSurfaceSlotResult = UsePlacementResult & {
  /** Pre-built React element that renders the placement using the correct slot type. */
  element: React.ReactNode;
  /**
   * Why nothing is rendering — `'dismissed'`, `'no_match'`, or `null` when
   * visible. Lets a slot distinguish "the user closed this" from "nothing
   * matched", which are the same `visible: false` but want opposite UI.
   */
  hiddenReason: SurfaceSlotHiddenReason;
};

/**
 * Hook that combines `usePlacement` decision loading with automatic
 * rendering via `PlacementRenderer`.
 *
 * Returns everything `usePlacement` returns, plus an `element` property
 * containing a pre-rendered React element. Drop `element` into your JSX
 * to render the placement without writing custom rendering logic.
 *
 * @example
 * ```tsx
 * function FeatureGate() {
 *   const { element, visible } = useSurfaceSlot({
 *     surfaceSlot: { id: 'ai-export-gate', name: 'AI Export Gate' },
 *     personalization: { user_name: 'Jane' },
 *     onCtaClick: (uiPath) => handleCTA(uiPath),
 *   });
 *
 *   return (
 *     <div>
 *       <h2>Export</h2>
 *       {element}
 *     </div>
 *   );
 * }
 * ```
 */
export function useSurfaceSlot(options: UseSurfaceSlotOptions): UseSurfaceSlotResult {
  const {
    surfaceSlot,
    personalization,
    registry,
    acceptedComponentTypes,
    onCtaClick,
    onDismissed,
    className,
    style: inlineStyle,
    ...placementOptions
  } = options;

  const result = usePlacement({
    ...placementOptions,
    surfaceSlot,
  });
  const resolvedPersonalization = usePlacementPersonalization({
    personalization,
    refreshKey: result.decision?.requestId,
  });

  const handleCtaClick = useCallback(
    (uiPath: PlacementUiPath) => {
      void result.ctaClick(uiPath.type);
      onCtaClick?.(uiPath);
    },
    [result.ctaClick, onCtaClick],
  );

  // Dismissal is a local fact the moment it happens — the next decision has not
  // been made yet, so the only other signal (the decision's suppressionReason)
  // arrives a beat later or after a reload. Track it here so the slot can react
  // immediately.
  const [dismissedHere, setDismissedHere] = useState(false);
  const onDismissedRef = useRef(onDismissed);
  onDismissedRef.current = onDismissed;

  const handleDismiss = useCallback(
    () => {
      setDismissedHere(true);
      void result.dismiss();
      // Previously built and then discarded with `void handleDismissWrap` in
      // MessageSurfaceSlot, so `onDismissed` was an advertised prop that never
      // fired. Wired here, once, for every slot that uses this hook.
      onDismissedRef.current?.();
    },
    [result.dismiss],
  );

  // Build a PlacementOutput from the decision for the renderer.
  // When the decision includes a full `output` (e.g. from local resolvers or
  // enriched server responses), use it directly. Otherwise fall back to a
  // minimal shape mapped from the simplified content.
  const placementOutput = useMemo(() => {
    if (!result.decision || !result.visible) return null;

    if (result.decision.output) {
      return result.decision.output;
    }

    return {
      output_id: result.placementId,
      category: 'dynamic',
      surface: {
        type: 'in_page' as const,
      },
      content: result.content
        ? {
            header: result.content.header,
            body: result.content.body,
            cta_label: result.content.cta_label,
          }
        : {},
      cta_path: {},
      ui_path: {},
      rule_id: '',
      decision_id: result.decision.requestId,
      config_version: '',
      present_upsell: false,
    };
  }, [result.decision, result.visible, result.placementId, result.content]);

  const element = useMemo(() => {
    if (!placementOutput || !result.visible) return null;

    return (
      <PlacementRenderer
        placement={placementOutput}
        personalization={resolvedPersonalization}
        registry={registry}
        acceptedComponentTypes={acceptedComponentTypes}
        onCtaClick={handleCtaClick}
        onDismiss={handleDismiss}
        exposureRef={result.exposureRef}
        visible={result.visible}
        className={className}
        style={inlineStyle}
      />
    );
  }, [
    placementOutput,
    result.visible,
    resolvedPersonalization,
    registry,
    acceptedComponentTypes,
    handleCtaClick,
    handleDismiss,
    result.exposureRef,
    className,
    inlineStyle,
  ]);

  // A suppression the runtime already knows about — a dismiss cooldown still in
  // force from a previous session — counts as dismissed too, so a reload does
  // not resurrect the fallback the user already closed past.
  const suppressedByInteraction =
    result.decision?.suppressionReason === 'suppressed_by_dismiss_cooldown'
    || result.decision?.suppressionReason === 'suppressed_until_remind_window';

  const hiddenReason: SurfaceSlotHiddenReason = result.visible
    ? null
    : (dismissedHere || suppressedByInteraction) ? 'dismissed' : 'no_match';

  return {
    ...result,
    element,
    hiddenReason,
  };
}
