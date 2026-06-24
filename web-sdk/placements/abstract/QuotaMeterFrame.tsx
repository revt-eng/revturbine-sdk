import React, { useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { PlacementSlotProps, ResolvedContent } from '../types';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface QuotaMeterFrameProps<C extends ResolvedContent = ResolvedContent>
  extends PlacementSlotProps<C> {
  /**
   * Visual display variant.
   * - `progress_bar` — horizontal bar (default)
   * - `circular_gauge` — SVG circle
   * - `numeric_counter` — large number display
   */
  displayStyle?: 'progress_bar' | 'circular_gauge' | 'numeric_counter';
  /**
   * Size variant.
   * - `standard` — full card with padding (default)
   * - `compact` — minimal inline layout (mini meter)
   */
  size?: 'standard' | 'compact';
  /** Current usage value (overrides `content.usage_current`). */
  usageCurrent?: number;
  /** Usage limit (overrides `content.usage_limit`). */
  usageLimit?: number;
  /** Percentage threshold — hides the meter when usage is below this. */
  showAtPercent?: number;
  /** Override the CTA label. */
  ctaLabel?: string;
  /** CTA visual style. `button` renders a filled pill; `link` renders a text link. */
  ctaVariant?: 'button' | 'link';
  /** Accent color for the CTA link variant. */
  accentColor?: string;
  /** Custom content rendered below the meter. */
  children?: React.ReactNode;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getPercentage(current: number, limit: number): number {
  return limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
}

function getFillColor(pct: number): string {
  if (pct >= 90) return '#dc2626';
  if (pct >= 70) return '#f59e0b';
  return '#1e40af';
}

const containerStyle: CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  padding: '16px 20px',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  boxSizing: 'border-box',
};

const labelStyle: CSSProperties = {
  fontSize: '13px',
  color: '#6b7280',
  marginBottom: '8px',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
};

const trackStyle: CSSProperties = {
  width: '100%',
  height: '8px',
  backgroundColor: '#e5e7eb',
  borderRadius: '4px',
  overflow: 'hidden',
  marginBottom: '12px',
};

const fillBaseStyle: CSSProperties = {
  height: '100%',
  borderRadius: '4px',
  transition: 'width 0.3s ease',
};

const numericStyle: CSSProperties = {
  fontSize: '24px',
  fontWeight: 700,
  color: '#111827',
  marginBottom: '4px',
};

const numericLabelStyle: CSSProperties = {
  fontSize: '13px',
  color: '#6b7280',
  marginBottom: '12px',
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

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function ProgressBar({ header, current, limit, pct }: { header: string; current: number; limit: number; pct: number }) {
  return (
    <>
      <div style={labelStyle}>
        <span>{header}</span>
        <span style={{ fontWeight: 600, color: '#111827' }}>
          {current} / {limit}
        </span>
      </div>
      <div style={trackStyle}>
        <div
          style={{
            ...fillBaseStyle,
            width: `${Math.min(100, pct)}%`,
            backgroundColor: getFillColor(pct),
          }}
        />
      </div>
    </>
  );
}

function NumericCounter({ header, current, limit }: { header: string; current: number; limit: number }) {
  return (
    <>
      <div style={numericStyle}>{current} / {limit}</div>
      <div style={numericLabelStyle}>{header}</div>
    </>
  );
}

const GAUGE_SIZE = 80;
const GAUGE_STROKE = 8;
const GAUGE_RADIUS = (GAUGE_SIZE - GAUGE_STROKE) / 2;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

function CircularGauge({ header, current, limit, pct }: { header: string; current: number; limit: number; pct: number }) {
  const offset = GAUGE_CIRCUMFERENCE - (pct / 100) * GAUGE_CIRCUMFERENCE;
  const color = getFillColor(pct);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
      <svg width={GAUGE_SIZE} height={GAUGE_SIZE} style={{ flexShrink: 0 }}>
        <circle
          cx={GAUGE_SIZE / 2}
          cy={GAUGE_SIZE / 2}
          r={GAUGE_RADIUS}
          fill="none"
          stroke="#e5e7eb"
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
          fill="#111827"
        >
          {pct}%
        </text>
      </svg>
      <div>
        <div style={{ fontSize: '14px', fontWeight: 600, color: '#111827' }}>
          {current} / {limit}
        </div>
        <div style={{ fontSize: '13px', color: '#6b7280' }}>{header}</div>
      </div>
    </div>
  );
}

/* ---- Compact circular gauge (16x16 inline mini-arc) ---- */

const COMPACT_SIZE = 16;
const COMPACT_RADIUS = 6.5;
const COMPACT_STROKE = 2.5;
const COMPACT_CIRCUMFERENCE = 2 * Math.PI * COMPACT_RADIUS;

function getCompactColor(ratio: number): { arc: string; track: string } {
  if (ratio < 0.1) return { arc: '#DC2626', track: '#FEE2E2' };
  if (ratio < 0.33) return { arc: '#CA8A04', track: '#FEF9C3' };
  return { arc: '#2563EB', track: '#E5E7EB' };
}

export interface CompactCircularGaugeProps {
  /** Value between 0 and 1 (fraction filled). */
  ratio: number;
  /** Rendered size in pixels. Defaults to 16. */
  size?: number;
  /** Override arc/track colors. By default, red/yellow/blue based on ratio. */
  arcColor?: string;
  trackColor?: string;
}

/**
 * Minimal circular gauge for inline usage indicators.
 * Can be used standalone or as part of a `QuotaMeterFrame`.
 */
export function CompactCircularGauge({ ratio, size: sizeProp, arcColor, trackColor }: CompactCircularGaugeProps) {
  const dim = sizeProp ?? COMPACT_SIZE;
  const defaults = getCompactColor(ratio);
  const arc = arcColor ?? defaults.arc;
  const track = trackColor ?? defaults.track;
  const dashLength = ratio * COMPACT_CIRCUMFERENCE;

  return (
    <svg
      viewBox="0 0 16 16"
      style={{ width: dim, height: dim, transform: 'rotate(-90deg)', flexShrink: 0 }}
    >
      <circle cx="8" cy="8" r={COMPACT_RADIUS} fill="none" stroke={track} strokeWidth={COMPACT_STROKE} />
      <circle
        cx="8"
        cy="8"
        r={COMPACT_RADIUS}
        fill="none"
        stroke={arc}
        strokeWidth={COMPACT_STROKE}
        strokeDasharray={`${dashLength} ${COMPACT_CIRCUMFERENCE}`}
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

/**
 * Quota/usage meter with multiple display variants.
 *
 * Handles:
 * - Progress bar, circular gauge, or numeric counter rendering
 * - Threshold-based visibility (`showAtPercent`)
 * - Typed usage props override content fields
 * - `data-rt-placement="quota-meter"` attribute
 *
 * Extend by wrapping and injecting `children` for custom content below the meter.
 *
 * @example
 * ```tsx
 * function MinutesMeter(props: PlacementSlotProps<MeterContent>) {
 *   const { minutesUsed, minutesLimit } = useUsage();
 *   return (
 *     <QuotaMeterFrame
 *       {...props}
 *       displayStyle="circular_gauge"
 *       usageCurrent={minutesUsed}
 *       usageLimit={minutesLimit}
 *     />
 *   );
 * }
 * ```
 */
export function QuotaMeterFrame<C extends ResolvedContent = ResolvedContent>({
  content,
  onCtaClick,
  visible,
  className,
  style,
  displayStyle: displayStyleProp,
  size: sizeProp,
  usageCurrent: usageCurrentProp,
  usageLimit: usageLimitProp,
  showAtPercent: showAtPercentProp,
  ctaLabel,
  ctaVariant: ctaVariantProp,
  accentColor: accentColorProp,
  children,
}: QuotaMeterFrameProps<C>) {
  const resolvedDisplayStyle = displayStyleProp ?? (content.display_style as string) ?? 'progress_bar';
  const size = sizeProp ?? 'standard';
  const ctaVariant = ctaVariantProp ?? 'button';
  const current = usageCurrentProp ?? (typeof content.usage_current === 'number' ? content.usage_current : 0);
  const limit = usageLimitProp ?? (typeof content.usage_limit === 'number' ? content.usage_limit : 100);
  const pct = typeof content.usage_percent === 'number' ? content.usage_percent : getPercentage(current, limit);
  const ratio = limit > 0 ? Math.max(0, Math.min(1, current / limit)) : 0;
  const showAt = showAtPercentProp ?? (typeof content.show_at === 'number' ? content.show_at : 0);
  const header = typeof content.header === 'string' ? content.header : 'Usage';
  const resolvedCtaLabel = ctaLabel ?? content.cta_label;

  const mergedContainerStyle = useMemo<CSSProperties>(
    () => (size === 'compact'
      ? { display: 'flex', alignItems: 'center', gap: '12px', ...style }
      : { ...containerStyle, ...style }),
    [style, size],
  );

  const ctaStyles = useMemo<CSSProperties>(() => {
    if (ctaVariant === 'link') {
      return {
        marginLeft: 'auto',
        fontSize: '13px',
        fontWeight: 500,
        color: accentColorProp ?? '#762DCC',
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
      };
    }
    return ctaButtonStyle;
  }, [ctaVariant, accentColorProp]);

  if (!visible) return null;
  if (showAt > 0 && pct < showAt) return null;

  /* ----- Compact layout ----- */
  if (size === 'compact') {
    return (
      <div
        className={className}
        style={mergedContainerStyle}
        data-rt-placement="quota-meter"
      >
        <CompactCircularGauge ratio={ratio} />

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {content.header && (
            <span style={{ fontSize: 13, fontWeight: 500, color: '#212121', lineHeight: '18px' }}>
              {content.header}
            </span>
          )}
          {content.body && (
            <span style={{ fontSize: 12, color: '#9E9E9E', lineHeight: '16px' }}>
              {content.body}
            </span>
          )}
        </div>

        {children}

        {resolvedCtaLabel && (
          <button type="button" style={ctaStyles} onClick={onCtaClick}>
            {resolvedCtaLabel}
          </button>
        )}
      </div>
    );
  }

  /* ----- Standard layout ----- */
  return (
    <div
      className={className}
      style={mergedContainerStyle}
      data-rt-placement="quota-meter"
    >
      {resolvedDisplayStyle === 'numeric_counter' ? (
        <NumericCounter header={header} current={current} limit={limit} />
      ) : resolvedDisplayStyle === 'circular_gauge' ? (
        <CircularGauge header={header} current={current} limit={limit} pct={pct} />
      ) : (
        <ProgressBar header={header} current={current} limit={limit} pct={pct} />
      )}

      {children}

      {resolvedCtaLabel && (
        <button type="button" style={ctaStyles} onClick={onCtaClick}>
          {resolvedCtaLabel}
        </button>
      )}
    </div>
  );
}

QuotaMeterFrame.displayName = 'QuotaMeterFrame';
