import type { RevTurbineConfig } from '@revt-eng/schema';
import { RevTurbineConfigSchema } from '@revt-eng/schema/zod';
import prismExportConfigJson from './prism-export-config.json';

/**
 * The bundled "Prism" demo configuration — a synthetic AI image-studio
 * {@link RevTurbineConfig} the playground drives the SDK against in local-runtime
 * mode.
 *
 * `prism-export-config.json` is authored directly in this repo (plan 105) — it
 * keeps the playground self-contained with no cross-package dependency and is no
 * longer synced from revturbine-demo-data. It is re-parsed through
 * `RevTurbineConfigSchema` here so the playground fails loud if an edit ever
 * drifts from the schema; `pnpm typecheck:prism-config` enforces the same at
 * build time.
 */
/**
 * Brand theme handed to the SDK via `exportedConfig.theme`. The built-in slot
 * components read these tokens through `RevTurbineThemeProvider`, so nudges
 * render on-brand. Supplying a theme here is also load-bearing: without one the
 * provider falls back to fetching the theme from `endpoint` (a real control
 * plane), which a local demo has none of — so the SDK must get its theme from
 * the config. Kept in the playground (not the demo-data fixture) because it is
 * presentation, not monetization config. The palette mirrors styles/tokens.css.
 */
const PRISM_THEME: Record<string, unknown> = {
  colors: {
    primary: '#7c5cff',
    primaryText: '#ffffff',
    surface: '#171a22',
    surfaceText: '#e8ebf2',
    muted: '#8b93a7',
    warning: '#f5a623',
    danger: '#ff5c7c',
    success: '#29d3c2',
    overlay: 'rgba(10, 12, 18, 0.6)',
  },
  shape: { radius: 12 },
};

export const PRISM_CONFIG: RevTurbineConfig = {
  ...RevTurbineConfigSchema.parse(prismExportConfigJson),
  theme: PRISM_THEME,
};

/**
 * Placement ids whose payload carries an *explicitly authored* recommendation
 * strategy. Read from the RAW JSON on purpose: `RevTurbineConfigSchema` applies a
 * `recommendation_strategy` default to every payload, so the parsed config can't
 * tell an authored recommendation from the default — the raw bundle can. The
 * playground only surfaces a recommended plan for placements in this set.
 */
export const RECOMMENDATION_PLACEMENT_IDS: ReadonlySet<string> = new Set(
  (Array.isArray(prismExportConfigJson.placements) ? prismExportConfigJson.placements : [])
    .filter((p) => {
      const payload = p?.payloads?.[0];
      return payload != null && 'recommendation_strategy' in payload;
    })
    .map((p) => p.id),
);
