'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  initRevTurbine,
  resolveBrowserPublicKey,
  type RevTurbineCustomerSdk,
  type RevTurbineInitInputOptions,
  type RevTurbinePlacementConfig,
  type RevTurbinePlacementDecisionInput,
  type RevTurbineUserContext,
  type Exact,
  type ExactInitOptions,
  type UserContextInput,
} from '../customer-side';
import type { RevTurbineTheme, RevTurbineThemeInput } from '../theme/types';
import {
  DEFAULT_THEME,
  baseThemeForScheme,
  mergeTheme,
  type RevTurbineColorScheme,
} from '../theme/defaults';
import { useResolvedColorScheme } from '../theme/useColorScheme';
import { loadTheme } from '../theme/theme-loader';
import {
  RevTurbineThemeProvider,
  useRevTurbineThemeProviderPresent,
} from '../theme/ThemeContext';
import { installAnnotatedCapture, type AnnotatedCaptureOptions } from '../telemetry';
import { RevTurbineContext } from './useRevTurbine';
import {
  INIT_STATUS_OK,
  initStatusForError,
  type RevTurbineInitPhase,
  type RevTurbineInitStatus,
} from './init-status';
import { InitFailureDiagnostic } from './InitFailureDiagnostic';
import { isProductionBuild } from '../build-mode';

type BootstrapPlacementInput = Omit<RevTurbinePlacementDecisionInput, 'placementId'> & {
  placement: RevTurbinePlacementConfig;
};

export type RevTurbineProviderProps<
  TUser extends RevTurbineUserContext = RevTurbineUserContext,
  TOptions extends RevTurbineInitInputOptions = RevTurbineInitInputOptions,
> = {
  /**
   * SDK initialization options. Accepts optional provider or factory.
   *
   * `options.user` is exact-checked (plan 191 REQ-3): a key the user context
   * does not declare — the `user: { id, context: { plan_handle } }` shape the
   * docs used to teach — fails to compile, including when `options` is built
   * in an un-annotated `useMemo`, which is precisely where TypeScript's own
   * excess-property check stops applying.
   */
  options: TOptions & ExactInitOptions<TOptions> & { user?: Exact<RevTurbineUserContext, TUser> };
  /** Placements to bootstrap (preload decisions) on mount. */
  bootstrapPlacements?: BootstrapPlacementInput[];
  /**
   * Opt into annotated DOM capture (plan 144 TASK-15). When set, one delegated
   * listener per event is installed at the document root; a click on an element
   * with `data-rt-event` emits that event with its allowlisted `data-rt-prop-*`
   * / `data-rt-ref` values — never text, input values, hrefs, or selectors, and
   * never a password / file / hidden / payment control (REQ-14). `true` uses the
   * defaults; pass {@link AnnotatedCaptureOptions} to configure events/caps.
   * Omit to disable. Memoize an object value to avoid re-installing.
   */
  domCapture?: boolean | AnnotatedCaptureOptions;
  /**
   * Light/dark palette for rendered placements (plan 233 TASK-6).
   *
   * Deliberately a provider prop rather than an SDK init option: `options`
   * identity drives re-initialization, so a scheme toggle placed there would
   * rebuild the SDK on every switch. That was the customer workaround this
   * replaces. Defaults to `'system'`, which follows `prefers-color-scheme` and
   * keeps following it.
   *
   * A branding theme still applies on top — the scheme only selects which base
   * palette its tokens merge over.
   */
  colorScheme?: RevTurbineColorScheme;
  /** React children. */
  children: React.ReactNode;
};

/**
 * Stable empty array used as the default for bootstrapPlacements.
 * Avoids creating a new array identity on every render which would
 * retrigger the initialization useEffect in an infinite loop.
 */
const EMPTY_BOOTSTRAP: BootstrapPlacementInput[] = [];

/**
 * React context provider for the RevTurbine SDK.
 *
 * Wraps your application to provide SDK access to all child components.
 * Handles initialization, user identification, and optional placement bootstrap.
 *
 * @example
 * ```tsx
 * <RevTurbineProvider
 *   options={{ tenantId: 'abc', publicKey: 'rtk_…', endpoint: '/api', mode: 'react', user: { id: 'user_123' } }}
 * >
 *   <App />
 * </RevTurbineProvider>
 * ```
 */
