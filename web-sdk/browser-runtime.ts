/**
 * BrowserRuntime — browser-optimized composition of core subsystems that
 * persists interaction state, caps, and impression history to localStorage.
 *
 * Drop-in replacement for `LocalRuntime` in browser environments. Falls
 * back to in-memory storage when `localStorage` is unavailable (e.g.
 * sandboxed iframes, incognito with quota errors).
 *
 * @example
 * ```ts
 * import { BrowserRuntime } from '@revturbine/sdk';
 * import { createStaticProviders } from '@revt-eng/core';
 *
 * const runtime = new BrowserRuntime({
 *   tenantId: 'tenant_abc',
 *   userId: 'user_123',
 *   playbook: myPlaybook,
 *   providers: createStaticProviders({ config: myPlaybook, planHandle: 'pro' }),
 * });
 *
 * // State survives page reloads — impressions, dismissals, and caps
 * // are persisted to localStorage automatically.
 * await runtime.hydrate();
 *
 * const decision = await runtime.getPlacementDecision({
 *   placementId: 'slot_1',
 *   userId: 'user_123',
 * });
 * ```
 */

import { LocalRuntime, StorageImpressionStore } from '@revt-eng/core';
import type { LocalRuntimeOptions } from '@revt-eng/core';
import { resolvePersistentStorage } from './storage';
import type { RevTurbineStorage } from './storage';
import {
  configArtifactForRuntime,
  type ConfigArtifact,
} from './config-artifact';
import { normalizeEnvironmentId } from './environment';
import { requirePlaybookOption } from './playbook-option';

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

type BrowserRuntimeOptionsBase = Omit<
  LocalRuntimeOptions,
  'storage' | 'impressionStore' | 'exportedConfig' | 'playbook'
> & {

  /** Target fallback for legacy configs. Omitted or blank resolves to `production`. */
  environmentId?: string;

  /**
   * Override the storage backend. When omitted, `localStorage` is used
   * in the browser, falling back to in-memory storage otherwise.
   */
  storage?: RevTurbineStorage;

  /**
   * Maximum number of impression records to keep per user.
   * Older records are evicted when the limit is reached.
   * Default: 500.
   */
  maxImpressionRecords?: number;

  /**
   * Automatically call `hydrate()` during construction so
   * impression caches are warm by the time the first decision is made.
   * Default: true.
   */
  autoHydrate?: boolean;
};

/**
 * Options for {@link BrowserRuntime}.
 *
 * Exactly one of `playbook` (canonical) or `exportedConfig` (deprecated) is
 * required — the union keeps that a compile-time requirement, exactly as the
 * single required `exportedConfig` property did before the rename (BL-0156).
 */
export type BrowserRuntimeOptions = BrowserRuntimeOptionsBase &
  (
    | {
        /** The Playbook this runtime evaluates against. */
        playbook: ConfigArtifact;
        /** @deprecated Use `playbook`. Removed in `0.12.0`. */
        exportedConfig?: ConfigArtifact;
      }
    | {
        /** The Playbook this runtime evaluates against. */
        playbook?: ConfigArtifact;
        /**
         * @deprecated Renamed to `playbook` — `Playbook` is the canonical name
         * for the artifact (BL-0156). Still fully supported: pass either one.
         * When both are supplied `playbook` wins. Removed in `0.12.0`.
         */
        exportedConfig: ConfigArtifact;
      }
  );

/* ------------------------------------------------------------------ */
/*  BrowserRuntime                                                     */
/* ------------------------------------------------------------------ */

export class BrowserRuntime extends LocalRuntime {
  private readonly _hydratePromise: Promise<void> | null;

  constructor(options: BrowserRuntimeOptions) {
    // One resolver, so `playbook` vs the deprecated `exportedConfig` cannot be
    // decided differently here than anywhere else in the SDK.
    const rawConfig = requirePlaybookOption(options, 'BrowserRuntime');
    const {
      playbook: _playbook,
      exportedConfig: _exportedConfig,
      environmentId,
      ...runtimeOptions
    } = options as BrowserRuntimeOptionsBase & {
      playbook?: ConfigArtifact;
      exportedConfig?: ConfigArtifact;
      environmentId?: string;
    };
    const playbook = configArtifactForRuntime(
      rawConfig,
      'BrowserRuntime.playbook',
      {
        tenantId: options.tenantId,
        environmentId: normalizeEnvironmentId(environmentId),
      },
    );
    if (!playbook) {
      throw new Error('BrowserRuntime requires a playbook');
    }
    const storage = resolvePersistentStorage(options.storage);

    const impressionStore = new StorageImpressionStore({
      storage,
      tenantId: options.tenantId,
      maxRecords: options.maxImpressionRecords,
    });

    super({
      ...runtimeOptions,
      // `playbook` is the canonical LocalRuntimeOptions key as of
      // @revt-eng/core 0.1.330; passing `exportedConfig` here would trip
      // core's own one-time deprecation warning on every BrowserRuntime.
      playbook,
      storage,
      impressionStore,
    });

    // Eagerly hydrate by default so sync checks work on first render.
    const autoHydrate = options.autoHydrate ?? true;
    this._hydratePromise = autoHydrate ? this.hydrate() : null;
  }

  /**
   * Wait for the auto-hydration started in the constructor to complete.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async ready(): Promise<void> {
    if (this._hydratePromise) {
      await this._hydratePromise;
    }
  }
}
