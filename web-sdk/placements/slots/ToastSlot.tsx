import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { PlacementSlotProps } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';

/**
 * Props for {@link ToastSlot}.
 * Extends {@link PlacementSlotProps} with toast-specific options.
 */
export type ToastSlotProps = PlacementSlotProps & {
  /** Auto-dismiss duration in seconds. Set to `0` to disable. Default `5`. */
  duration?: number;
  /** Screen position for the toast notification. Default `'bottom-right'`. */
  toastPosition?: 'top-right' | 'bottom-right' | 'bottom-center';
};

const positionStyles: Record<string, React.CSSProperties> = {
  'top-right': { top: '16px', right: '16px' },
  'bottom-right': { bottom: '16px', right: '16px' },
  'bottom-center': { bottom: '16px', left: '50%', transform: 'translateX(-50%)' },
};

const containerLayoutStyle: React.CSSProperties = {
  position: 'absolute',
  zIndex: 9995,
  maxWidth: '380px',
  width: '90%',
  lineHeight: 1.5,
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  boxSizing: 'border-box',
};

const messageStyle: React.CSSProperties = {
  flex: 1,
};

export function ToastSlot({
  content,
  onCtaClick,
  onDismiss,
  visible,
  className,
  style,
}: ToastSlotProps) {
  const theme = useRevTurbineTheme();
  const [shown, setShown] = useState(visible);
  const [prevVisible, setPrevVisible] = useState(visible);

  // Derive shown state during render when visible transitions to true
  if (visible && !prevVisible) {
    setShown(true);
  }
  if (visible !== prevVisible) {
    setPrevVisible(visible);
  }

  const position = (content.position as string) || 'bottom-right';
  const duration = typeof content.duration === 'number' ? content.duration : 5;

  const handleDismiss = useCallback(() => {
    setShown(false);
    onDismiss();
  }, [onDismiss]);

  useEffect(() => {
    if (!shown || duration <= 0) return;
    const timer = setTimeout(() => {
      handleDismiss();
    }, duration * 1000);
    return () => clearTimeout(timer);
  }, [shown, duration, handleDismiss]);

  const themedStyles = useMemo(() => {
    const { colors, typography, shape, shadows } = theme;
    return {
      container: {
        ...containerLayoutStyle,
        backgroundColor: colors.toastBackground,
        color: colors.toastText,
        borderRadius: shape.borderRadius,
        boxShadow: shadows.medium,
        padding: '14px 18px',
        fontFamily: typography.fontFamily,
        fontSize: typography.fontSize,
      } as React.CSSProperties,
      cta: {
        color: colors.info,
        background: 'transparent',
        border: 'none',
        fontWeight: 600,
        fontSize: typography.fontSizeSmall,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        textDecoration: 'underline',
        padding: 0,
      } as React.CSSProperties,
      close: {
        background: 'transparent',
        border: 'none',
        color: colors.textMuted,
        fontSize: '16px',
        cursor: 'pointer',
        padding: '2px 4px',
        lineHeight: 1,
        flexShrink: 0,
      } as React.CSSProperties,
    };
  }, [theme]);

  if (!shown) return null;

  const posStyle = positionStyles[position] ?? positionStyles['bottom-right'];

  return (
    <div
      className={className}
      style={{ ...themedStyles.container, ...posStyle, ...style }}
      role="status"
      aria-live="polite"
      data-rt-placement="toast"
    >
      <div style={messageStyle}>
        {content.message || content.body || content.header}
      </div>
      {content.cta_label && (
        <button type="button" style={themedStyles.cta} onClick={onCtaClick}>
          {content.cta_label}
        </button>
      )}
      <button type="button" style={themedStyles.close} onClick={handleDismiss} aria-label="Close">
        ×
      </button>
    </div>
  );
}

ToastSlot.displayName = 'ToastSlot';
