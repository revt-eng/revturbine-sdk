import React, { useMemo } from 'react';
import type { PlacementSlotProps } from '../types';
import { useRevTurbineTheme } from '../../theme/ThemeContext';

/**
 * Static channel-preview slots for the `email`, `sms`, and `push` surface
 * types (plan 76 TASK-15).
 *
 * These surface types are delivered out-of-band (an email service, an SMS
 * gateway, a push provider) — there is no live in-product DOM to render the
 * way `banner`/`modal`/`in_page` have. Before this, no slot type was
 * registered for them, so {@link PlacementRenderer} resolved to `undefined`
 * and rendered its `null` fallback — a **silent no-op** in any preview/gallery
 * that drove rendering through the registry (AC-11).
 *
 * Each slot renders a lightweight static mock of the channel, mirroring the
 * Optimization Studio's web `ChannelMock` (plan 76 TASK-14) for parity, and
 * surfaces the placement's CTAs **in order** — the primary (`cta_label`)
 * before the secondary (`secondary_cta_label`), honoring the
 * first-CTA-is-primary convention (AC-12). The CTA controls stay wired to the
 * standard `onCtaClick` / `onSecondaryCtaClick` callbacks so a preview harness
 * can exercise them.
 */

const str = (value: unknown, fallback = ''): string => // sdk-ok: boundary-parse
  value == null || value === '' ? fallback : String(value);

/** A CTA to render in a channel preview, tagged by role. */
export interface ChannelCta {
  kind: 'primary' | 'secondary';
  label: string;
}

/**
 * The channel preview's CTAs in render order: the primary (`cta_label`) before
 * the secondary (`secondary_cta_label`), honoring the first-CTA-is-primary
 * convention (plan 76 AC-12). Absent labels are dropped, so this returns 0, 1,
 * or 2 entries. Pure — the slots and tests both consume it.
 */
export function orderedChannelCtas(content: {
  cta_label?: string;
  secondary_cta_label?: string;
}): ChannelCta[] {
  const ctas: ChannelCta[] = [];
  if (content.cta_label) ctas.push({ kind: 'primary', label: content.cta_label });
  if (content.secondary_cta_label) {
    ctas.push({ kind: 'secondary', label: content.secondary_cta_label });
  }
  return ctas;
}

const labelStyle: React.CSSProperties = {
  fontSize: '10px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#94a3b8', // slate-400
};

/**
 * Primary-then-secondary CTA row shared by the channel previews. Renders
 * nothing when neither CTA label is present. Primary is emphasized with the
 * theme accent; order is always primary first (AC-12).
 */
