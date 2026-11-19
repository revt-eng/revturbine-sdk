'use client';

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { isDevelopmentBuild } from '../build-mode';
import type { PlacementOutput, RevTurbineComponentType, SdkMetadata } from '../customer-side';
import type {
  PlacementSlotProps,
  PersonalizationContext,
  PlacementUiPath,
  CtaResolverContext,
} from './types';
import {
  PlacementTypeRegistry,
  getDefaultRegistry,
  resolveContent,
  parseUiPath,
  parsePromotion,
} from './registry';
// Guarantees the default registry is seeded with builtins even when this
// module is loaded without the package barrel (direct module imports, tests).
import './install-builtins';
import {
  CtaResolverRegistry,
  getDefaultCtaResolverRegistry,
  dispatchCtaClick,
  isServerActionResolver,
  isBuiltinSnoozeResolver,
} from './cta-resolvers';

export interface PlacementRendererProps {
  /** The placement output from the decision engine. */
  placement: PlacementOutput;
  /** Personalization context for token resolution. */
  personalization?: PersonalizationContext;
  /** Custom registry; defaults to the global singleton. */
  registry?: PlacementTypeRegistry;
  /** Component types this render location accepts. Matching is exact. */
  acceptedComponentTypes?: readonly RevTurbineComponentType[];
  /**
   * Custom CTA resolver registry; defaults to the global singleton. When a
   * resolver is registered for the activated CTA's action type, it is invoked
   * instead of `onCtaClick` / `onSecondaryCtaClick`.
   */
  ctaResolvers?: CtaResolverRegistry;
  /** Record each CTA interaction; server actions supply result metadata after resolving. */
  onCtaActivate?: (index: number, metadata?: SdkMetadata) => void;
  /** Gate render locations exclude dismiss-role CTAs. */
  excludeDismissCtas?: boolean;
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
  /**
   * Callback when the user chooses "Remind me later" (defer). When provided,
   * dismissible slots render a defer control; omit it and no defer control
   * appears (plan 167 REQ-7). Additive/opt-in.
   */
  onRemindLater?: (outputId: string, seconds?: number) => void;
  /** Handle an authored snooze CTA without an extra defer control; indexed actions include their authored index. */
  onSnooze?: (outputId: string, seconds?: number, ctaIndex?: number) => void;
  /** Callback fired once when the placement is first rendered visible. */
  onImpression?: (outputId: string) => void;
  /**
   * Optional viewport-exposure ref, threaded through to the slot component's
   * {@link PlacementSlotProps.exposureRef} (plan 174 TASK-15, completing plan
   * 144 REQ-18's slot half). Supply the callback built by `usePlacement` (or
   * an equivalent from the exposure substrate); the slot attaches it to its
   * true visual root so `placement_exposed` can be viewport-qualified.
   * Additive and optional — omitted, slots render exactly as before.
   */
  exposureRef?: (element: Element | null) => void;
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
  acceptedComponentTypes,
  ctaResolvers,
  onCtaClick,
  onCtaActivate,
  excludeDismissCtas = false,
  onSecondaryCtaClick,
  onDismiss,
  onRemindLater,
  onSnooze,
  onImpression,
  exposureRef,
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

  const handleRemindLater = useCallback((seconds?: number) => {
    onRemindLater?.(placement.output_id, seconds);
  }, [onRemindLater, placement.output_id]);
  const handleSnooze = useCallback((seconds?: number) => {
    (onSnooze ?? onRemindLater)?.(placement.output_id, seconds);
  }, [onSnooze, onRemindLater, placement.output_id]);

  const renderCtas = useMemo(() => excludeDismissCtas
    ? placement.ctas?.filter(cta => cta.role !== 'dismiss') : placement.ctas,
  [placement.ctas, excludeDismissCtas]);
  const gateFiltersCtas = excludeDismissCtas && renderCtas?.length !== placement.ctas?.length;
  const gateFiltersAllCtas = gateFiltersCtas && renderCtas?.length === 0;
  const handleIndexedCtaClick = useCallback((renderIndex: number) => {
    const cta = renderCtas?.[renderIndex];
    const index = cta ? placement.ctas?.indexOf(cta) ?? -1 : -1;
    if (!cta || (excludeDismissCtas && cta.role === 'dismiss')) return;
    const path = parseUiPath(cta.path);
    const mountedSnooze = isBuiltinSnoozeResolver(effectiveCtaResolvers.get(path.type)) && Boolean(onSnooze || onRemindLater);
    const ownsResult = path.type !== 'dismiss' && isServerActionResolver(effectiveCtaResolvers.get(path.type));
    const context: CtaResolverContext = {
      placement, kind: cta.emphasis === 'primary' ? 'primary' : 'secondary',
      ...(ownsResult && onCtaActivate ? { recordInteraction: (metadata: SdkMetadata) => onCtaActivate(index, metadata) } : {}),
      index, label: cta.label, path: cta.path, role: cta.role, role_overridden: cta.role_overridden,
      ...(onSnooze || onRemindLater ? { remindLater: mountedSnooze ? (seconds?: number) => {
        if (onSnooze) onSnooze(placement.output_id, seconds, index);
        else onRemindLater?.(placement.output_id, seconds);
      } : handleSnooze } : {}),
    };
    if (!ownsResult && !mountedSnooze) onCtaActivate?.(index);
    if (!onCtaActivate && cta.role === 'dismiss' && path.type !== 'dismiss') onDismiss?.(placement.output_id);
    // Dismissal belongs to the mounted controller; navigation still uses path.type.
    if (path.type === 'dismiss') {
      if (!onCtaActivate || ownsResult) onDismiss?.(placement.output_id);
      return;
    }
    dispatchCtaClick(path, context, effectiveCtaResolvers,
      cta.emphasis === 'primary' ? onCtaClick : (onSecondaryCtaClick ?? onCtaClick));
  }, [placement, renderCtas, excludeDismissCtas, onSnooze, onRemindLater, handleSnooze,
    onCtaActivate, onDismiss, effectiveCtaResolvers, onCtaClick, onSecondaryCtaClick]);

