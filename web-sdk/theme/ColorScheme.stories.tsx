import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';
import { RevTurbineThemeProvider, useRevTurbineTheme } from './ThemeContext';
import { DARK_THEME, DEFAULT_THEME, mergeTheme } from './defaults';
import type { RevTurbineTheme } from './types';

/**
 * Renders the tokens a placement actually paints with, so a palette change is
 * visible rather than asserted.
 */
function Swatches() {
  const theme = useRevTurbineTheme();
  const pairs: Array<[string, string, string]> = [
    ['background', theme.colors.background, theme.colors.text],
    ['surface', theme.colors.surface, theme.colors.text],
    ['primary', theme.colors.primary, theme.colors.primaryText],
    ['accent', theme.colors.accent, theme.colors.accentText],
    ['danger', theme.colors.danger, theme.colors.primaryText],
    ['toast', theme.colors.toastBackground, theme.colors.toastText],
  ];

  return (
    <div
      style={{
        background: theme.colors.background,
        color: theme.colors.text,
        padding: 20,
        borderRadius: theme.shape.borderRadius,
        border: `1px solid ${theme.colors.surfaceBorder}`,
        fontFamily: theme.typography.fontFamily,
        fontSize: theme.typography.fontSize,
        display: 'grid',
        gap: 8,
      }}
    >
      {pairs.map(([label, bg, fg]) => (
        <div
          key={label}
          style={{
            background: bg,
            color: fg,
            padding: '10px 12px',
            borderRadius: theme.shape.borderRadiusSmall,
          }}
        >
          {label} — {bg}
        </div>
      ))}
    </div>
  );
}

function SchemePreview({ theme }: { theme: RevTurbineTheme }) {
  return (
    <RevTurbineThemeProvider theme={theme}>
      <Swatches />
    </RevTurbineThemeProvider>
  );
}

const meta = {
  title: 'SDK/Theme/ColorScheme',
  component: SchemePreview,
  parameters: {
    docs: {
      description: {
        component:
          'Light and dark base palettes (plan 233 TASK-6). In an app, set the scheme with '
          + '`<RevTurbineProvider colorScheme="dark">` — it defaults to `"system"` and follows '
          + '`prefers-color-scheme`. Changing it repaints placements without re-initializing the SDK.',
      },
    },
  },
} satisfies Meta<typeof SchemePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Light: Story = {
  args: { theme: DEFAULT_THEME },
};

export const Dark: Story = {
  args: { theme: DARK_THEME },
};

/** A brand token survives the scheme: the palette supplies everything else. */
export const DarkWithBrandPrimary: Story = {
  args: { theme: mergeTheme({ colors: { primary: '#ff7a18' } }, DARK_THEME) },
};

/** The same brand token against the light palette, for comparison. */
export const LightWithBrandPrimary: Story = {
  args: { theme: mergeTheme({ colors: { primary: '#ff7a18' } }, DEFAULT_THEME) },
};

/** A partial theme is valid — omitted tokens fall back to the base (TASK-4). */
export const PartialThemeOverDark: Story = {
  args: { theme: mergeTheme({ colors: { surface: '#1b2540' } }, DARK_THEME) },
};
