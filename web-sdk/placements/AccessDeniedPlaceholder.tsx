'use client';

import React from 'react';
import type { CSSProperties } from 'react';
import { useRevTurbineTheme } from '../theme/ThemeContext';

export type AccessDeniedPlaceholderProps = {
  /** Entitlement the user lacks, surfaced as a data attribute for apps and tests. */
  entitlementHandle?: string;
  /** Headline. Defaults to "You don't have access to this feature". */
  title?: string;
  /** Supporting line. Defaults to a plan-upgrade hint. */
  description?: string;
  style?: CSSProperties;
};

/**
 * Default denied state for an {@link AccessGateSurfaceSlot} (D-59,
 * 2026-10-06): rendered when access is denied and no Access Gate placement
 * is authored for the slot's entitlement, so a blocked user always sees that
 * the feature is unavailable — never another entitlement's gate, never a
 * blank. An app-supplied `deniedFallback` replaces it.
 *
 * @public
 */
export function AccessDeniedPlaceholder({
  entitlementHandle,
  title = "You don't have access to this feature",
  description = 'Upgrade your plan to unlock it.',
  style,
}: AccessDeniedPlaceholderProps) {
  const { colors, typography } = useRevTurbineTheme();
  return (
    <div
      role="status"
      data-rt-access-denied=""
      data-rt-entitlement={entitlementHandle}
      style={{
        boxSizing: 'border-box',
        padding: '12px 16px',
        border: `1px solid ${colors.surfaceBorder}`,
        borderRadius: 8,
        background: colors.surface,
        color: colors.text,
        fontFamily: typography.fontFamily,
        ...style,
      }}
    >
      <div style={{ fontWeight: 600, color: colors.text }}>{title}</div>
      {description ? (
        <div style={{ marginTop: 4, fontSize: '0.875em', color: colors.textSecondary }}>{description}</div>
      ) : null}
    </div>
  );
}

AccessDeniedPlaceholder.displayName = 'AccessDeniedPlaceholder';
