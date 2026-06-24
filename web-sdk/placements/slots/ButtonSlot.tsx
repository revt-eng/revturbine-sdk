import React from 'react';
import type { PlacementSlotProps } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';

/**
 * Props for {@link ButtonSlot}.
 * Extends {@link PlacementSlotProps} with button styling options.
 */
export type ButtonSlotProps = PlacementSlotProps & {
  /** Visual style variant. Default `'primary'`. */
  buttonStyle?: 'primary' | 'secondary' | 'accent';
};

/**
 * Standalone CTA button placement.
 *
 * Renders a single styled button suitable for persistent nav CTAs
 * or inline upgrade prompts.
 *
 * **Content fields used:** `cta_label`, `style`
 */
export function ButtonSlot({
  content,
  onCtaClick,
  visible,
  className,
  style,
}: ButtonSlotProps) {
  const theme = useRevTurbineTheme();

  if (!visible) return null;

  const variant = (content.style as string) || 'primary';

  const baseStyle: React.CSSProperties = {
    padding: '8px 20px',
    border: 'none',
    borderRadius: theme.shape.borderRadiusSmall,
    fontWeight: 600,
    fontSize: theme.typography.fontSize,
    cursor: 'pointer',
    fontFamily: theme.typography.fontFamily,
    whiteSpace: 'nowrap',
    lineHeight: 1.4,
  };

  const variants: Record<string, React.CSSProperties> = {
    primary: {
      ...baseStyle,
      backgroundColor: theme.colors.primary,
      color: theme.colors.primaryText,
    },
    secondary: {
      ...baseStyle,
      backgroundColor: theme.colors.secondary,
      color: theme.colors.secondaryText,
      border: `1px solid ${theme.colors.surfaceBorder}`,
    },
    accent: {
      ...baseStyle,
      backgroundColor: theme.colors.accent,
      color: theme.colors.accentText,
    },
  };

  const variantStyle = variants[variant] ?? variants.primary;

  return (
    <button
      type="button"
      className={className}
      style={{ ...variantStyle, ...style }}
      onClick={onCtaClick}
      data-rt-placement="button"
    >
      {content.cta_label || 'Upgrade'}
    </button>
  );
}

ButtonSlot.displayName = 'ButtonSlot';
