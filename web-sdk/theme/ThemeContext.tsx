import React, { createContext, useContext } from 'react';
import type { RevTurbineTheme } from './types';
import { DEFAULT_THEME } from './defaults';

const ThemeContext = createContext<RevTurbineTheme>(DEFAULT_THEME);

export interface RevTurbineThemeProviderProps {
  theme: RevTurbineTheme;
  children: React.ReactNode;
}

/**
 * Provides the active {@link RevTurbineTheme} to all child SDK components.
 * Typically rendered internally by {@link RevTurbineProvider} — consumers
 * don't need to add this manually.
 */
export function RevTurbineThemeProvider({ theme, children }: RevTurbineThemeProviderProps) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

/**
 * Access the current SDK theme tokens from any component inside a
 * {@link RevTurbineProvider} tree.
 */
export function useRevTurbineTheme(): RevTurbineTheme {
  return useContext(ThemeContext);
}
