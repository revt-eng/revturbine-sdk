import React, { useCallback, useMemo } from 'react';
import type {
  RevTurbineContextMode,
  RevTurbinePlacementDecisionOverrides,
  RevTurbineSurfaceSlotConfig,
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
  /** Callback when CTA is clicked. Receives the parsed ui_path. */
  onCtaClick?: (uiPath: PlacementUiPath) => void;
  /** Custom CSS class for the rendered placement. */
  className?: string;
  /** Custom inline styles for the rendered placement. */
  style?: React.CSSProperties;
};

export type UseSurfaceSlotResult = UsePlacementResult & {
  /** Pre-built React element that renders the placement using the correct slot type. */
  element: React.ReactNode;
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
    onCtaClick,
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

  const handleDismiss = useCallback(
    () => {
      void result.dismiss();
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
        onCtaClick={handleCtaClick}
        onDismiss={handleDismiss}
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
    handleCtaClick,
    handleDismiss,
    className,
    inlineStyle,
  ]);

  return {
    ...result,
    element,
  };
}
