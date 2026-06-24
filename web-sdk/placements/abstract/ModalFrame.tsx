import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlacementSlotProps, ResolvedContent } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

/**
 * Modal layout variants:
 * - `centered` — single column, centered content (default, existing behavior)
 * - `two_column` — left content + right visual panel (paywall/trial style)
 */
export type ModalLayout = 'centered' | 'two_column';

export interface ModalFrameProps<C extends ResolvedContent = ResolvedContent>
  extends PlacementSlotProps<C> {
  /**
   * Modal dismissibility behavior.
   * - `optional` — user can dismiss via ESC, close button, or clicking outside
   * - `blocking` — user must interact with a CTA (no dismiss controls)
   */
  modalType?: 'optional' | 'blocking';
  /**
   * Visual layout variant.
   * - `centered` — classic single-column modal (default)
   * - `two_column` — left content + right side panel with image/gradient
   */
  layout?: ModalLayout;
  /** Accent color for CTA buttons and decorative elements. */
  accentColor?: string;
  /** Accent background color (e.g. badge backgrounds, light tints). */
  accentBg?: string;
  /** Dialog width override. Defaults to 480px (centered) or 1024px (two_column). */
  dialogWidth?: number | string;
  /** Dialog height override. Only applied in two_column layout. Defaults to 600px. */
  dialogHeight?: number | string;
  /** Badge element rendered above the title (e.g. icon + label). */
  badge?: React.ReactNode;
  /** Side content for two_column layout (rendered in the right panel). */
  sideContent?: React.ReactNode;
  /** Side panel width for two_column layout. Defaults to 420px. */
  sidePanelWidth?: number;
  /** Override the primary CTA label (defaults to `content.cta_label`). */
  ctaLabel?: string;
  /** Override the secondary CTA label (defaults to `content.secondary_cta_label`). */
  secondaryCtaLabel?: string;
  /** Custom body to replace the default text body. */
  children?: React.ReactNode;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

/**
 * Modal overlay component that handles:
 * - Backdrop click dismiss (optional mode)
 * - ESC key dismiss (optional mode)
 * - Focus trap on the dialog
 * - Visibility + dismissed state management
 * - Theme-aware default styles
 *
 * Extend by wrapping and injecting `children` for custom body content.
 *
 * @example
 * ```tsx
 * function MyModal(props: PlacementSlotProps<MyContent>) {
 *   return (
 *     <ModalFrame {...props}>
 *       <BenefitsList items={props.content.benefits} />
 *     </ModalFrame>
 *   );
 * }
 * ```
 */
export function ModalFrame<C extends ResolvedContent = ResolvedContent>({
  content,
  onCtaClick,
  onSecondaryCtaClick,
  onDismiss,
  visible,
  className,
  style,
  modalType: modalTypeProp,
  layout: layoutProp,
  accentColor,
  accentBg,
  dialogWidth,
  dialogHeight,
  badge,
  sideContent,
  sidePanelWidth = 420,
  ctaLabel,
  secondaryCtaLabel,
  children,
}: ModalFrameProps<C>) {
  const theme = useRevTurbineTheme();
  const dialogRef = useRef<HTMLDivElement>(null);
  const resolvedModalType = modalTypeProp ?? (content.style as 'optional' | 'blocking') ?? 'optional';
  const layout = layoutProp ?? 'centered';
  const [dismissed, setDismissed] = useState(false);
  const prevVisibleRef = useRef(visible);

  useEffect(() => {
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
      if (resolvedModalType === 'optional' && e.target === e.currentTarget) {
        handleDismissInternal();
      }
    },
    [resolvedModalType, handleDismissInternal],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && resolvedModalType === 'optional') {
        handleDismissInternal();
      }
    },
    [resolvedModalType, handleDismissInternal],
  );

  useEffect(() => {
    if (!visible) return;
    document.addEventListener('keydown', handleKeyDown);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [visible, handleKeyDown]);

  const resolvedAccentColor = accentColor ?? theme.colors.primary;
  const resolvedAccentBg = accentBg ?? theme.colors.secondary;

  const themedStyles = useMemo(() => {
    const { colors, typography, shape, shadows } = theme;

    const isTwoColumn = layout === 'two_column';
    const defaultWidth = isTwoColumn ? '1024px' : '480px';
    const resolvedWidth = dialogWidth != null
      ? (typeof dialogWidth === 'number' ? `${dialogWidth}px` : dialogWidth)
      : defaultWidth;
    const resolvedHeight = isTwoColumn
      ? (dialogHeight != null
          ? (typeof dialogHeight === 'number' ? `${dialogHeight}px` : dialogHeight)
          : '600px')
      : undefined;

    return {
      overlay: {
        position: 'fixed' as const,
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        backgroundColor: colors.overlay,
        fontFamily: typography.fontFamily,
      },
      dialog: {
        position: 'relative' as const,
        maxWidth: resolvedWidth,
        width: isTwoColumn ? resolvedWidth : '90%',
        height: resolvedHeight,
        backgroundColor: colors.background,
        borderRadius: shape.borderRadiusLarge,
        boxShadow: shadows.large,
        padding: isTwoColumn ? 0 : '32px',
        boxSizing: 'border-box' as const,
        display: isTwoColumn ? 'flex' : undefined,
        overflow: isTwoColumn ? 'hidden' : undefined,
      },
      leftColumn: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column' as const,
        justifyContent: 'center',
        padding: '32px',
        gap: '24px',
      },
      sidePanel: {
        width: sidePanelWidth,
        flexShrink: 0,
        position: 'relative' as const,
        overflow: 'hidden',
        backgroundColor: colors.surface,
      },
      close: {
        position: 'absolute' as const,
        top: '12px',
        right: '12px',
        background: isTwoColumn ? 'rgba(255,255,255,0.8)' : 'transparent',
        border: 'none',
        fontSize: '20px',
        color: colors.textMuted,
        cursor: 'pointer',
        padding: '4px 8px',
        lineHeight: 1,
        borderRadius: isTwoColumn ? shape.borderRadiusSmall : undefined,
        zIndex: 1,
      },
      image: {
        width: '100%',
        maxHeight: '200px',
        objectFit: 'cover' as const,
        marginBottom: '16px',
        borderRadius: shape.borderRadius,
      },
      header: {
        fontSize: typography.fontSizeHeader,
        fontWeight: 700,
        color: colors.text,
        marginBottom: '8px',
        lineHeight: 1.3,
      },
      body: {
        fontSize: '15px',
        color: colors.textSecondary,
        lineHeight: 1.6,
        marginBottom: '24px',
      },
      primaryBtn: {
        padding: '10px 24px',
        backgroundColor: resolvedAccentColor,
        color: colors.primaryText,
        border: 'none',
        borderRadius: shape.borderRadius,
        fontWeight: 600,
        fontSize: typography.fontSize,
        cursor: 'pointer',
      },
      secondaryBtn: {
        padding: '10px 24px',
        backgroundColor: 'transparent',
        color: colors.textSecondary,
        border: `1px solid ${colors.surfaceBorder}`,
        borderRadius: shape.borderRadius,
        fontWeight: 500,
        fontSize: typography.fontSize,
        cursor: 'pointer',
      },
    };
  }, [theme, layout, dialogWidth, dialogHeight, sidePanelWidth, resolvedAccentColor]);

  if (!visible || dismissed) return null;

  const resolvedCtaLabel = ctaLabel ?? content.cta_label;
  const resolvedSecondaryLabel = secondaryCtaLabel ?? content.secondary_cta_label;

  const ctaRow = (
    <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
      {resolvedCtaLabel && (
        <button type="button" style={themedStyles.primaryBtn} onClick={onCtaClick}>
          {resolvedCtaLabel}
        </button>
      )}
      {resolvedSecondaryLabel && onSecondaryCtaClick && (
        <button type="button" style={themedStyles.secondaryBtn} onClick={onSecondaryCtaClick}>
          {resolvedSecondaryLabel}
        </button>
      )}
    </div>
  );

  /* ----- Two-column layout ----- */
  if (layout === 'two_column') {
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
          {/* Left: content column */}
          <div style={themedStyles.leftColumn}>
            {badge}
            {content.header && <div style={themedStyles.header}>{content.header}</div>}
            {children ?? (
              content.body && <div style={themedStyles.body}>{content.body}</div>
            )}
            {ctaRow}
          </div>

          {/* Right: side panel */}
          <div style={themedStyles.sidePanel}>
            {sideContent ?? (
              content.image_url ? (
                <img
                  src={content.image_url}
                  alt=""
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: `linear-gradient(135deg, ${resolvedAccentBg} 0%, ${resolvedAccentColor}44 100%)`,
                  }}
                />
              )
            )}
          </div>

          {/* Close button */}
          {resolvedModalType === 'optional' && (
            <button
              type="button"
              style={themedStyles.close}
              onClick={handleDismissInternal}
              aria-label="Close"
            >
              ×
            </button>
          )}
        </div>
      </div>
    );
  }

  /* ----- Centered layout (default) ----- */
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
        {resolvedModalType === 'optional' && (
          <button
            type="button"
            style={themedStyles.close}
            onClick={handleDismissInternal}
            aria-label="Close"
          >
            ×
          </button>
        )}

        {badge}

        {content.image_url && (
          <img src={content.image_url} alt="" style={themedStyles.image} />
        )}

        {content.header && <div style={themedStyles.header}>{content.header}</div>}

        {children ?? (
          content.body && <div style={themedStyles.body}>{content.body}</div>
        )}

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          {resolvedSecondaryLabel && onSecondaryCtaClick && (
            <button type="button" style={themedStyles.secondaryBtn} onClick={onSecondaryCtaClick}>
              {resolvedSecondaryLabel}
            </button>
          )}
          {resolvedCtaLabel && (
            <button type="button" style={themedStyles.primaryBtn} onClick={onCtaClick}>
              {resolvedCtaLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

ModalFrame.displayName = 'ModalFrame';
