import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { PlacementSlotProps } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';

/** Props for {@link InlineEmbedSlot}. */
export type InlineEmbedSlotProps = PlacementSlotProps;

const imageLayoutStyle: CSSProperties = {
  width: '100%',
  maxHeight: '180px',
  objectFit: 'cover',
  marginBottom: '12px',
};

/**
 * Inline card/embed placement rendered within the page flow.
 *
 * Lightweight card with optional image, header, body, and CTA button.
 * Designed to sit naturally within page content.
 *
 * **Content fields used:** `header`, `body`, `message`, `image_url`, `cta_label`
 */
export function InlineEmbedSlot({
  content,
  onCtaClick,
  visible,
  className,
  style,
}: InlineEmbedSlotProps) {
  const theme = useRevTurbineTheme();

  const themedStyles = useMemo(() => {
    const { colors, typography, shape } = theme;
    return {
      container: {
        backgroundColor: colors.surface,
        border: `1px solid ${colors.surfaceBorder}`,
        borderRadius: shape.borderRadius,
        padding: '20px',
        fontFamily: typography.fontFamily,
        boxSizing: 'border-box',
      } as CSSProperties,
      header: {
        fontSize: '16px',
        fontWeight: 600,
        color: colors.text,
        marginBottom: '6px',
        lineHeight: 1.4,
      } as CSSProperties,
      body: {
        fontSize: typography.fontSize,
        color: colors.textSecondary,
        lineHeight: 1.6,
        marginBottom: '16px',
      } as CSSProperties,
      image: {
        ...imageLayoutStyle,
        borderRadius: shape.borderRadiusSmall,
      } as CSSProperties,
      cta: {
        padding: '8px 20px',
        backgroundColor: colors.primary,
        color: colors.primaryText,
        border: 'none',
        borderRadius: shape.borderRadiusSmall,
        fontWeight: 600,
        fontSize: typography.fontSizeSmall,
        cursor: 'pointer',
      } as CSSProperties,
    };
  }, [theme]);

  if (!visible) return null;

  return (
    <div
      className={className}
      style={{ ...themedStyles.container, ...style }}
      data-rt-placement="inline-embed"
    >
      {content.image_url && (
        <img src={content.image_url} alt="" style={themedStyles.image} />
      )}

      {content.header && <div style={themedStyles.header}>{content.header}</div>}
      {(content.body || content.message) && (
        <div style={themedStyles.body}>{content.body || content.message}</div>
      )}

      {content.cta_label && (
        <button type="button" style={themedStyles.cta} onClick={onCtaClick}>
          {content.cta_label}
        </button>
      )}
    </div>
  );
}

InlineEmbedSlot.displayName = 'InlineEmbedSlot';
