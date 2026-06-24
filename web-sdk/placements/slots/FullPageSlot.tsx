import type { CSSProperties } from 'react';
import type { PlacementSlotProps } from '../types';

/**
 * Props for {@link FullPageSlot}.
 * Extends {@link PlacementSlotProps} with page template options.
 */
export type FullPageSlotProps = PlacementSlotProps & {
  /** Page template layout. Currently informational; rendering is uniform. */
  pageTemplate?: 'plan_cards' | 'feature_comparison' | 'upgrade_comparison' | 'custom';
};

const containerStyle: CSSProperties = {
  maxWidth: '800px',
  margin: '0 auto',
  padding: '40px 24px',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  boxSizing: 'border-box',
};

const headerStyle: CSSProperties = {
  fontSize: '28px',
  fontWeight: 700,
  color: '#111827',
  textAlign: 'center',
  marginBottom: '12px',
  lineHeight: 1.3,
};

const bodyStyle: CSSProperties = {
  fontSize: '16px',
  color: '#4b5563',
  textAlign: 'center',
  lineHeight: 1.6,
  marginBottom: '32px',
  maxWidth: '600px',
  marginLeft: 'auto',
  marginRight: 'auto',
};

const ctaContainerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  gap: '16px',
};

const primaryButtonStyle: CSSProperties = {
  padding: '12px 32px',
  backgroundColor: '#1e40af',
  color: '#ffffff',
  border: 'none',
  borderRadius: '8px',
  fontWeight: 600,
  fontSize: '16px',
  cursor: 'pointer',
};

const secondaryButtonStyle: CSSProperties = {
  padding: '12px 32px',
  backgroundColor: 'transparent',
  color: '#4b5563',
  border: '1px solid #d1d5db',
  borderRadius: '8px',
  fontWeight: 500,
  fontSize: '16px',
  cursor: 'pointer',
};

export function FullPageSlot({
  content,
  onCtaClick,
  onSecondaryCtaClick,
  visible,
  className,
  style,
}: FullPageSlotProps) {
  if (!visible) return null;

  return (
    <div
      className={className}
      style={{ ...containerStyle, ...style }}
      data-rt-placement="full-page"
    >
      {content.header && <h1 style={headerStyle}>{content.header}</h1>}
      {content.body && <p style={bodyStyle}>{content.body}</p>}

      <div style={ctaContainerStyle}>
        {content.cta_label && (
          <button type="button" style={primaryButtonStyle} onClick={onCtaClick}>
            {content.cta_label}
          </button>
        )}
        {content.secondary_cta_label && onSecondaryCtaClick && (
          <button type="button" style={secondaryButtonStyle} onClick={onSecondaryCtaClick}>
            {content.secondary_cta_label}
          </button>
        )}
      </div>
    </div>
  );
}

FullPageSlot.displayName = 'FullPageSlot';
