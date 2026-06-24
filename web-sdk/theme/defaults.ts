import type { RevTurbineTheme, RevTurbineThemeInput } from './types';

/**
 * Default theme tokens — matches the original hardcoded styles across all
 * built-in placement components. Serves as the fallback when no custom
 * theme is configured or the theme API is unreachable.
 */
export const DEFAULT_THEME: Readonly<RevTurbineTheme> = Object.freeze({
  colors: {
    primary: '#1e40af',
    primaryText: '#ffffff',
    secondary: '#f3f4f6',
    secondaryText: '#1f2937',
    accent: '#7c3aed',
    accentText: '#ffffff',
    background: '#ffffff',
    surface: '#f8fafc',
    surfaceBorder: '#e2e8f0',
    text: '#111827',
    textSecondary: '#4b5563',
    textMuted: '#6b7280',
    overlay: 'rgba(0, 0, 0, 0.5)',
    success: '#16a34a',
    warning: '#f59e0b',
    danger: '#dc2626',
    info: '#60a5fa',
    toastBackground: '#1f2937',
    toastText: '#ffffff',
    cliBackground: '#1e1e1e',
    cliText: '#d4d4d4',
    cliLink: '#569cd6',
    track: '#e5e7eb',
  },
  typography: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontFamilyMono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '14px',
    fontSizeSmall: '13px',
    fontSizeHeader: '20px',
    fontSizeLargeHeader: '28px',
  },
  shape: {
    borderRadiusSmall: '6px',
    borderRadius: '8px',
    borderRadiusLarge: '12px',
  },
  shadows: {
    medium: '0 10px 40px rgba(0, 0, 0, 0.25)',
    large: '0 20px 60px rgba(0, 0, 0, 0.3)',
  },
});

/**
 * Deep-merge a partial theme input with the default theme, producing a
 * complete {@link RevTurbineTheme}.
 */
export function mergeTheme(input?: RevTurbineThemeInput | null): RevTurbineTheme {
  if (!input) return { ...DEFAULT_THEME };

  return {
    id: input.id ?? DEFAULT_THEME.id,
    name: input.name ?? DEFAULT_THEME.name,
    version: input.version ?? DEFAULT_THEME.version,
    colors: { ...DEFAULT_THEME.colors, ...input.colors },
    typography: { ...DEFAULT_THEME.typography, ...input.typography },
    shape: { ...DEFAULT_THEME.shape, ...input.shape },
    shadows: { ...DEFAULT_THEME.shadows, ...input.shadows },
  };
}
