import React, { useCallback, useMemo, useState } from 'react';
import type { PlacementSlotProps } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';

/**
 * Props for {@link BannerSlot}.
 * Extends {@link PlacementSlotProps} with banner-specific options.
 */
export type BannerSlotProps = PlacementSlotProps & {
  /** Banner position — sticks to the top or bottom of the viewport. */
  position?: 'top' | 'bottom';
};

const bannerLayoutStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 24px',
  lineHeight: '1.5',
  zIndex: 9990,
  width: '100%',
  boxSizing: 'border-box',
};

const bannerContentStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  flex: 1,
};

const bannerActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  marginLeft: '16px',
  flexShrink: 0,
};

/**
 * Full-width sticky banner placement.
 *
 * Renders at the top or bottom of the viewport with a header, body,
 * CTA button, and optional dismiss control.
 *
 * **Content fields used:** `header`, `body`, `message`, `cta_label`, `position`, `dismissible`
 *
 * @example
 * ```tsx
 * <BannerSlot
 *   placement={output}
 *   content={{ header: 'Upgrade to Pro', cta_label: 'Upgrade Now', position: 'top' }}
 *   uiPath={{ type: 'navigate_to_plans' }}
 *   onCtaClick={() => navigate('/plans')}
 *   onDismiss={() => {}}
 *   visible={true}
 * />
 * ```
 */
export function BannerSlot({
  content,
  onCtaClick,
  onDismiss,
  visible,
  className,
  style,
}: BannerSlotProps) {
  const theme = useRevTurbineTheme();
  const [dismissed, setDismissed] = useState(false);
  const [prevVisible, setPrevVisible] = useState(visible);

  // Reset dismissed state when visible transitions to true (derived state during render)
  if (visible && !prevVisible) {
    setDismissed(false);
  }
  if (visible !== prevVisible) {
    setPrevVisible(visible);
  }

  const position = (content.position as 'top' | 'bottom') || 'top';
  const dismissible = content.dismissible !== false;

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    onDismiss();
  }, [onDismiss]);

  const themedStyles = useMemo(() => {
    const { colors, typography, shape } = theme;
    return {
      banner: {
        ...bannerLayoutStyle,
        backgroundColor: colors.primary,
        color: colors.primaryText,
        fontFamily: typography.fontFamily,
        fontSize: typography.fontSize,
        position: 'sticky' as const,
        ...(position === 'bottom' ? { bottom: 0 } : { top: 0 }),
      },
      header: {
        fontWeight: 600,
        fontSize: '15px',
      } as React.CSSProperties,
      body: {
        opacity: 0.9,
      } as React.CSSProperties,
      cta: {
        padding: '6px 16px',
        backgroundColor: colors.primaryText,
        color: colors.primary,
        border: 'none',
        borderRadius: shape.borderRadiusSmall,
        fontWeight: 600,
        fontSize: typography.fontSizeSmall,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      } as React.CSSProperties,
      dismiss: {
        padding: '4px 8px',
        background: 'transparent',
        border: 'none',
        color: colors.primaryText,
        fontSize: '18px',
        cursor: 'pointer',
        opacity: 0.7,
        lineHeight: 1,
      } as React.CSSProperties,
    };
  }, [theme, position]);

  if (!visible || dismissed) return null;

  return (
    <div
      className={className}
      style={{ ...themedStyles.banner, ...style }}
      role="banner"
      data-rt-placement="banner"
    >
      <div style={bannerContentStyle}>
        {content.header && <div style={themedStyles.header}>{content.header}</div>}
        {(content.body || content.message) && (
          <div style={themedStyles.body}>{content.body || content.message}</div>
        )}
      </div>
      <div style={bannerActionsStyle}>
        {content.cta_label && (
          <button type="button" style={themedStyles.cta} onClick={onCtaClick}>
            {content.cta_label}
          </button>
        )}
        {dismissible && (
          <button
            type="button"
            style={themedStyles.dismiss}
            onClick={handleDismiss}
            aria-label="Dismiss"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

BannerSlot.displayName = 'BannerSlot';
