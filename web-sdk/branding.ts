/**
 * Branding resolution for the RevTurbine SDK (plan 118 TASK-20).
 *
 * Branding — theme tokens, workspace name, logo, support email — is a **display**
 * concern, decoupled from the monetization Playbook. It is deliberately NOT an
 * evaluator input and never enters the compiled Bundle, so it has no effect on
 * placement decisions or entitlement checks and is not part of cross-language
 * parity.
 *
 * The SDK resolves branding down a four-rung ladder (highest priority wins), so
 * a customer can render fully with no branding passed at all:
 *
 *   1. **Explicit `branding` argument** — passed to the SDK at init.
 *   2. **Legacy config-embedded** — the deprecated `theme` field carried inside
 *      an older `RevTurbineConfig`/`Playbook`. Works, but warns in development.
 *   3. **Branding API** — branding fetched from the RevTurbine Branding API or a
 *      workspace-settings source and supplied by the host (`apiBranding`).
 *   4. **`DEFAULT_BRANDING`** — structural fallback so the SDK always renders.
 *
 * Each rung's (possibly partial) branding is merged over `DEFAULT_BRANDING`, so
 * the resolved result is always complete.
 */
import type { BrandingConfig } from './generated';

/**
 * Structural default branding. Neutral, brandless values that let the SDK render
 * completely when no branding is supplied at any rung of the ladder.
 *
 * @public
 */
export const DEFAULT_BRANDING: Required<Pick<BrandingConfig, 'workspace_name'>> &
  BrandingConfig = {
  workspace_name: 'Your workspace',
  theme: {},
};

/**
 * The rung of the branding ladder a resolved value came from. Returned alongside
 * the resolved branding so callers (and tests) can assert provenance and surface
 * the development deprecation warning for the legacy rung.
 *
 * @public
 */
export type BrandingSource = 'explicit' | 'legacy-config' | 'branding-api' | 'default';

/**
 * Inputs to {@link resolveBranding}. Every field is optional; with none supplied
 * the ladder resolves to {@link DEFAULT_BRANDING}.
 *
 * @public
 */
export interface BrandingResolutionInput {
  /** Rung 1 — branding passed explicitly to the SDK at init. */
  explicit?: BrandingConfig;
  /**
   * Rung 2 — the legacy `theme` embedded in an older config artifact. Deprecated:
   * supplying it resolves correctly but emits a development-only warning.
   */
  legacyConfigTheme?: BrandingConfig['theme'];
  /** Rung 3 — branding fetched from the Branding API / workspace settings. */
  apiBranding?: BrandingConfig;
  /**
   * When `true` (the default), using the legacy rung logs a one-time
   * development deprecation warning. Set `false` to silence it (e.g. in tests).
   */
  warnOnLegacy?: boolean;
}

/**
 * The outcome of {@link resolveBranding}: the fully-merged branding plus the rung
 * it was resolved from.
 *
 * @public
 */
export interface ResolvedBranding {
  /** Fully-populated branding, each rung merged over {@link DEFAULT_BRANDING}. */
  readonly branding: BrandingConfig;
  /** Which ladder rung supplied the (top-priority) branding. */
  readonly source: BrandingSource;
}

function isNonEmpty(value: BrandingConfig | undefined): value is BrandingConfig {
  return !!value && Object.keys(value).length > 0;
}

let warnedLegacyBranding = false;

/**
 * Resolve branding down the four-rung ladder. Pure and synchronous: fetching the
 * Branding API (rung 3) is the host's job — pass the result as `apiBranding`.
 *
 * @param input - The available branding sources; see {@link BrandingResolutionInput}.
 * @returns The merged branding and the rung it came from.
 * @public
 */
export function resolveBranding(input: BrandingResolutionInput = {}): ResolvedBranding {
  const merge = (partial: BrandingConfig | undefined, source: BrandingSource): ResolvedBranding => ({
    branding: {
      ...DEFAULT_BRANDING,
      ...partial,
      // Theme tokens merge shallowly so a partial theme extends the default map
      // rather than replacing it wholesale.
      theme: { ...DEFAULT_BRANDING.theme, ...partial?.theme },
    },
    source,
  });

  if (isNonEmpty(input.explicit)) return merge(input.explicit, 'explicit');

  if (input.legacyConfigTheme && Object.keys(input.legacyConfigTheme).length > 0) {
    if (input.warnOnLegacy !== false && !warnedLegacyBranding && isDevelopment()) {
      warnedLegacyBranding = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[RevTurbine] Branding embedded in the config `theme` field is deprecated. ' +
          'Pass a `branding` option to the SDK, or resolve it via the Branding API. ' +
          'See the Branding resolution ladder in the SDK docs.',
      );
    }
    return merge({ theme: input.legacyConfigTheme }, 'legacy-config');
  }

  if (isNonEmpty(input.apiBranding)) return merge(input.apiBranding, 'branding-api');

  return merge(undefined, 'default');
}

/**
 * Whether the SDK is running in a development build (drives the dev-only
 * warning). Browser-safe — the web-sdk build has no `@types/node`, so `process`
 * is accessed via `globalThis`, mirroring `config-artifact.ts`.
 */
function isDevelopment(): boolean {
  const processLike = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  if (processLike) return processLike.env?.NODE_ENV !== 'production';

  const locationLike = (globalThis as { location?: { hostname?: string } }).location;
  return locationLike?.hostname === 'localhost'
    || locationLike?.hostname === '127.0.0.1'
    || locationLike?.hostname === '[::1]';
}

/** Test-only: reset the one-time legacy-branding warning latch. @internal */
export function __resetBrandingWarningForTests(): void {
  warnedLegacyBranding = false;
}
