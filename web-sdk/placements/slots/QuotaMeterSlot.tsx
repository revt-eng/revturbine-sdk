import type { CSSProperties } from 'react';
import type { PlacementSlotProps, ResolvedContent } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';
import type { RevTurbineTheme } from '../../theme/types';

/**
 * Props for {@link QuotaMeterSlot}.
 * Extends {@link PlacementSlotProps} with display style options.
 */
export type QuotaMeterSlotProps = PlacementSlotProps & {
  /**
   * Visual display variant.
   * - `progress_bar` — horizontal bar (default)
   * - `circular_gauge` — SVG circle
   * - `numeric_counter` — large number display
   */
  displayStyle?: 'progress_bar' | 'circular_gauge' | 'numeric_counter';
};

function getPercentage(content: ResolvedContent): number {
  if (typeof content.usage_percent === 'number') return content.usage_percent;
  const current = typeof content.usage_current === 'number' ? content.usage_current : 0;
  const limit = typeof content.usage_limit === 'number' ? content.usage_limit : 100;
  return limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
}

function getFillColor(pct: number, theme: RevTurbineTheme): string {
  if (pct >= 90) return theme.colors.danger;
  if (pct >= 70) return theme.colors.warning;
  return theme.colors.primary;
}

function ProgressBar({ content, theme }: { content: ResolvedContent; theme: RevTurbineTheme }) {
  const pct = getPercentage(content);
  const current = content.usage_current ?? pct;
  const limit = content.usage_limit ?? 100;

  return (
    <>
      <div style={{
        fontSize: theme.typography.fontSizeSmall,
        color: theme.colors.textMuted,
        marginBottom: '8px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
      }}>
        <span>{typeof content.header === 'string' ? content.header : 'Usage'}</span>
        <span style={{ fontWeight: 600, color: theme.colors.text }}>
          {String(current)} / {String(limit)}
        </span>
      </div>
      <div style={{
        width: '100%',
        height: '8px',
        backgroundColor: theme.colors.track,
        borderRadius: theme.shape.borderRadiusSmall,
        overflow: 'hidden',
        marginBottom: '12px',
      }}>
        <div
          style={{
            height: '100%',
            borderRadius: theme.shape.borderRadiusSmall,
            transition: 'width 0.3s ease',
            width: `${Math.min(100, pct)}%`,
            backgroundColor: getFillColor(pct, theme),
          }}
        />
      </div>
    </>
  );
}

function NumericCounter({ content, theme }: { content: ResolvedContent; theme: RevTurbineTheme }) {
  const current = content.usage_current ?? 0;
  const limit = content.usage_limit ?? 100;

  return (
    <>
      <div style={{
        fontSize: '24px',
        fontWeight: 700,
        color: theme.colors.text,
        marginBottom: '4px',
      }}>{String(current)} / {String(limit)}</div>
      <div style={{
        fontSize: theme.typography.fontSizeSmall,
        color: theme.colors.textMuted,
        marginBottom: '12px',
      }}>{typeof content.header === 'string' ? content.header : 'Usage'}</div>
    </>
  );
}

const GAUGE_SIZE = 80;
const GAUGE_STROKE = 8;
const GAUGE_RADIUS = (GAUGE_SIZE - GAUGE_STROKE) / 2;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

function CircularGauge({ content, theme }: { content: ResolvedContent; theme: RevTurbineTheme }) {
  const pct = getPercentage(content);
  const current = content.usage_current ?? pct;
  const limit = content.usage_limit ?? 100;
  const offset = GAUGE_CIRCUMFERENCE - (pct / 100) * GAUGE_CIRCUMFERENCE;
  const color = getFillColor(pct, theme);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
      <svg width={GAUGE_SIZE} height={GAUGE_SIZE} style={{ flexShrink: 0 }}>
        <circle
          cx={GAUGE_SIZE / 2}
          cy={GAUGE_SIZE / 2}
          r={GAUGE_RADIUS}
          fill="none"
          stroke={theme.colors.track}
          strokeWidth={GAUGE_STROKE}
        />
        <circle
          cx={GAUGE_SIZE / 2}
          cy={GAUGE_SIZE / 2}
          r={GAUGE_RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={GAUGE_STROKE}
          strokeLinecap="round"
          strokeDasharray={GAUGE_CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${GAUGE_SIZE / 2} ${GAUGE_SIZE / 2})`}
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
        />
        <text
          x={GAUGE_SIZE / 2}
          y={GAUGE_SIZE / 2 + 1}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="16"
          fontWeight="700"
          fill={theme.colors.text}
        >
          {pct}%
        </text>
      </svg>
      <div>
        <div style={{ fontSize: theme.typography.fontSize, fontWeight: 600, color: theme.colors.text }}>
          {String(current)} / {String(limit)}
        </div>
        <div style={{ fontSize: theme.typography.fontSizeSmall, color: theme.colors.textMuted }}>
          {typeof content.header === 'string' ? content.header : 'Usage'}
        </div>
      </div>
    </div>
  );
}

export function QuotaMeterSlot({
  content,
  onCtaClick,
  visible,
  className,
  style,
}: QuotaMeterSlotProps) {
  const theme = useRevTurbineTheme();

  if (!visible) return null;

  const displayStyle = (content.display_style as string) || 'progress_bar';
  const showAt = typeof content.show_at === 'number' ? content.show_at : 0;
  const pct = getPercentage(content);

  if (showAt > 0 && pct < showAt) return null;

  const containerStyle: CSSProperties = {
    backgroundColor: theme.colors.surface,
    border: `1px solid ${theme.colors.surfaceBorder}`,
    borderRadius: theme.shape.borderRadius,
    padding: '16px 20px',
    fontFamily: theme.typography.fontFamily,
    boxSizing: 'border-box',
  };

  const ctaButtonStyle: CSSProperties = {
    padding: '6px 16px',
    backgroundColor: theme.colors.primary,
    color: theme.colors.primaryText,
    border: 'none',
    borderRadius: theme.shape.borderRadiusSmall,
    fontWeight: 600,
    fontSize: theme.typography.fontSizeSmall,
    cursor: 'pointer',
  };

  return (
    <div
      className={className}
      style={{ ...containerStyle, ...style }}
      data-rt-placement="quota-meter"
    >
      {displayStyle === 'numeric_counter' ? (
        <NumericCounter content={content} theme={theme} />
      ) : displayStyle === 'circular_gauge' ? (
        <CircularGauge content={content} theme={theme} />
      ) : (
        <ProgressBar content={content} theme={theme} />
      )}

      {content.cta_label && (
        <button type="button" style={ctaButtonStyle} onClick={onCtaClick}>
          {content.cta_label}
        </button>
      )}
    </div>
  );
}

QuotaMeterSlot.displayName = 'QuotaMeterSlot';
