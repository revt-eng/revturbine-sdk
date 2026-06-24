import React from 'react';
import { type RevTurbinePlacementDecisionOverrides, type RevTurbineContextMode, type RevTurbinePlacementConfig } from '../customer-side';
import { usePlacement } from './usePlacement';

type PlacementRenderArgs = ReturnType<typeof usePlacement>;

/**
 * Props for the {@link Placement} render-prop component.
 */
export type PlacementProps = {
  /** Placement configuration. */
  placement: RevTurbinePlacementConfig;
  /** Target user ID. */
  userId?: string;
  /** Context resolution mode. */
  contextMode?: RevTurbineContextMode;
  /** Decision overrides for testing. */
  overrides?: RevTurbinePlacementDecisionOverrides;
  /** Custom traits. */
  traits?: Record<string, string | number | boolean>;
  /** Cache TTL in milliseconds. */
  ttlMs?: number;
  /** Auto-load on mount. */
  autoLoad?: boolean;
  /** Fallback UI when the placement is not visible. */
  fallback?: React.ReactNode;
  /** Render function receiving the placement state. */
  children: (args: PlacementRenderArgs) => React.ReactNode;
};

/**
 * Render-prop component for placement integration.
 *
 * An alternative to {@link usePlacement} for class components or when
 * render-prop composition is preferred.
 *
 * @example
 * ```tsx
 * <Placement placement={{ name: 'upgrade_modal' }} userId="user_123">
 *   {({ visible, content, ctaClick }) =>
 *     visible ? (
 *       <div>
 *         <h2>{content?.header}</h2>
 *         <button onClick={() => ctaClick()}>{content?.cta_label}</button>
 *       </div>
 *     ) : null
 *   }
 * </Placement>
 * ```
 */
export function Placement({
  placement,
  userId,
  contextMode,
  overrides,
  traits,
  ttlMs,
  autoLoad,
  fallback = null,
  children,
}: PlacementProps) {
  const state = usePlacement({
    placement,
    userId,
    contextMode,
    overrides,
    traits,
    ttlMs,
    autoLoad,
  });

  if (!state.visible) return <>{fallback}</>;
  return <>{children(state)}</>;
}
