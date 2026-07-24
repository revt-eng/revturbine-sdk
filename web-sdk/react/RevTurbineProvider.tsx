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

function isProductionBuild(): boolean {
  const processLike = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  return processLike?.env?.NODE_ENV === 'production';
}

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
      try {
        const nextSdk = initRevTurbine(options);

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

        // Load theme — prefer the Playbook snapshot, fall back to API fetch.
        // Must read via resolveLocalPlaybook so a caller using the canonical
        // `playbook` key still gets the no-network theme shortcut instead of an
        // API round-trip that can hang.
        const playbook = resolveLocalPlaybook(options.localRuntime);
        const configTheme = playbook?.theme;

        if (configTheme && typeof configTheme === 'object') {
          // RevTurbineConfig supplies the theme — merge with defaults (no API call).
          const resolved = mergeTheme(configTheme as RevTurbineThemeInput);
          if (mounted) setTheme(resolved);
        } else {
          // No theme in exported config — load from API / localStorage.
          const initialTheme = await loadTheme(
            {
              tenantId: options.tenantId ?? 'local',
              endpoint: options.endpoint ?? 'https://api.revturbine.local',
              apiKey: options.apiKey ?? 'local-only',
            },
            (updated) => {
              if (mounted) setTheme(updated);
            },
          );
          if (mounted) setTheme(initialTheme);
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
      } catch {
        if (!mounted) return;
        setError('Failed to initialize RevTurbine SDK provider.');
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
