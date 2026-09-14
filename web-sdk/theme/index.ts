// Theme system
export type {
  RevTurbineTheme,
  RevTurbineThemeInput,
  RevTurbineThemeColors,
  RevTurbineThemeTypography,
  RevTurbineThemeShape,
  RevTurbineThemeShadows,
} from './types';

export {
  DEFAULT_THEME,
  DARK_THEME,
  baseThemeForScheme,
  mergeTheme,
} from './defaults';
export type { RevTurbineColorScheme } from './defaults';
export { useResolvedColorScheme } from './useColorScheme';
export { loadTheme, clearPersistedTheme } from './theme-loader';
export type { ThemeLoaderOptions } from './theme-loader';
export {
  RevTurbineThemeProvider,
  useRevTurbineTheme,
  useRevTurbineThemeProviderPresent,
} from './ThemeContext';
