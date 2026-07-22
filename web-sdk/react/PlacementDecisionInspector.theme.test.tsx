import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlacementDecisionInspector } from './PlacementDecisionInspector';
import { RevTurbineThemeProvider } from '../theme/ThemeContext';
import { DEFAULT_THEME, mergeTheme } from '../theme/defaults';

/**
 * The inspector used to hardcode a light palette in its inline styles, so it
 * rendered as a white card inside dark hosts (the docs playground being the
 * case that surfaced it). It now reads the same theme tokens every other
 * placement component does. These tests pin that: swapping the theme must move
 * the rendered colours, and the default theme must keep the old light look.
 *
 * `renderToStaticMarkup` is enough here — the themed card wrapper renders
 * without an SDK session, which is what we assert on.
 */
const DARK = mergeTheme({
  colors: {
    ...DEFAULT_THEME.colors,
    background: '#0f172a',
    surface: '#1e293b',
    surfaceBorder: '#334155',
    text: '#e2e8f0',
    textSecondary: '#cbd5e1',
    textMuted: '#94a3b8',
  },
});

function markup(theme = DEFAULT_THEME) {
  return renderToStaticMarkup(
    <RevTurbineThemeProvider theme={theme}>
      <PlacementDecisionInspector autoLoad={false} />
    </RevTurbineThemeProvider>,
  );
}

describe('PlacementDecisionInspector theming', () => {
  it('paints its card from the theme rather than a hardcoded palette', () => {
    const html = markup(DARK);
    expect(html).toContain('background:#0f172a');
    expect(html).toContain('color:#e2e8f0');
    expect(html).toContain('1px solid #334155');
  });

  it('keeps the light default for consumers who never set a theme', () => {
    const html = markup();
    expect(html).toContain(`background:${DEFAULT_THEME.colors.background}`);
    expect(html).toContain(`color:${DEFAULT_THEME.colors.text}`);
  });

  it('leaves no light-palette literal behind when themed dark', () => {
    const html = markup(DARK);
    // The exact hexes the component used to inline. If one reappears, a new
    // hardcoded colour has crept in and dark hosts will show a light patch.
    for (const stale of ['#ffffff', '#64748b', '#475569', '#f8fafc', '#f0fdf4']) {
      expect(html, `stale hardcoded colour ${stale} present`).not.toContain(stale);
    }
  });

  it('still lets the style prop win over theme colours', () => {
    const html = renderToStaticMarkup(
      <RevTurbineThemeProvider theme={DARK}>
        <PlacementDecisionInspector autoLoad={false} style={{ background: 'rebeccapurple' }} />
      </RevTurbineThemeProvider>,
    );
    expect(html).toContain('background:rebeccapurple');
  });
});
