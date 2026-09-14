import React, { createContext, useContext, useMemo } from 'react';
import type { RevTurbineTheme, RevTurbineThemeInput } from './types';
import { DEFAULT_THEME, mergeTheme } from './defaults';

const ThemeContext = createContext<RevTurbineTheme>(DEFAULT_THEME);

/**
 * Marks that a {@link RevTurbineThemeProvider} is mounted above this point.
 *
 * React context can report the current theme but not whether anyone actually
 * supplied one — the default value is indistinguishable from a real provider
 * passing the same theme. `RevTurbineProvider` needs that distinction to honour
 * an app-mounted provider instead of overriding it (plan 233 TASK-5), so
 * presence is tracked separately from value.
 */
const ThemeProviderPresentContext = createContext(false);

/**
 * Whether a {@link RevTurbineThemeProvider} is already mounted above the caller.
 *
 * Used by {@link RevTurbineProvider} to decide whether to mount its own. Exposed
 * so an app can make the same check — e.g. a design-system wrapper that only
 * supplies a theme when nothing upstream has.
 *
 * @returns `true` when an ancestor mounted a theme provider.
 * @public
 */
export function useRevTurbineThemeProviderPresent(): boolean {
  return useContext(ThemeProviderPresentContext);
}

export interface RevTurbineThemeProviderProps {
  /**
   * Theme tokens. A **partial** theme is fine — every token you omit falls back
   * to {@link DEFAULT_THEME}, so `{ colors: { primary: '#f00' } }` is a complete,
   * valid value (plan 233 TASK-4).
   */
  theme: RevTurbineThemeInput;
  children: React.ReactNode;
}

/**
 * Provides the active {@link RevTurbineTheme} to all child SDK components.
 * Typically rendered internally by {@link RevTurbineProvider} — consumers
 * don't need to add this manually.
 *
 * The theme is merged over {@link DEFAULT_THEME} here, so
 * {@link useRevTurbineTheme} always returns a complete theme.
 *
 * That merge used to be the caller's job while the prop was typed as a complete
 * `RevTurbineTheme`, which made a partial theme a runtime crash rather than a
 * type error: components read `theme.typography.fontSize` and got `undefined`
 * on a theme that only set colors. `RevTurbineThemeInput` has always documented
 * itself as "all values are optional — the SDK deep-merges with defaults"; this
 * is the component honouring that.
 */
export function RevTurbineThemeProvider({ theme, children }: RevTurbineThemeProviderProps) {
  // Keyed on the caller's object identity: a stable theme merges once, and an
  // inline literal re-merges per render exactly as it would re-render anyway.
  const resolved = useMemo(() => mergeTheme(theme), [theme]);
  return (
    <ThemeProviderPresentContext.Provider value={true}>
      <ThemeContext.Provider value={resolved}>{children}</ThemeContext.Provider>
    </ThemeProviderPresentContext.Provider>
  );
}

/**
 * Access the current SDK theme tokens from any component inside a
 * {@link RevTurbineProvider} tree.
 */
export function useRevTurbineTheme(): RevTurbineTheme {
  return useContext(ThemeContext);
}
