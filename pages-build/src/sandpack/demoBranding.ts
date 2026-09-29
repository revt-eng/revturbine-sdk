/**
 * The demo app's branding, passed to the SDK as its `branding` option.
 *
 * Branding is a display concern owned by the app, not Playbook strategy, so it
 * lives here rather than in the demo Playbook (the Playbook's `theme` field is
 * deprecated — BL-0401). Every docs example and the playground's rendered
 * output share it, so a placement looks the same wherever it is shown.
 *
 * Plain object on purpose: this file is also mounted into the Sandpack sandbox,
 * so it avoids type-only syntax. The host playground passes it to
 * `RevTurbineProvider`, where the SDK's `branding` option type checks it.
 */
export const demoBranding = {
  theme: {
    colors: {
      primary: '#6C5CE7',
      primaryText: '#FFFFFF',
      accent: '#00B894',
      accentText: '#FFFFFF',
      surface: '#FFFFFF',
      surfaceBorder: '#E6E8EC',
      text: '#212121',
      textSecondary: '#616161',
    },
    typography: {
      fontFamily: 'Inter, sans-serif',
      fontSize: '14px',
      fontSizeSmall: '12px',
      fontSizeHeader: '20px',
    },
    shape: {
      borderRadius: '8px',
      borderRadiusSmall: '6px',
      borderRadiusLarge: '12px',
    },
  },
};
