/**
 * Theme token structure for RevTurbine SDK placement components.
 *
 * Customers can upload or configure a theme via the API. The SDK fetches
 * theme tokens on initialization and persists them locally for fast
 * subsequent loads.
 */

/** Color tokens used across all placement components. */
export interface RevTurbineThemeColors {
  /** Primary brand color (buttons, banners, progress fills). Default `#1e40af`. */
  primary: string;
  /** Text color on primary backgrounds. Default `#ffffff`. */
  primaryText: string;
  /** Secondary/surface background. Default `#f3f4f6`. */
  secondary: string;
  /** Text on secondary backgrounds. Default `#1f2937`. */
  secondaryText: string;
  /** Accent color (e.g. accent buttons). Default `#7c3aed`. */
  accent: string;
  /** Text on accent backgrounds. Default `#ffffff`. */
  accentText: string;
  /** Page/card background. Default `#ffffff`. */
  background: string;
  /** Surface/card background (e.g. inline embed). Default `#f8fafc`. */
  surface: string;
  /** Surface border color. Default `#e2e8f0`. */
  surfaceBorder: string;
  /** Primary text color. Default `#111827`. */
  text: string;
  /** Secondary text color. Default `#4b5563`. */
  textSecondary: string;
  /** Muted/hint text color. Default `#6b7280`. */
  textMuted: string;
  /** Overlay backdrop color. Default `rgba(0,0,0,0.5)`. */
  overlay: string;
  /** Success state color. Default `#16a34a`. */
  success: string;
  /** Warning state color (quota 70-90%). Default `#f59e0b`. */
  warning: string;
  /** Danger state color (quota >90%). Default `#dc2626`. */
  danger: string;
  /** Informational/link color. Default `#60a5fa`. */
  info: string;
  /** Toast/dark surface background. Default `#1f2937`. */
  toastBackground: string;
  /** Toast text color. Default `#ffffff`. */
  toastText: string;
  /** CLI terminal background. Default `#1e1e1e`. */
  cliBackground: string;
  /** CLI terminal text. Default `#d4d4d4`. */
  cliText: string;
  /** CLI link color. Default `#569cd6`. */
  cliLink: string;
  /** Track/unfilled bar background. Default `#e5e7eb`. */
  track: string;
}

/** Typography tokens. */
export interface RevTurbineThemeTypography {
  /** Base font family. Default `system-ui, -apple-system, sans-serif`. */
  fontFamily: string;
  /** Monospace font family for CLI. Default `ui-monospace, SFMono-Regular, ...`. */
  fontFamilyMono: string;
  /** Base font size. Default `14px`. */
  fontSize: string;
  /** Small font size (CTA buttons, labels). Default `13px`. */
  fontSizeSmall: string;
  /** Header font size. Default `20px`. */
  fontSizeHeader: string;
  /** Large header font size (full page). Default `28px`. */
  fontSizeLargeHeader: string;
}

/** Shape/radius tokens. */
export interface RevTurbineThemeShape {
  /** Small border radius. Default `6px`. */
  borderRadiusSmall: string;
  /** Default border radius. Default `8px`. */
  borderRadius: string;
  /** Large border radius (modal dialog). Default `12px`. */
  borderRadiusLarge: string;
}

/** Shadow tokens. */
export interface RevTurbineThemeShadows {
  /** Toast/floating element shadow. Default `0 10px 40px rgba(0,0,0,0.25)`. */
  medium: string;
  /** Modal dialog shadow. Default `0 20px 60px rgba(0,0,0,0.3)`. */
  large: string;
}

/**
 * Complete SDK theme definition.
 * All fields are optional when uploading — missing values fall back to defaults.
 */
export interface RevTurbineTheme {
  /** Theme identifier. */
  id?: string;
  /** Human-readable theme name. */
  name?: string;
  /** Monotonic version string for cache invalidation. */
  version?: string;
  /** Color tokens. */
  colors: RevTurbineThemeColors;
  /** Typography tokens. */
  typography: RevTurbineThemeTypography;
  /** Shape tokens. */
  shape: RevTurbineThemeShape;
  /** Shadow tokens. */
  shadows: RevTurbineThemeShadows;
}

/**
 * Partial theme for API responses and user uploads.
 * All values are optional — the SDK deep-merges with defaults.
 */
export type RevTurbineThemeInput = {
  id?: string;
  name?: string;
  version?: string;
  colors?: Partial<RevTurbineThemeColors>;
  typography?: Partial<RevTurbineThemeTypography>;
  shape?: Partial<RevTurbineThemeShape>;
  shadows?: Partial<RevTurbineThemeShadows>;
};
