'use client';

import type { CSSProperties } from 'react';
import type { PlacementSlotProps } from './types';
import { useRevTurbineTheme } from '../theme/ThemeContext';

/** Shared CTA layout with authored indices preserved when emphasis changes display order. */
export function CtaActions({ ctas, onCtaClickIndex }: Pick<PlacementSlotProps, 'ctas' | 'onCtaClickIndex'>) {
  const { colors, shape, typography } = useRevTurbineTheme();
  if (!ctas) return null;
  const entries = ctas.map((cta, index) => ({ cta, index }));
  const buttons = entries.filter(({ cta }) => cta.emphasis !== 'link')
    .sort((a, b) => Number(b.cta.emphasis === 'primary') - Number(a.cta.emphasis === 'primary'));
  const links = entries.filter(({ cta }) => cta.emphasis === 'link');
  const renderAction = ({ cta, index }: typeof entries[number]) => {
    const primary = cta.emphasis === 'primary';
    const link = cta.emphasis === 'link';
    const style: CSSProperties = {
      padding: link ? '4px 0' : '10px 20px', cursor: 'pointer',
      fontFamily: typography.fontFamily, fontSize: typography.fontSize,
      borderRadius: shape.borderRadius,
      border: primary || link ? 'none' : `1px solid ${colors.surfaceBorder}`,
      background: primary ? colors.primary : 'transparent',
      color: primary ? colors.primaryText : colors.textSecondary,
      textDecoration: link ? 'underline' : undefined,
      fontWeight: primary ? 600 : 500,
    };
    return <button key={index} type="button" style={style}
      data-rt-role={cta.role} data-rt-emphasis={cta.emphasis} data-rt-cta-index={index}
      onClick={() => onCtaClickIndex?.(index)}>{cta.label}</button>;
  };
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '100%' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', flexDirection: buttons.length >= 3 ? 'column' : 'row', gap: 12 }}>
      {buttons.map(renderAction)}
    </div>
    {links.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
      {links.map(renderAction)}
    </div>}
  </div>;
}
