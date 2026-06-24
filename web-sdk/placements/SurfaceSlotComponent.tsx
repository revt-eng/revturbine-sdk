import React, { useMemo } from 'react';
import type {
  RevTurbineContextMode,
  RevTurbinePlacementDecisionOverrides,
  RevTurbineSurfaceSlotConfig,
} from '../customer-side';
import { useSurfaceSlot } from './useSurfaceSlot';
import type { PersonalizationContext, PlacementUiPath } from './types';
import type { PlacementTypeRegistry } from './registry';

/**
 * Surface slot category that controls rendering behavior:
 *
 * - `fixed`     — Embedded in a page; always rendered inline when the user
 *                 qualifies (e.g. a banner, an inline card, a quota meter).
 * - `gated`     — Appears on button clicks or when a feature is attempted
 *                 (e.g. a modal gate, a feature-lock prompt).
 * - `triggered` — Server-driven; rules are evaluated, user qualifies for a
 *                 segment, and a surface template is rendered as a toast,
 *                 modal, tooltip, etc.
 */
export type SurfaceSlotCategory = 'fixed' | 'gated' | 'triggered';

export type SurfaceSlotComponentProps = {
  /** Required unique identifier for this render slot. */
  id: string;
  /** Optional human-readable slot label used for analytics/debugging. */
  name?: string;
  /**
   * Surface slot category.
   *
   * - `fixed`     — Embedded in a page (always rendered inline).
   * - `gated`     — Appears on feature gate interaction.
   * - `triggered` — Server-evaluated, rendered as toast/modal/etc.
   */
  category?: SurfaceSlotCategory;
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
  className?: string;
  style?: React.CSSProperties;
  fallback?: React.ReactNode;
};

/**
 * Universal surface slot component. Fetches a placement decision and
 * automatically renders it using the correct registered slot type.
 *
 * Combines `usePlacement` (decision fetching + interaction tracking) with
 * `PlacementRenderer` (slot type resolution + rendering).
 *
 * @example
 * ```tsx
 * <SurfaceSlotComponent
 *   id="dashboard-promo"
 *   category="fixed"
 *   personalization={{ user_name: 'Jane', plan_name: 'Free' }}
 *   onCtaClick={(uiPath) => handleCTA(uiPath)}
 *   fallback={<UpgradeButton />}
 * />
 * ```
 */
export function SurfaceSlotComponent({
  id,
  name,
  category,
  surfaceTemplateIds,
  metadata,
  fallback = null,
  ...options
}: SurfaceSlotComponentProps) {
  const surfaceSlot = useMemo<RevTurbineSurfaceSlotConfig>(
    () => ({
      id,
      name: name || id,
      surfaceTemplateIds,
      metadata: {
        ...metadata,
        ...(category ? { surface_slot_category: category } : undefined),
      },
    }),
    [id, name, category, surfaceTemplateIds, metadata],
  );

  const { element, visible, isLoading } = useSurfaceSlot({
    ...options,
    autoLoad: true,
    surfaceSlot,
  });

  if (isLoading) return null;
  if (!visible || !element) return <>{fallback}</>;
  return <>{element}</>;
}

SurfaceSlotComponent.displayName = 'SurfaceSlotComponent';
