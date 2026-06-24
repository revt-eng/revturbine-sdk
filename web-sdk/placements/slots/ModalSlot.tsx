import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlacementSlotProps } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';

/**
 * Props for {@link ModalSlot}.
 * Extends {@link PlacementSlotProps} with modal-specific options.
 */
export type ModalSlotProps = PlacementSlotProps & {
  /**
   * Modal dismissibility behavior.
   * - `optional` — user can dismiss via ESC, close button, or clicking outside
   * - `blocking` — user must interact with a CTA (no dismiss controls)
   */
  modalType?: 'optional' | 'blocking';
};

const overlayLayoutStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
};

const imageStyle: React.CSSProperties = {
  width: '100%',
  maxHeight: '200px',
  objectFit: 'cover',
  marginBottom: '16px',
};

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: '12px',
  justifyContent: 'flex-end',
};

/**
 * Centered modal overlay placement.
 *
 * Supports optional and blocking modes. Optional modals can be
 * dismissed via ESC key, close button, or overlay click. Blocking modals
 * require CTA interaction.
 *
 * **Content fields used:** `header`, `body`, `image_url`, `cta_label`, `secondary_cta_label`, `style`
 *
 * **Accessibility:** `role="dialog"`, `aria-modal="true"`, keyboard trap
 */
export function ModalSlot({
  content,
  onCtaClick,
  onSecondaryCtaClick,
  onDismiss,
  visible,
  className,
  style,
}: ModalSlotProps) {
  const theme = useRevTurbineTheme();
  const dialogRef = useRef<HTMLDivElement>(null);
  const modalType = (content.style as 'optional' | 'blocking') || 'optional';
  const [dismissed, setDismissed] = useState(false);
  const prevVisibleRef = useRef(visible);

  useEffect(() => {
    // Reset dismissed state when parent re-shows the placement.
    if (visible && !prevVisibleRef.current) {
      setDismissed(false);
    }
    prevVisibleRef.current = visible;
  }, [visible]);

  const handleDismissInternal = useCallback(() => {
    setDismissed(true);
    onDismiss();
  }, [onDismiss]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (modalType === 'optional' && e.target === e.currentTarget) {
        handleDismissInternal();
      }
    },
    [modalType, handleDismissInternal],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalType === 'optional') {
        handleDismissInternal();
      }
    },
    [modalType, handleDismissInternal],
  );

  useEffect(() => {
    if (!visible) return;
    document.addEventListener('keydown', handleKeyDown);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [visible, handleKeyDown]);

  const themedStyles = useMemo(() => {
    const { colors, typography, shape, shadows } = theme;
    return {
      overlay: {
        ...overlayLayoutStyle,
        backgroundColor: colors.overlay,
        fontFamily: typography.fontFamily,
      } as React.CSSProperties,
      dialog: {
        position: 'relative',
        maxWidth: '480px',
        width: '90%',
        backgroundColor: colors.background,
        borderRadius: shape.borderRadiusLarge,
        boxShadow: shadows.large,
        padding: '32px',
        boxSizing: 'border-box',
      } as React.CSSProperties,
      close: {
        position: 'absolute',
        top: '12px',
        right: '12px',
        background: 'transparent',
        border: 'none',
        fontSize: '20px',
        color: colors.textMuted,
        cursor: 'pointer',
        padding: '4px 8px',
        lineHeight: 1,
      } as React.CSSProperties,
      image: {
        ...imageStyle,
        borderRadius: shape.borderRadius,
      } as React.CSSProperties,
      header: {
        fontSize: typography.fontSizeHeader,
        fontWeight: 700,
        color: colors.text,
        marginBottom: '8px',
        lineHeight: 1.3,
      } as React.CSSProperties,
      body: {
        fontSize: '15px',
        color: colors.textSecondary,
        lineHeight: 1.6,
        marginBottom: '24px',
      } as React.CSSProperties,
      primaryBtn: {
        padding: '10px 24px',
        backgroundColor: colors.primary,
        color: colors.primaryText,
        border: 'none',
        borderRadius: shape.borderRadius,
        fontWeight: 600,
        fontSize: typography.fontSize,
        cursor: 'pointer',
      } as React.CSSProperties,
      secondaryBtn: {
        padding: '10px 24px',
        backgroundColor: 'transparent',
        color: colors.textSecondary,
        border: `1px solid ${colors.surfaceBorder}`,
        borderRadius: shape.borderRadius,
        fontWeight: 500,
        fontSize: typography.fontSize,
        cursor: 'pointer',
      } as React.CSSProperties,
    };
  }, [theme]);

  if (!visible || dismissed) return null;

  return (
    <div
      style={themedStyles.overlay}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label={typeof content.header === 'string' ? content.header : 'Placement'}
      data-rt-placement="modal"
    >
      <div ref={dialogRef} className={className} style={{ ...themedStyles.dialog, ...style }} tabIndex={-1}>
        {modalType === 'optional' && (
          <button
            type="button"
            style={themedStyles.close}
            onClick={handleDismissInternal}
            aria-label="Close"
          >
            ×
          </button>
        )}

        {content.image_url && (
          <img src={content.image_url} alt="" style={themedStyles.image} />
        )}

        {content.header && <div style={themedStyles.header}>{content.header}</div>}
        {content.body && <div style={themedStyles.body}>{content.body}</div>}

        <div style={actionsStyle}>
          {content.secondary_cta_label && onSecondaryCtaClick && (
            <button type="button" style={themedStyles.secondaryBtn} onClick={onSecondaryCtaClick}>
              {content.secondary_cta_label}
            </button>
          )}
          {content.cta_label && (
            <button type="button" style={themedStyles.primaryBtn} onClick={onCtaClick}>
              {content.cta_label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

ModalSlot.displayName = 'ModalSlot';
