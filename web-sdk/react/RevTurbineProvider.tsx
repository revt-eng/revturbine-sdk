'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  initRevTurbine,
  type RevTurbineCustomerSdk,
  type RevTurbineInitInputOptions,
  type RevTurbinePlacementConfig,
  type RevTurbinePlacementDecisionInput,
  type RevTurbineUserContext,
  type UserContextInput,
  resolveLocalPlaybook,
} from '../customer-side';
import type { RevTurbineTheme, RevTurbineThemeInput } from '../theme/types';
import { DEFAULT_THEME, mergeTheme } from '../theme/defaults';
import { loadTheme } from '../theme/theme-loader';
import { RevTurbineThemeProvider } from '../theme/ThemeContext';
import { installAnnotatedCapture, type AnnotatedCaptureOptions } from '../telemetry';
import { RevTurbineContext } from './useRevTurbine';
import { isProductionBuild } from '../build-mode';

type BootstrapPlacementInput = Omit<RevTurbinePlacementDecisionInput, 'placementId'> & {
  placement: RevTurbinePlacementConfig;
};

export type RevTurbineProviderProps = {
  /** SDK initialization options. Accepts optional provider or factory. */
  options: RevTurbineInitInputOptions;
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
 *   options={{ tenantId: 'abc', apiKey: 'key', endpoint: '/api', mode: 'react', user: { id: 'user_123' } }}
 * >
 *   <App />
 * </RevTurbineProvider>
 * ```
 */
export function RevTurbineProvider({ options, bootstrapPlacements, domCapture, children }: RevTurbineProviderProps) {
  const stableBootstrap = bootstrapPlacements ?? EMPTY_BOOTSTRAP;
  const [sdk, setSdk] = useState<RevTurbineCustomerSdk | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState<RevTurbineTheme>(DEFAULT_THEME);
  const [contextVersion, setContextVersion] = useState(0);
  const previousOptionsRef = useRef<RevTurbineInitInputOptions | null>(null);
  const previousBootstrapRef = useRef<BootstrapPlacementInput[] | null>(null);

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
      try {
        nextSdk = initRevTurbine(options);

        // The SDK constructor already merges options.user into userContext.
        // If options.user has structured fields, call identify() to ensure
        // segment recalculation and cache invalidation happen.
        const user = options.user;
        if (user && typeof user === 'object' && (user as { id?: string }).id) {
          nextSdk.identify(
            (user as { id: string }).id,
            user as UserContextInput,
          );
        }

        // Theme — the Playbook is the BASE, always resolved without a network
        // call. Must read via resolveLocalPlaybook so a caller using the
        // canonical `playbook` key still gets the no-network shortcut.
        //
        // Plan 184: this previously fell back to an unconditional
        // `GET /api/sdk/theme` whenever the Playbook carried no theme — which
        // in Server mode (no `localRuntime`) was ALWAYS, against an endpoint no
        // control plane implemented. Every Server-mode consumer ate a
        // guaranteed 404 on init. The fetch is now opt-in via
        // `fetchThemeOverride`, and when enabled it layers OVER this base
        // rather than replacing it.
        const playbook = resolveLocalPlaybook(options.localRuntime);
        const configTheme = playbook?.theme;
        const baseTheme =
          configTheme && typeof configTheme === 'object'
            ? (configTheme as RevTurbineThemeInput)
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
              apiKey: options.apiKey ?? 'local-only',
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
          setTheme(mergeTheme(baseTheme));
        }

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
          await nextSdk.bootstrapPlacementDecisions(preloads);
        }

        if (!mounted) return;
        setSdk(nextSdk);
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
    setContext,
  // Deps intentionally limited — contextVersion change triggers re-render
  }), [sdk, isReady, error, setContext, contextVersion]);

  return (
    <RevTurbineContext.Provider value={value}>
      <RevTurbineThemeProvider theme={theme}>
        {children}
      </RevTurbineThemeProvider>
    </RevTurbineContext.Provider>
  );
}