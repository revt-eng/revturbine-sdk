import React, { useCallback, useMemo, useState } from 'react';
import type { PlacementSlotProps, ResolvedContent } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface BannerFrameProps<C extends ResolvedContent = ResolvedContent>
  extends PlacementSlotProps<C> {
  /** Banner position — sticks to the top or bottom of the viewport. */
  position?: 'top' | 'bottom';
  /**
   * Visual variant that controls default colors.
   * - `default` — uses primary theme color (default)
   * - `info` — uses info/accent color with lighter background
   * - `upsell` — uses accent color (purple-tinted)
   * - `warning` — uses warning color
   */
  variant?: 'default' | 'info' | 'upsell' | 'warning';
  /** Accent color override (for background). */
  accentColor?: string;
  /** Accent text color override. */
  accentTextColor?: string;
  /** Override dismissibility (defaults to `content.dismissible !== false`). */
  dismissible?: boolean;
  /** Override the CTA label. */
  ctaLabel?: string;
  /** CTA visual style. `button` renders a contrasted pill; `link` renders a text link. */
  ctaVariant?: 'button' | 'link';
  /** Icon element rendered before the text. */
  icon?: React.ReactNode;
  /** Custom banner body (replaces default header + body text). */
  children?: React.ReactNode;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

/**
 * Sticky banner component that handles:
 * - Top/bottom position
 * - Dismiss state + callback
 * - Visibility reset when parent re-shows
 * - Theme-aware default styles
 *
 * Extend by wrapping and injecting `children` for custom body content.
 *
 * @example
 * ```tsx
 * function TrialBanner(props: PlacementSlotProps<TrialBannerContent>) {
 *   return (
 *     <BannerFrame {...props} position="top">
 *       <span>🔥 {props.content.days_remaining} days left in your trial</span>
 *     </BannerFrame>
 *   );
 * }
 * ```
 */
export function BannerFrame<C extends ResolvedContent = ResolvedContent>({
  content,
  onCtaClick,
  onDismiss,
  visible,
  className,
  style,
  position: positionProp,
  variant: variantProp,
  accentColor: accentColorProp,
  accentTextColor: accentTextColorProp,
  dismissible: dismissibleProp,
  ctaLabel,
  ctaVariant: ctaVariantProp,
  icon,
  children,
}: BannerFrameProps<C>) {
  const theme = useRevTurbineTheme();
  const [dismissed, setDismissed] = useState(false);
  const [prevVisible, setPrevVisible] = useState(visible);

  // Reset dismissed state when visible transitions to true
  if (visible && !prevVisible) {
    setDismissed(false);
  }
  if (visible !== prevVisible) {
    setPrevVisible(visible);
  }

  const position = positionProp ?? (content.position as 'top' | 'bottom') ?? 'top';
  const isDismissible = dismissibleProp ?? content.dismissible !== false;
  const variant = variantProp ?? 'default';
  const ctaStyle = ctaVariantProp ?? 'button';

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    onDismiss();
  }, [onDismiss]);

  const themedStyles = useMemo(() => {
    const { colors, typography, shape } = theme;

    // Resolve variant colors
    let bgColor: string;
    let textColor: string;
    switch (variant) {
      case 'info':
        bgColor = accentColorProp ?? colors.surface;
        textColor = accentTextColorProp ?? colors.accent;
        break;
      case 'upsell':
        bgColor = accentColorProp ?? colors.secondary;
        textColor = accentTextColorProp ?? colors.accent;
        break;
      case 'warning':
        bgColor = accentColorProp ?? '#FEF3C7';
        textColor = accentTextColorProp ?? colors.warning;
        break;
      default:
        bgColor = accentColorProp ?? colors.primary;
        textColor = accentTextColorProp ?? colors.primaryText;
    }

    return {
      banner: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 24px',
        lineHeight: '1.5',
        zIndex: 9990,
        width: '100%',
        boxSizing: 'border-box' as const,
        backgroundColor: bgColor,
        color: textColor,
        fontFamily: typography.fontFamily,
        fontSize: typography.fontSize,
        position: 'sticky' as const,
        ...(position === 'bottom' ? { bottom: 0 } : { top: 0 }),
      },
      header: {
        fontWeight: 600,
        fontSize: '15px',
      },
      body: {
        opacity: 0.9,
      },
      ctaButton: {
        padding: '6px 16px',
        backgroundColor: textColor,
        color: bgColor,
        border: 'none',
        borderRadius: shape.borderRadiusSmall,
        fontWeight: 600,
        fontSize: typography.fontSizeSmall,
        cursor: 'pointer',
        whiteSpace: 'nowrap' as const,
      },
      ctaLink: {
        padding: 0,
        background: 'none',
        border: 'none',
        color: textColor,
        fontWeight: 500,
        fontSize: typography.fontSizeSmall,
        cursor: 'pointer',
        whiteSpace: 'nowrap' as const,
        textDecoration: 'none',
      },
      dismiss: {
        padding: '4px 8px',
        background: 'transparent',
        border: 'none',
        color: textColor,
        fontSize: '18px',
        cursor: 'pointer',
        opacity: 0.7,
        lineHeight: 1,
      },
    };
  }, [theme, position, variant, accentColorProp, accentTextColorProp]);

  if (!visible || dismissed) return null;

  const resolvedCtaLabel = ctaLabel ?? content.cta_label;

  return (
    <div
      className={className}
      style={{ ...themedStyles.banner, ...style }}
      role="banner"
      data-rt-placement="banner"
    >
      {children ?? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
          {icon}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {content.header && <div style={themedStyles.header}>{content.header}</div>}
            {(content.body || content.message) && (
              <div style={themedStyles.body}>{content.body || content.message}</div>
            )}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '16px', flexShrink: 0 }}>
        {resolvedCtaLabel && (
          <button
            type="button"
            style={ctaStyle === 'link' ? themedStyles.ctaLink : themedStyles.ctaButton}
            onClick={onCtaClick}
          >
            {resolvedCtaLabel}
          </button>
        )}
        {isDismissible && (
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

BannerFrame.displayName = 'BannerFrame';
