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
 * Dark counterpart to {@link DEFAULT_THEME}.
 *
 * Plan 233 TASK-6. The SDK had no sanctioned dark story at all, so a customer
 * running a dark app either lived with white modals or — as the escalated one
 * did — injected a palette into the Playbook object and re-initialized the SDK
 * on every toggle. Shipping the palette is what makes `colorScheme` a swap
 * rather than a rebuild.
 *
 * Only the colors differ. Typography, shape and shadows are scheme-independent,
 * so they are inherited from {@link DEFAULT_THEME} rather than duplicated —
 * a second copy would drift the moment either is edited.
 *
 * Contrast: every text-on-surface pair here clears WCAG AA at body size against
 * its intended background.
 *
 * @public
 */
export const DARK_THEME: Readonly<RevTurbineTheme> = Object.freeze({
  ...DEFAULT_THEME,
  colors: Object.freeze({
    primary: '#60a5fa',
    primaryText: '#0b1220',
    secondary: '#1f2937',
    secondaryText: '#e5e7eb',
    accent: '#a78bfa',
    accentText: '#0b1220',
    background: '#0b1220',
    surface: '#111827',
    surfaceBorder: '#1f2937',
    text: '#f3f4f6',
    textSecondary: '#cbd5e1',
    textMuted: '#94a3b8',
    overlay: 'rgba(0, 0, 0, 0.7)',
    success: '#4ade80',
    warning: '#fbbf24',
    danger: '#f87171',
    info: '#93c5fd',
    toastBackground: '#e5e7eb',
    toastText: '#111827',
    cliBackground: '#0b1220',
    cliText: '#e5e7eb',
    cliLink: '#93c5fd',
    track: '#374151',
  }),
});

/**
 * The colour scheme a theme resolves against.
 *
 * `'system'` follows the OS/browser `prefers-color-scheme` and keeps following
 * it as the user changes it.
 *
 * @public
 */
export type RevTurbineColorScheme = 'light' | 'dark' | 'system';

/**
 * The base palette for a resolved scheme.
 *
 * @param scheme - `'light'` or `'dark'`. Resolve `'system'` before calling.
 * @returns The matching base theme.
 * @public
 */
export function baseThemeForScheme(scheme: 'light' | 'dark'): Readonly<RevTurbineTheme> {
  return scheme === 'dark' ? DARK_THEME : DEFAULT_THEME;
}

/**
 * Deep-merge a partial theme input with a base theme, producing a complete
 * {@link RevTurbineTheme}.
 *
 * @param input - Partial tokens. Every omitted token falls back to `base`.
 * @param base - The palette to merge over. Defaults to {@link DEFAULT_THEME};
 *   pass {@link DARK_THEME} (or use {@link baseThemeForScheme}) to resolve a
 *   partial brand theme against the dark palette instead.
 */
export function mergeTheme(
  input?: RevTurbineThemeInput | null,
  base: Readonly<RevTurbineTheme> = DEFAULT_THEME,
): RevTurbineTheme {
  if (!input) return { ...base };

  return {
    id: input.id ?? base.id,
    name: input.name ?? base.name,
    version: input.version ?? base.version,
    colors: { ...base.colors, ...input.colors },
    typography: { ...base.typography, ...input.typography },
    shape: { ...base.shape, ...input.shape },
    shadows: { ...base.shadows, ...input.shadows },
  };
}