function ChannelCtaRow({
  content,
  onCtaClick,
  onSecondaryCtaClick,
  accent,
  accentText,
}: Pick<PlacementSlotProps, 'content' | 'onCtaClick' | 'onSecondaryCtaClick'> & {
  accent: string;
  accentText: string;
}) {
  const ctas = orderedChannelCtas(content);
  if (ctas.length === 0) return null;

  const baseBtn: React.CSSProperties = {
    padding: '5px 12px',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  return (
    <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
      {ctas.map((cta) =>
        cta.kind === 'primary' ? (
          <button
            key="primary"
            type="button"
            data-rt-cta="primary"
            onClick={onCtaClick}
            style={{ ...baseBtn, backgroundColor: accent, color: accentText, border: 'none' }}
          >
            {cta.label}
          </button>
        ) : (
          onSecondaryCtaClick && (
            <button
              key="secondary"
              type="button"
              data-rt-cta="secondary"
              onClick={onSecondaryCtaClick}
              style={{
                ...baseBtn,
                backgroundColor: 'transparent',
                color: accent,
                border: `1px solid ${accent}`,
              }}
            >
              {cta.label}
            </button>
          )
        ),
      )}
    </div>
  );
}

function useAccent() {
  const theme = useRevTurbineTheme();
  return useMemo(
    () => ({ accent: theme.colors.primary, accentText: theme.colors.primaryText }),
    [theme],
  );
}

/**
 * Static email preview: envelope card with a subject header and body, plus the
 * CTA row.
 *
 * **Content fields used:** `subject`, `body`, `cta_label`, `secondary_cta_label`
 */
export function EmailPreviewSlot({
  content,
  onCtaClick,
  onSecondaryCtaClick,
  visible,
  className,
  style,
}: PlacementSlotProps) {
  const { accent, accentText } = useAccent();
  if (!visible) return null;

  return (
    <div
      className={className}
      data-rt-placement="email"
      style={{
        borderRadius: '8px',
        border: '1px solid #e2e8f0',
        backgroundColor: '#ffffff',
        ...style,
      }}
    >
      <div style={{ borderBottom: '1px solid #f1f5f9', padding: '8px 12px' }}>
        <p style={{ ...labelStyle, margin: 0 }}>Email preview</p>
        <p style={{ margin: '2px 0 0', fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>
          {str(content.subject, '(no subject)')}
        </p>
      </div>
      <div
        style={{
          padding: '8px 12px',
          fontSize: '12px',
          color: '#475569',
          whiteSpace: 'pre-wrap',
        }}
      >
        {str(content.body, '(empty body)')}
        <ChannelCtaRow
          content={content}
          onCtaClick={onCtaClick}
          onSecondaryCtaClick={onSecondaryCtaClick}
          accent={accent}
          accentText={accentText}
        />
      </div>
    </div>
  );
}
EmailPreviewSlot.displayName = 'EmailPreviewSlot';

/**
 * Static SMS preview: a chat bubble carrying the message body, plus the CTA
 * row (rendered below the bubble).
 *
 * **Content fields used:** `body`, `message`, `cta_label`, `secondary_cta_label`
 */
export function SmsPreviewSlot({
  content,
  onCtaClick,
  onSecondaryCtaClick,
  visible,
  className,
  style,
}: PlacementSlotProps) {
  const { accent, accentText } = useAccent();
  if (!visible) return null;

  return (
    <div
      className={className}
      data-rt-placement="sms"
      style={{
        borderRadius: '8px',
        border: '1px solid #e2e8f0',
        backgroundColor: '#f8fafc',
        padding: '12px',
        ...style,
      }}
    >
      <p style={{ ...labelStyle, margin: 0 }}>SMS preview</p>
      <div
        style={{
          display: 'inline-block',
          maxWidth: '85%',
          marginTop: '4px',
          borderRadius: '16px',
          backgroundColor: '#dcfce7', // green-100
          padding: '8px 12px',
          fontSize: '12px',
          color: '#1e293b',
        }}
      >
        {str(content.body ?? content.message, '(empty message)')}
      </div>
      <ChannelCtaRow
        content={content}
        onCtaClick={onCtaClick}
        onSecondaryCtaClick={onSecondaryCtaClick}
        accent={accent}
        accentText={accentText}
      />
    </div>
  );
}
SmsPreviewSlot.displayName = 'SmsPreviewSlot';

/**
 * Static push-notification preview: a notification card with a title and body,
 * plus the CTA row.
 *
 * **Content fields used:** `header`/`title`, `body`, `cta_label`, `secondary_cta_label`
 */
export function PushPreviewSlot({
  content,
  onCtaClick,
  onSecondaryCtaClick,
  visible,
  className,
  style,
}: PlacementSlotProps) {
  const { accent, accentText } = useAccent();
  if (!visible) return null;

  return (
    <div
      className={className}
      data-rt-placement="push"
      style={{
        borderRadius: '8px',
        border: '1px solid #e2e8f0',
        backgroundColor: '#ffffff',
        padding: '12px',
        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
        ...style,
      }}
    >
      <p style={{ ...labelStyle, margin: 0 }}>Push preview</p>
      <p style={{ margin: '4px 0 0', fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>
        {str(content.header ?? content.title, '(no title)')}
      </p>
      <p style={{ margin: 0, fontSize: '12px', color: '#475569' }}>
        {str(content.body, '(empty body)')}
      </p>
      <ChannelCtaRow
        content={content}
        onCtaClick={onCtaClick}
        onSecondaryCtaClick={onSecondaryCtaClick}
        accent={accent}
        accentText={accentText}
      />
    </div>
  );
}
PushPreviewSlot.displayName = 'PushPreviewSlot';