export function RevTurbineProvider<
  TUser extends RevTurbineUserContext = RevTurbineUserContext,
  TOptions extends RevTurbineInitInputOptions = RevTurbineInitInputOptions,
>({
  options,
  bootstrapPlacements,
  domCapture,
  colorScheme = 'system',
  children,
}: RevTurbineProviderProps<TUser, TOptions>) {
  const stableBootstrap = bootstrapPlacements ?? EMPTY_BOOTSTRAP;
  const [sdk, setSdk] = useState<RevTurbineCustomerSdk | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState('');
  const [initStatus, setInitStatus] = useState<RevTurbineInitStatus>(INIT_STATUS_OK);
  const [theme, setTheme] = useState<RevTurbineTheme>(DEFAULT_THEME);
  // The branding tokens as resolved at init, kept so a scheme change can
  // re-merge them over the other palette WITHOUT re-running initialization.
  // `null` means "init finished and resolved no branding tokens"; `undefined`
  // means "init has not reported yet". The distinction keeps the scheme effect
  // from painting a default theme over a not-yet-initialized provider.
  const [brandingInput, setBrandingInput] = useState<RevTurbineThemeInput | null | undefined>(undefined);
  const resolvedScheme = useResolvedColorScheme(colorScheme);
  const [contextVersion, setContextVersion] = useState(0);
  const previousOptionsRef = useRef<RevTurbineInitInputOptions | null>(null);
  const previousBootstrapRef = useRef<BootstrapPlacementInput[] | null>(null);
  // An app-mounted RevTurbineThemeProvider above us owns the theme (plan 233
  // TASK-5, Kent ruling Q-2: explicit local intent always beats a resolved
  // default). Read here, at our own level, so it reflects ancestors only.
  const appOwnsTheme = useRevTurbineThemeProviderPresent();
  const warnedThemeOverrideRef = useRef(false);

  useEffect(() => {
    if (isProductionBuild()) {
      previousOptionsRef.current = options;
      previousBootstrapRef.current = stableBootstrap;
      return;
    }

    if (previousOptionsRef.current && previousOptionsRef.current !== options) {
      console.warn('[RevTurbine] RevTurbineProvider options prop identity changed. Memoize options to avoid unnecessary SDK re-initialization.');
    }

    if (previousBootstrapRef.current && previousBootstrapRef.current !== stableBootstrap) {
      console.warn('[RevTurbine] RevTurbineProvider bootstrapPlacements identity changed. Memoize bootstrap arrays to avoid repeated preloads.');
    }

    previousOptionsRef.current = options;
    previousBootstrapRef.current = stableBootstrap;
  }, [options, stableBootstrap]);

  // The override is silent otherwise: the app's theme simply wins and the SDK's
  // resolved branding never paints, which looks identical to branding being
  // misconfigured. Say so once, in development.
  useEffect(() => {
    if (!appOwnsTheme || warnedThemeOverrideRef.current || isProductionBuild()) return;
    warnedThemeOverrideRef.current = true;
    console.warn(
      '[RevTurbine] A RevTurbineThemeProvider is mounted above RevTurbineProvider, so it owns the '
        + 'theme, and the SDK-resolved branding (the `branding` option / Branding API / Playbook '
        + '`theme`) is NOT applied to placements. That is the supported way to take over theming — '
        + 'remove the outer provider if you meant the SDK to resolve it.',
    );
  }, [appOwnsTheme]);

  // Re-resolve the rendered theme whenever the branding tokens or the scheme
  // change. This is what makes a scheme toggle a re-render rather than a
  // rebuild: it never touches `options`, so the init effect does not re-run and
  // the SDK instance identity is preserved (plan 233 AC-7).
  useEffect(() => {
    if (brandingInput === undefined) return;
    setTheme(mergeTheme(brandingInput, baseThemeForScheme(resolvedScheme)));
  }, [brandingInput, resolvedScheme]);

  // Annotated DOM capture (plan 144 TASK-15). One delegated listener per event
  // at the document root; emits only allowlisted `data-rt-*` values, redacted by
  // `capture`. Off unless `domCapture` is set.
  useEffect(() => {
    if (!sdk || !domCapture || typeof document === 'undefined') return;
    const captureOptions = typeof domCapture === 'object' ? domCapture : {};
    return installAnnotatedCapture(document, (eventName, props) => {
      void sdk.capture(eventName, props).catch(() => {
        // Best-effort — a capture failure must never surface to host UI.
      });
    }, captureOptions);
  }, [sdk, domCapture]);

  useEffect(() => {
    let mounted = true;

    async function initialize() {
      // Declared outside the try so the catch can report through it (plan 182
      // TASK-5). `initRevTurbine` is synchronous and first, so by the time any
      // realistic init failure happens — identify, theme load, placement
      // registration, bootstrap — the instance exists.
      let nextSdk: ReturnType<typeof initRevTurbine> | undefined;
      // Which phase is running, so a failure can say where it happened rather
      // than only what threw (plan 233 TASK-2).
      let phase: RevTurbineInitPhase = 'construct';
      try {
        // Widened deliberately, not cast. Exactness is enforced at the PROP
        // boundary by `ExactInitOptions<TOptions>`; re-entering
        // `initRevTurbine`'s own generic would ask TypeScript to prove a
        // composition of two independent exactness mappings, which it cannot.
        // The assignment still type-checks, so nothing is being suppressed.
        // The provider is the React integration, so it labels telemetry as
        // such unless the app says otherwise. `mode` changes no behavior.
        const initOptions: RevTurbineInitInputOptions = { ...options, mode: options.mode ?? 'react' };
        nextSdk = initRevTurbine(initOptions);

        // The SDK constructor already merges options.user into userContext.
        // If options.user has structured fields, call identify() to ensure
        // segment recalculation and cache invalidation happen.
        //
        // `id` is an `options.user` key, NOT an identify-context key: it is
        // the first identify() argument. Passing the whole `user` object
        // through as the context therefore tripped the plan 191 unrecognized-
        // key guardrail on EVERY provider mount — a console warning plus an
        // `sdk_validation_warning` event per session, for correct integration
        // code. Strip it here rather than teaching the guardrail to ignore
        // `id`, which would also hide it from direct identify() callers who
        // really did put the id in the wrong place.
        phase = 'identify';
        const user = options.user;
        if (user && typeof user === 'object' && (user as { id?: string }).id) {
          const { id, ...context } = user as { id: string } & UserContextInput;
          nextSdk.identify(id, context as UserContextInput);
        }

        // Theme — the branding ladder is the BASE, always resolved without a
        // network call.
        //
        // Plan 184: this previously fell back to an unconditional
        // `GET /api/sdk/theme` whenever the Playbook carried no theme — which
        // in Server mode (no `localRuntime`) was ALWAYS, against an endpoint no
        // control plane implemented. Every Server-mode consumer ate a
        // guaranteed 404 on init. The fetch is now opt-in via
        // `fetchThemeOverride`, and when enabled it layers OVER this base
        // rather than replacing it.
        phase = 'theme';
        // Plan 233 TASK-3: resolve through the SDK's branding ladder rather than
        // reading `localRuntime.playbook.theme` directly.
        //
        // The ladder (explicit `branding` → branding API → legacy config `theme`
        // → defaults) already existed and `getBranding()` already used it — but
        // the renderer did not, so the two disagreed. Reading the Playbook here
        // meant rung 1 never reached `useRevTurbineTheme()`: a customer who
        // followed our own `VAL-DEP-01` warning (move `theme` out of the config,
        // pass the SDK `branding` argument) lost all theming and got white
        // modals in a dark app, because in local mode the Playbook's `theme` was
        // the only source the renderer read — and the CLI *strips* that field on
        // ingestion. Following our advice broke the product.
        //
        // `getBranding()` also reads the RESOLVED config rather than the raw
        // option, so a Playbook normalized at init (plan 233 TASK-1) is what
        // gets consulted.
        const brandingTheme = nextSdk.getBranding().branding.theme;
        // `BrandingConfig.theme` is a deliberate passthrough record — scaffold
        // does not replicate the SDK's ~40 rendering tokens, so `RevTurbineTheme`
        // is the authoritative shape and this is the sanctioned boundary cast.
        const baseTheme =
          brandingTheme && Object.keys(brandingTheme).length > 0
            ? (brandingTheme as RevTurbineThemeInput)
            : undefined;

        if (options.fetchThemeOverride) {
          // Const capture: `nextSdk` is a `let ... | undefined`, and TS cannot
          // prove it is still assigned inside the `onOverride` closure below
          // (TS18048 under the release build's declaration emit).
          const initializedSdk = nextSdk;
          const initialTheme = await loadTheme(
            {
              tenantId: options.tenantId ?? 'local',
              endpoint: options.endpoint ?? 'https://api.revturbine.local',
              apiKey: resolveBrowserPublicKey(options) ?? 'local-only',
              base: baseTheme,
              // Feed the raw override into the SDK's branding-API rung so
              // `getBranding()` and `useRevTurbineTheme()` resolve from the
              // same value — otherwise the two could report different branding
              // for one tenant (plan 184).
              onOverride: (override) => {
                initializedSdk.setApiBranding(
                  override && Object.keys(override).length > 0 ? { theme: override } : undefined,
                );
              },
            },
            (updated) => {
              if (mounted) setTheme(updated);
            },
          );
          if (mounted) setTheme(initialTheme);
        } else if (mounted) {
          // Only record the branding tokens here. The scheme effect below owns
          // setTheme, so flipping light/dark re-merges these over the other
          // palette without re-entering initialization (plan 233 AC-7).
          setBrandingInput(baseTheme ?? null);
        }

        phase = 'placements';
        // Bootstrap preloads — derive userId from the SDK's own user context.
        const sdkUserId = nextSdk.getUserContext().user_id;
        const preloads: RevTurbinePlacementDecisionInput[] = [];
        for (const item of stableBootstrap) {
          const placementId = await nextSdk.registerPlacement(item.placement);
          const itemUserId = item.userId || sdkUserId;
          if (!itemUserId) continue;
          preloads.push({
            placementId,
            userId: itemUserId,
            contextMode: item.contextMode,
            overrides: item.overrides,
            traits: item.traits,
            ttlMs: item.ttlMs,
          });
        }

        if (preloads.length > 0) {
          phase = 'bootstrap';
          await nextSdk.bootstrapPlacementDecisions(preloads);
        }

        if (!mounted) return;
        setSdk(nextSdk);
        setInitStatus(INIT_STATUS_OK);
        setIsReady(true);
      } catch (error) {
        if (!mounted) return;
        // Plan 174 TASK-4 (F-69b): propagate the cause — the constant string
        // alone hid the real failure from useRevTurbine().error.
        console.error('[RevTurbine] SDK provider initialization failed:', error);
        const cause = error instanceof Error ? error.message : String(error);
        // Anonymous "the SDK itself failed" beacon (plan 182 TASK-5). Undefined
        // only when the synchronous constructor threw — a malformed-options
        // develop-time error that already fails loudly.
        nextSdk?.reportSdkError('provider_init_failed', cause);
        // Reachable with no instance — `sdk` is null from here, so every probe
        // the SDK exposes is gone and this is the only thing left to ask
        // (plan 233 TASK-2).
        const status = initStatusForError(phase, error);
        console.error(`[RevTurbine] ${status.remediation}`);
        setInitStatus(status);
        setError(`Failed to initialize RevTurbine SDK provider: ${cause}`);
        setIsReady(false);
      }
    }

    void initialize();

    return () => {
      mounted = false;
    };
  }, [options, stableBootstrap]);

  const setContext = useCallback((context: RevTurbineUserContext) => {
    if (!sdk) return;
    sdk.setUserContext(context);
    setContextVersion((v) => v + 1);
  }, [sdk]);

  const value = useMemo(() => ({
    sdk,
    isReady,
    error,
    initStatus,
    colorScheme: resolvedScheme,
    setContext,
  // Deps intentionally limited — contextVersion change triggers re-render
  }), [sdk, isReady, error, initStatus, resolvedScheme, setContext, contextVersion]);

  const body = (
    <>
      {children}
      {!initStatus.ok && !isProductionBuild() ? (
        <InitFailureDiagnostic status={initStatus} />
      ) : null}
    </>
  );

  return (
    <RevTurbineContext.Provider value={value}>
      {appOwnsTheme ? body : (
        <RevTurbineThemeProvider theme={theme}>{body}</RevTurbineThemeProvider>
      )}
    </RevTurbineContext.Provider>
  );
}