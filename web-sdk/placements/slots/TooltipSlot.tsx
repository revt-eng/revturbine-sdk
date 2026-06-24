import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { PlacementSlotProps } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

export type TooltipSlotProps = PlacementSlotProps & {
  /** Preferred side for anchored tooltip rendering. */
  tooltipPosition?: TooltipPosition;
  /** Optional CSS selector used to anchor the tooltip to an on-page element. */
  anchorSelector?: string;
};

type AnchorRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

const floatingFallbackStyle: React.CSSProperties = {
  position: 'absolute',
  top: '16px',
  right: '16px',
};

function calculateAnchoredStyle(rect: AnchorRect, position: TooltipPosition, gap: number): React.CSSProperties {
  if (position === 'top') {
    return {
      position: 'fixed',
      left: `${rect.left + rect.width / 2}px`,
      top: `${rect.top - gap}px`,
      transform: 'translate(-50%, -100%)',
    };
  }

  if (position === 'left') {
    return {
      position: 'fixed',
      left: `${rect.left - gap}px`,
      top: `${rect.top + rect.height / 2}px`,
      transform: 'translate(-100%, -50%)',
    };
  }

  if (position === 'right') {
    return {
      position: 'fixed',
      left: `${rect.left + rect.width + gap}px`,
      top: `${rect.top + rect.height / 2}px`,
      transform: 'translate(0, -50%)',
    };
  }

  return {
    position: 'fixed',
    left: `${rect.left + rect.width / 2}px`,
    top: `${rect.top + rect.height + gap}px`,
    transform: 'translate(-50%, 0)',
  };
}

export function TooltipSlot({
  content,
  onCtaClick,
  onDismiss,
  visible,
  className,
  style,
}: TooltipSlotProps) {
  const theme = useRevTurbineTheme();
  const [dismissed, setDismissed] = useState(false);
  const [anchorRect, setAnchorRect] = useState<AnchorRect | null>(null);
  const anchorSelector = (content.anchor_selector as string) || undefined;
  const tooltipPosition = ((content.position as string) || 'top') as TooltipPosition;
  const anchorGap = typeof content.anchor_gap === 'number' ? content.anchor_gap : 10;

  const resolveAnchor = useCallback(() => {
    if (!anchorSelector || typeof window === 'undefined') {
      setAnchorRect(null);
      return;
    }

    const target = window.document.querySelector(anchorSelector);
    if (!target) {
      setAnchorRect(null);
      return;
    }

    const rect = target.getBoundingClientRect();
    setAnchorRect({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    });
  }, [anchorSelector]);

  useEffect(() => {
    if (!visible) return;
    setDismissed(false);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    resolveAnchor();
    if (typeof window === 'undefined') return;

    const onWindowChange = () => resolveAnchor();
    window.addEventListener('resize', onWindowChange);
    window.addEventListener('scroll', onWindowChange, true);

    return () => {
      window.removeEventListener('resize', onWindowChange);
      window.removeEventListener('scroll', onWindowChange, true);
    };
  }, [visible, resolveAnchor]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    onDismiss();
  }, [onDismiss]);

  const themedStyles = useMemo(() => {
    const { colors, typography, shape, shadows } = theme;
    return {
      container: {
        zIndex: 9996,
        maxWidth: '320px',
        width: 'max-content',
        lineHeight: 1.45,
        display: 'flex',
        flexDirection: 'column' as const,
        gap: '10px',
        boxSizing: 'border-box' as const,
        backgroundColor: colors.toastBackground,
        color: colors.toastText,
        borderRadius: shape.borderRadius,
        boxShadow: shadows.medium,
        padding: '12px 14px',
        fontFamily: typography.fontFamily,
        fontSize: typography.fontSizeSmall,
      },
      body: {
        margin: 0,
      },
      actions: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      },
      cta: {
        color: colors.info,
        background: 'transparent',
        border: 'none',
        fontWeight: 600,
        fontSize: typography.fontSizeSmall,
        cursor: 'pointer',
        textDecoration: 'underline',
        padding: 0,
      },
      close: {
        marginLeft: 'auto',
        background: 'transparent',
        border: 'none',
        color: colors.textMuted,
        fontSize: '14px',
        cursor: 'pointer',
        lineHeight: 1,
        padding: '2px 4px',
      },
    } as const;
  }, [theme]);

  if (!visible || dismissed) return null;

  const anchoredStyle = anchorRect
    ? calculateAnchoredStyle(anchorRect, tooltipPosition, anchorGap)
    : floatingFallbackStyle;

  return (
    <div
      className={className}
      style={{ ...themedStyles.container, ...anchoredStyle, ...style }}
      role="status"
      aria-live="polite"
      data-rt-placement="tooltip"
    >
      <p style={themedStyles.body}>{content.message || content.body || content.header}</p>
      <div style={themedStyles.actions}>
        {content.cta_label && (
          <button type="button" style={themedStyles.cta} onClick={onCtaClick}>
            {content.cta_label}
          </button>
        )}
        <button type="button" style={themedStyles.close} onClick={handleDismiss} aria-label="Close tooltip">
          ×
        </button>
      </div>
    </div>
  );
}

TooltipSlot.displayName = 'TooltipSlot';