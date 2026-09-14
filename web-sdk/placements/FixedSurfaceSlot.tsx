'use client';

import React, { useMemo } from 'react';
import type { PersonalizationContext, PlacementUiPath } from './types';
import type { PlacementTypeRegistry } from './registry';
import type {
  RevTurbineContextMode,
  RevTurbinePlacementDecisionOverrides,
  RevTurbineSurfaceSlotConfig,
} from '../customer-side';
import { useSurfaceSlot } from './useSurfaceSlot';
import { FIXED_SURFACE_TEMPLATE_IDS } from './surface-slot-constants';

export { FIXED_SURFACE_TEMPLATE_IDS };

export type FixedSurfaceSlotProps = {
  /** Required unique identifier for this render slot. */
  id: string;
  /** Optional human-readable slot label used for analytics/debugging. */
  name?: string;
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
  ttlMs?: number;
  personalization?: PersonalizationContext;
  registry?: PlacementTypeRegistry;
  onCtaClick?: (uiPath: PlacementUiPath) => void;
  /**
   * Called after the user dismisses the placement (plan 233 TASK-9).
   *
   * `MessageSurfaceSlot` advertised this prop but never fired it — the handler
   * was built and then discarded. It is wired for both slots now.
   */
  onDismissed?: () => void;
  className?: string;
  style?: React.CSSProperties;
  /**
   * Content to display when **no placement matches**.
   *
   * NOT shown after the user dismisses. Rendering the fallback on dismissal
   * puts something back in the space the user just closed — the escalated
   * integration called it a ghost popup and needed a MutationObserver to
   * suppress it (plan 233 TASK-9).
   */
  fallback?: React.ReactNode;
};

/**
 * Fixed surface slot — always renders an embedded placement.
 *
 * Use for inline placements that should always be present on the page:
 * upgrade banners, quota meters, promo cards, embedded CTAs, etc.
 *
 * The slot loads automatically on mount. If no placement matches,
 * `fallback` is rendered so the page never has an empty gap.
 *
 * @example
 * ```tsx
 * <FixedSurfaceSlot
 *   id="sidebar-upgrade-card"
 *   personalization={{ plan_name: 'Free' }}
 *   fallback={<DefaultUpgradeCard />}
 * />
 * ```
 */
export function FixedSurfaceSlot({
  id,
  name,
  surfaceTemplateIds = FIXED_SURFACE_TEMPLATE_IDS as string[],
  metadata,
  fallback = null,
  ...options
}: FixedSurfaceSlotProps) {
  const surfaceSlot = useMemo<RevTurbineSurfaceSlotConfig>(
    () => ({
      id,
      name: name || id,
      surfaceTemplateIds,
      metadata: {
        ...metadata,
        surface_slot_category: 'fixed',
      },
    }),
    [id, name, surfaceTemplateIds, metadata],
  );

  const { element, visible, hiddenReason } = useSurfaceSlot({
    ...options,
    autoLoad: true,
    surfaceSlot,
  });

  if (visible && element) return <>{element}</>;

  // A dismissal and a no-match are the same `visible: false` with opposite
  // intent: one means "the user closed this", the other "there was nothing to
  // show". Only the second wants the fallback.
  if (hiddenReason === 'dismissed') return null;

  return <>{fallback}</>;
}

FixedSurfaceSlot.displayName = 'FixedSurfaceSlot';
