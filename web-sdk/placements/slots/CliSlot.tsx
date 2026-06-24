import type { CSSProperties } from 'react';
import type { PlacementSlotProps } from '../types';

/**
 * Props for {@link CliSlot}.
 * Uses the standard {@link PlacementSlotProps} without extensions.
 */
export type CliSlotProps = PlacementSlotProps;

const containerStyle: CSSProperties = {
  backgroundColor: '#1e1e1e',
  color: '#d4d4d4',
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  fontSize: '13px',
  lineHeight: 1.6,
  padding: '16px 20px',
  borderRadius: '6px',
  boxSizing: 'border-box',
};

const messageStyle: CSSProperties = {
  whiteSpace: 'pre-wrap',
  marginBottom: '12px',
};

const linksStyle: CSSProperties = {
  display: 'flex',
  gap: '16px',
};

const linkStyle: CSSProperties = {
  color: '#569cd6',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  padding: 0,
  textDecoration: 'underline',
};

export function CliSlot({
  content,
  onCtaClick,
  visible,
  className,
  style,
}: CliSlotProps) {
  if (!visible) return null;

  const message = content.message || content.body || '';
  const actionLinks = content.action_links;
  const links: string[] = Array.isArray(actionLinks)
    ? actionLinks.filter((v): v is string => typeof v === 'string')
    : [];

  return (
    <div
      className={className}
      style={{ ...containerStyle, ...style }}
      data-rt-placement="cli"
    >
      {message && <div style={messageStyle}>{message}</div>}
      {(links.length > 0 || content.cta_label) && (
        <div style={linksStyle}>
          {content.cta_label && (
            <button type="button" style={linkStyle} onClick={onCtaClick}>
              {content.cta_label}
            </button>
          )}
          {links.map((link) => (
            <button key={link} type="button" style={linkStyle} onClick={onCtaClick}>
              {link}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

CliSlot.displayName = 'CliSlot';
