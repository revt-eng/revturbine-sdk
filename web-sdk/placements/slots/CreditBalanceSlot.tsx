import type { CSSProperties } from 'react';
import type { PlacementSlotProps } from '../types';

/**
 * Props for {@link CreditBalanceSlot}.
 * Extends {@link PlacementSlotProps} with balance display options.
 */
export type CreditBalanceSlotProps = PlacementSlotProps & {
  /**
   * Visual display variant.
   * - `numeric_balance` — large number (default)
   * - `balance_bar` — horizontal progress bar
   * - `balance_burn_rate` — bar with burn rate label
   */
  displayStyle?: 'numeric_balance' | 'balance_bar' | 'balance_burn_rate';
};

const containerStyle: CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  padding: '16px 20px',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  boxSizing: 'border-box',
};

const balanceRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  marginBottom: '4px',
};

const balanceLabelStyle: CSSProperties = {
  fontSize: '13px',
  color: '#6b7280',
};

const balanceValueStyle: CSSProperties = {
  fontSize: '28px',
  fontWeight: 700,
  color: '#111827',
};

const burnRateStyle: CSSProperties = {
  fontSize: '12px',
  color: '#9ca3af',
  marginBottom: '12px',
};

const trackStyle: CSSProperties = {
  width: '100%',
  height: '6px',
  backgroundColor: '#e5e7eb',
  borderRadius: '3px',
  overflow: 'hidden',
  marginBottom: '12px',
};

const fillStyle: CSSProperties = {
  height: '100%',
  borderRadius: '3px',
  transition: 'width 0.3s ease',
};

const ctaContainerStyle: CSSProperties = {
  display: 'flex',
  gap: '8px',
};

const ctaButtonStyle: CSSProperties = {
  padding: '6px 16px',
  backgroundColor: '#1e40af',
  color: '#ffffff',
  border: 'none',
  borderRadius: '6px',
  fontWeight: 600,
  fontSize: '13px',
  cursor: 'pointer',
};

function getBarColor(remaining: number, total: number): string {
  if (total <= 0) return '#1e40af';
  const pct = (remaining / total) * 100;
  if (pct <= 10) return '#dc2626';
  if (pct <= 25) return '#f59e0b';
  return '#1e40af';
}

export function CreditBalanceSlot({
  content,
  onCtaClick,
  visible,
  className,
  style,
}: CreditBalanceSlotProps) {
  if (!visible) return null;

  const remaining = typeof content.credits_remaining === 'number'
    ? content.credits_remaining
    : 0;
  const total = typeof content.credits_total === 'number'
    ? content.credits_total
    : remaining;
  const showAt = typeof content.show_at === 'number' ? content.show_at : 0;
  const showBurnRate = content.show_burn_rate === true;
  const displayStyle = (content.display_style as string) || 'numeric_balance';

  // Hide if balance is above threshold
  if (showAt > 0 && remaining > showAt) return null;

  const pct = total > 0 ? (remaining / total) * 100 : 0;

  return (
    <div
      className={className}
      style={{ ...containerStyle, ...style }}
      data-rt-placement="credit-balance"
    >
      <div style={balanceRowStyle}>
        <span style={balanceLabelStyle}>
          {typeof content.header === 'string' ? content.header : 'Credits Remaining'}
        </span>
        <span style={balanceValueStyle}>{String(remaining)}</span>
      </div>

      {showBurnRate && typeof content.burn_rate_label === 'string' && (
        <div style={burnRateStyle}>
          {content.burn_rate_label}
        </div>
      )}

      {(displayStyle === 'balance_bar' || displayStyle === 'balance_burn_rate') && total > 0 && (
        <div style={trackStyle}>
          <div
            style={{
              ...fillStyle,
              width: `${Math.min(100, pct)}%`,
              backgroundColor: getBarColor(remaining, total),
            }}
          />
        </div>
      )}

      <div style={ctaContainerStyle}>
        {content.cta_label && (
          <button type="button" style={ctaButtonStyle} onClick={onCtaClick}>
            {content.cta_label}
          </button>
        )}
      </div>
    </div>
  );
}

CreditBalanceSlot.displayName = 'CreditBalanceSlot';
