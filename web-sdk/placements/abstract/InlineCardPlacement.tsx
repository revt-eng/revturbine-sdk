import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { PlacementSlotProps, ResolvedContent } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface InlineCardPlacementProps<C extends ResolvedContent = ResolvedContent>
  extends PlacementSlotProps<C> {
  /** Override the CTA label. */
  ctaLabel?: string;
  /**
   * Content alignment.
   * - `left` — standard left-aligned card (default)
   * - `center` — centered content (for gate-style cards)
   */
  alignment?: 'left' | 'center';
  /**
   * CTA visual style.
   * - `filled` — solid background button (default)
   * - `outline` — border-only button
   * - `inline` — text-only compact button
   */
  ctaVariant?: 'filled' | 'outline' | 'inline';
  /** Accent color for CTA buttons. */
  accentColor?: string;
  /** Icon element rendered above the header (for gate-style cards). */
  icon?: React.ReactNode;
  /** Custom body to replace default content layout. */
  children?: React.ReactNode;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

/**
 * Abstract inline card/embed placement rendered within the page flow.
 *
 * Handles:
 * - Visibility gating
 * - Theme-aware card container with border, radius, padding
 * - Optional image, header, body, and CTA
 * - `data-rt-placement="inline-embed"` attribute
 *
 * Extend by wrapping and injecting `children` for custom card bodies.
 *
 * @example
 * ```tsx
 * function FeatureCallout(props: PlacementSlotProps<MyContent>) {
 *   return (
 *     <InlineCardPlacement {...props}>
 *       <FeatureGrid features={props.content.features} />
 *     </InlineCardPlacement>
 *   );
 * }
 * ```
 */
export function InlineCardPlacement<C extends ResolvedContent = ResolvedContent>({
  content,
  onCtaClick,
  visible,
  className,
  style,
  ctaLabel,
  alignment: alignmentProp,
  ctaVariant: ctaVariantProp,
  accentColor: accentColorProp,
  icon,
  children,
}: InlineCardPlacementProps<C>) {
  const theme = useRevTurbineTheme();
  const alignment = alignmentProp ?? 'left';
  const ctaVariant = ctaVariantProp ?? 'filled';

  const themedStyles = useMemo(() => {
    const { colors, typography, shape } = theme;
    const resolvedAccent = accentColorProp ?? colors.primary;
    const isCentered = alignment === 'center';

    const container: CSSProperties = {
      backgroundColor: colors.surface,
      border: `1px solid ${colors.surfaceBorder}`,
      borderRadius: shape.borderRadius,
      padding: '20px',
      fontFamily: typography.fontFamily,
      boxSizing: 'border-box',
      display: isCentered ? 'flex' : undefined,
      flexDirection: isCentered ? 'column' : undefined,
      alignItems: isCentered ? 'center' : undefined,
      justifyContent: isCentered ? 'center' : undefined,
      gap: isCentered ? '16px' : undefined,
      textAlign: isCentered ? 'center' : undefined,
    };
    const header: CSSProperties = {
      fontSize: '16px',
      fontWeight: 600,
      color: colors.text,
      marginBottom: isCentered ? 0 : '6px',
      lineHeight: 1.4,
    };
    const body: CSSProperties = {
      fontSize: typography.fontSize,
      color: colors.textSecondary,
      lineHeight: 1.6,
      marginBottom: isCentered ? 0 : '16px',
      maxWidth: isCentered ? '400px' : undefined,
    };
    const image: CSSProperties = {
      width: '100%',
      maxHeight: '180px',
      objectFit: 'cover',
      marginBottom: '12px',
      borderRadius: shape.borderRadiusSmall,
    };

    const ctaBase: CSSProperties = {
      borderRadius: shape.borderRadiusSmall,
      fontWeight: 600,
      fontSize: typography.fontSizeSmall,
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
    };
    let ctaButton: CSSProperties;
    switch (ctaVariant) {
      case 'outline':
        ctaButton = {
          ...ctaBase,
          padding: '8px 16px',
          backgroundColor: 'transparent',
          color: colors.text,
          border: `1px solid ${colors.surfaceBorder}`,
        };
        break;
      case 'inline':
        ctaButton = {
          ...ctaBase,
          padding: '4px 8px',
          backgroundColor: resolvedAccent,
          color: colors.primaryText,
          border: 'none',
        };
        break;
      default: // filled
        ctaButton = {
          ...ctaBase,
          padding: '8px 20px',
          backgroundColor: resolvedAccent,
          color: colors.primaryText,
          border: 'none',
        };
    }
    return { container, header, body, image, ctaButton };
  }, [theme, alignment, ctaVariant, accentColorProp]);

  if (!visible) return null;

  const resolvedCtaLabel = ctaLabel ?? content.cta_label;

  return (
    <div
      className={className}
      style={{ ...themedStyles.container, ...style }}
      data-rt-placement="inline-embed"
    >
      {children ?? (
        <>
          {icon}
          {content.image_url && !icon && (
            <img src={content.image_url} alt="" style={themedStyles.image} />
          )}
          {content.header && <div style={themedStyles.header}>{content.header}</div>}
          {(content.body || content.message) && (
            <div style={themedStyles.body}>{content.body || content.message}</div>
          )}
        </>
      )}

      {resolvedCtaLabel && (
        <button type="button" style={themedStyles.ctaButton} onClick={onCtaClick}>
          {resolvedCtaLabel}
        </button>
      )}
    </div>
  );
}

InlineCardPlacement.displayName = 'InlineCardPlacement';