  useEffect(() => {
    if (excludeDismissCtas && placement.ctas?.some(cta => cta.role === 'dismiss') &&
        isDevelopmentBuild()) {
      console.warn('[RevTurbine] Gate surfaces cannot render dismiss-role CTAs.');
    }
  }, [excludeDismissCtas, placement.ctas]);

  const handleCtaClick = useCallback(() => {
    if (renderCtas) {
      const primary = renderCtas.findIndex(cta => cta.emphasis === 'primary');
      handleIndexedCtaClick(primary < 0 ? 0 : primary);
      return;
    }
    dispatchCtaClick(uiPath, { placement, kind: 'primary',
      ...(onSnooze || onRemindLater ? { remindLater: handleSnooze } : {}),
    }, effectiveCtaResolvers, onCtaClick);
  }, [renderCtas, handleIndexedCtaClick, uiPath, placement, effectiveCtaResolvers, onCtaClick, onSnooze, onRemindLater, handleSnooze]);

  const handleSecondaryCtaClick = useCallback(() => {
    if (renderCtas) {
      const secondary = placement.ctas?.[1];
      if (secondary) handleIndexedCtaClick(renderCtas.indexOf(secondary));
      return;
    }
    dispatchCtaClick(uiPath, { placement, kind: 'secondary',
      ...(onSnooze || onRemindLater ? { remindLater: handleSnooze } : {}),
    }, effectiveCtaResolvers, onSecondaryCtaClick);
  }, [renderCtas, handleIndexedCtaClick, uiPath, placement, effectiveCtaResolvers, onSecondaryCtaClick, onSnooze, onRemindLater, handleSnooze]);

  const handleDismiss = useCallback(() => {
    onDismiss?.(placement.output_id);
  }, [onDismiss, placement.output_id]);

  // Fire impression event once when the placement is first rendered visible
  useEffect(() => {
    if (visible && slotType && !gateFiltersAllCtas && !impressionFiredRef.current) {
      impressionFiredRef.current = true;
      onImpression?.(placement.output_id);
    }
  }, [visible, slotType, gateFiltersAllCtas, onImpression, placement.output_id]);

  if (!slotType || gateFiltersAllCtas || (acceptedComponentTypes && !acceptedComponentTypes.includes(slotType.componentType))) {
    return <>{fallback}</>;
  }

  const Component = slotType.component;
  const defaultContent = (slotType.defaultProps as PlacementSlotProps | undefined)?.content;
  let mergedContent = defaultContent ? { ...defaultContent, ...content } : content;
  let slotUiPath = uiPath;
  if (gateFiltersCtas) {
    const primary = renderCtas?.find(cta => cta.emphasis === 'primary') ?? renderCtas?.[0];
    const secondary = placement.ctas?.[1];
    // Legacy slots read the projected labels/path, not the filtered CTA array.
    // Clear defaults too, so excluded actions cannot reappear through them.
    mergedContent = { ...mergedContent };
    delete mergedContent.cta_label;
    delete mergedContent.secondary_cta_label;
    if (primary) {
      mergedContent.cta_label = primary.label;
      slotUiPath = parseUiPath(primary.path);
    }
    if (secondary && secondary !== primary && renderCtas?.includes(secondary)) {
      mergedContent.secondary_cta_label = secondary.label;
    }
  }

  const props: PlacementSlotProps = {
    placement,
    content: mergedContent,
    uiPath: slotUiPath,
    promotion,
    onCtaClick: handleCtaClick,
    ...(placement.ctas ? {
      ctas: renderCtas,
      onCtaClickIndex: handleIndexedCtaClick,
    } : {}),
    onSecondaryCtaClick: handleSecondaryCtaClick,
    onDismiss: handleDismiss,
    // Opt-in: only wire the defer control when the caller supplied a handler.
    ...(onRemindLater ? { onRemindLater: handleRemindLater } : {}),
    // Plan 174 TASK-15: thread the exposure substrate through to the slot.
    ...(exposureRef ? { exposureRef } : {}),
    visible,
    className,
    style,
  };

  return <Component {...props} />;
}

PlacementRenderer.displayName = 'PlacementRenderer';
