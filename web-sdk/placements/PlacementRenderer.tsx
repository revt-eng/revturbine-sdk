import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PlacementOutput } from '../customer-side';
import type {
  PlacementSlotProps,
  PersonalizationContext,
  PlacementUiPath,
} from './types';
import {
  PlacementTypeRegistry,
  getDefaultRegistry,
  resolveContent,
  parseUiPath,
  parsePromotion,
} from './registry';
import {
  CtaResolverRegistry,
  getDefaultCtaResolverRegistry,
  dispatchCtaClick,
} from './cta-resolvers';

export interface PlacementRendererProps {
  /** The placement output from the decision engine. */
  placement: PlacementOutput;
  /** Personalization context for token resolution. */
  personalization?: PersonalizationContext;
  /** Custom registry; defaults to the global singleton. */
  registry?: PlacementTypeRegistry;
  /**
   * Custom CTA resolver registry; defaults to the global singleton. When a
   * resolver is registered for the activated CTA's action type, it is invoked
   * instead of `onCtaClick` / `onSecondaryCtaClick`.
   */
  ctaResolvers?: CtaResolverRegistry;
  /**
   * Callback when user clicks the primary CTA. Receives the parsed ui_path.
   * Acts as the fallback for action types with no registered resolver.
   */
  onCtaClick?: (uiPath: PlacementUiPath) => void;
  /**
   * Callback when user clicks a secondary CTA. Receives the parsed ui_path.
   * Acts as the fallback for action types with no registered resolver.
   */
  onSecondaryCtaClick?: (uiPath: PlacementUiPath) => void;
  /** Callback when user dismisses the placement. */
  onDismiss?: (outputId: string) => void;
  /** Callback fired once when the placement is first rendered visible. */
  onImpression?: (outputId: string) => void;
  /** Whether the placement is visible. Default true. */
  visible?: boolean;
  /** Custom CSS class name. */
  className?: string;
  /** Custom inline styles. */
  style?: React.CSSProperties;
  /** Fallback to render if no matching slot type is found. */
  fallback?: React.ReactNode;
}

/**
 * Resolves a placement output to the appropriate registered slot type
 * and renders it with resolved content.
 *
 * This is the primary component customers use to render placements.
 * It handles:
 * - Slot type resolution from the registry
 * - Personalization token expansion
 * - UI path and promotion parsing
 * - CTA and dismiss callback wiring
 */
export function PlacementRenderer({
  placement,
  personalization = {},
  registry,
  ctaResolvers,
  onCtaClick,
  onSecondaryCtaClick,
  onDismiss,
  onImpression,
  visible = true,
  className,
  style,
  fallback = null,
}: PlacementRendererProps) {
  const effectiveRegistry = registry ?? getDefaultRegistry();
  const effectiveCtaResolvers = ctaResolvers ?? getDefaultCtaResolverRegistry();
  const impressionFiredRef = useRef(false);

  const slotType = useMemo(
    () => effectiveRegistry.resolve(placement),
    [effectiveRegistry, placement],
  );

  const content = useMemo(
    () => resolveContent(placement.content, personalization),
    [placement.content, personalization],
  );

  const uiPath = useMemo(
    () => parseUiPath(placement.cta_path ?? placement.ui_path ?? {}),
    [placement.cta_path, placement.ui_path],
  );

  const promotion = useMemo(
    () => parsePromotion(placement.promotion),
    [placement.promotion],
  );

  const handleCtaClick = useCallback(() => {
    dispatchCtaClick(uiPath, { placement, kind: 'primary' }, effectiveCtaResolvers, onCtaClick);
  }, [uiPath, placement, effectiveCtaResolvers, onCtaClick]);

  const handleSecondaryCtaClick = useCallback(() => {
    dispatchCtaClick(uiPath, { placement, kind: 'secondary' }, effectiveCtaResolvers, onSecondaryCtaClick);
  }, [uiPath, placement, effectiveCtaResolvers, onSecondaryCtaClick]);

  const handleDismiss = useCallback(() => {
    onDismiss?.(placement.output_id);
  }, [onDismiss, placement.output_id]);

  // Fire impression event once when the placement is first rendered visible
  useEffect(() => {
    if (visible && slotType && !impressionFiredRef.current) {
      impressionFiredRef.current = true;
      onImpression?.(placement.output_id);
    }
  }, [visible, slotType, onImpression, placement.output_id]);

  if (!slotType) {
    return <>{fallback}</>;
  }

  const Component = slotType.component;
  const defaultContent = (slotType.defaultProps as PlacementSlotProps | undefined)?.content;
  const mergedContent = defaultContent ? { ...defaultContent, ...content } : content;

  const props: PlacementSlotProps = {
    placement,
    content: mergedContent,
    uiPath,
    promotion,
    onCtaClick: handleCtaClick,
    onSecondaryCtaClick: handleSecondaryCtaClick,
    onDismiss: handleDismiss,
    visible,
    className,
    style,
  };

  return <Component {...props} />;
}

PlacementRenderer.displayName = 'PlacementRenderer';
