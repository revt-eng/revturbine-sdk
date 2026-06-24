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
 * import { BrowserRuntime } from '@revt-eng/web-sdk';
 * import { createStaticProviders } from '@revt-eng/core';
 *
 * const runtime = new BrowserRuntime({
 *   tenantId: 'tenant_abc',
 *   userId: 'user_123',
 *   exportedConfig: myConfig,
 *   providers: createStaticProviders({ config: myConfig, planHandle: 'pro' }),
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

/* ------------------------------------------------------------------ */
/*  Options                                                            */
/* ------------------------------------------------------------------ */

export interface BrowserRuntimeOptions extends Omit<LocalRuntimeOptions, 'storage' | 'impressionStore'> {
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
}

/* ------------------------------------------------------------------ */
/*  BrowserRuntime                                                     */
/* ------------------------------------------------------------------ */

export class BrowserRuntime extends LocalRuntime {
  private readonly _hydratePromise: Promise<void> | null;

  constructor(options: BrowserRuntimeOptions) {
    const storage = resolvePersistentStorage(options.storage);

    const impressionStore = new StorageImpressionStore({
      storage,
      tenantId: options.tenantId,
      maxRecords: options.maxImpressionRecords,
    });

    super({
      ...options,
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
