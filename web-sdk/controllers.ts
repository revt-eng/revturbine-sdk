/**
 * Headless SDK controllers — framework-agnostic orchestration.
 *
 * These classes encapsulate the register → decide → track → interact lifecycle
 * that the React hooks implement via `useState`/`useEffect`. Use them from
 * Vue, Svelte, Angular, vanilla JS, or server-side code.
 *
 * @example
 * ```ts
 * import { initRevTurbine, PlacementController, EntitlementGate } from '@revt-eng/web-sdk/headless';
 *
 * const session = await initRevTurbine({
 *   tenantId: 'tenant_abc',
 *   apiKey: 'rt_live_xxx',
 *   endpoint: 'https://api.revturbine.io',
 *   user: { id: 'user_123', plan: { id: 'pro' } },
 * });
 *
 * const banner = session.placement({ surfaceSlot: { id: 'upsell_banner' } });
 * await banner.load();
 * if (banner.visible) { ... }
 * await banner.dismiss();
 *
 * const gate = session.entitlement({ handle: 'brand_kit', autoGate: true });
 * await gate.check();
 * if (gate.denied) { // show gate.gatedPlacement }
 * ```
 */

import type {
  RevTurbineCustomerSdk,
  RevTurbineInitInputOptions,
  RevTurbinePlacementConfig,
  RevTurbineSurfaceSlotConfig,
  RevTurbinePlacementDecision,
  RevTurbinePlacementContent,
  RevTurbinePlacementDecisionOverrides,
  RevTurbinePlacementRequestConfig,
  RevTurbineContextMode,
  RevTurbineEntitlementContext,
  RevTurbineUserContext,
  UserContextInput,
  SdkMetadata,
  EntitlementResult,
  PlacementOutput,
  UserTargetingContext,
  RevTurbineUsageSnapshot,
  RevTurbineTrialContext,
  UsageBalances,
  JsonObject,
} from './customer-side';
import { initRevTurbine as initRevTurbineCore } from './customer-side';
import type { RevTurbineTheme, RevTurbineThemeInput } from './theme/types';
import { DEFAULT_THEME, mergeTheme } from './theme/defaults';
import { loadTheme } from './theme/theme-loader';

// ── Change listener type ────────────────────────────────────────────────────

/** Callback used to subscribe to state changes in controllers. */
export type ChangeListener = () => void;

// ── Placement controller ────────────────────────────────────────────────────

/**
 * Options for creating a {@link PlacementController}.
 */
export interface PlacementControllerOptions {
  /** Placement configuration (name, scope key, metadata). */
  placement?: RevTurbinePlacementConfig;
  /** Canonical surface slot configuration (preferred over `placement`). */
  surfaceSlot?: RevTurbineSurfaceSlotConfig;
  /** Target user ID. Falls back to the SDK's current user context. */
  userId?: string;
  /** Context resolution mode. Default `'auto'`. */
  contextMode?: RevTurbineContextMode;
  /** Override segment, plan, or usage for testing. */
  overrides?: RevTurbinePlacementDecisionOverrides;
  /** Custom traits to include in the decision request. */
  traits?: Record<string, string | number | boolean>;
  /** Decision cache TTL in milliseconds. */
  ttlMs?: number;
  /** Whether to track an impression automatically when the decision is visible. Default `true`. */
  autoTrackImpression?: boolean;
}

/**
 * Read-only snapshot of a {@link PlacementController}'s state.
 */
export interface PlacementControllerState {
  readonly isLoading: boolean;
  readonly error: string;
  readonly placementId: string;
  readonly visible: boolean;
  readonly decision: RevTurbinePlacementDecision | null;
  readonly content: RevTurbinePlacementContent['content'] | null;
}

/**
 * Framework-agnostic placement lifecycle controller.
 *
 * Encapsulates the same register → decide → impression-track → interact flow
 * that the React `usePlacement()` hook provides, but without any framework dependency.
 *
 * Subscribe to state changes with {@link onChange} and read the current state
 * with {@link state}, or just `await load()` for a one-shot pattern.
 *
 * @example
 * ```ts
 * const ctrl = new PlacementController(sdk, { surfaceSlot: { id: 'upsell_banner' } });
 * ctrl.onChange(() => updateUI(ctrl.state));
 * await ctrl.load();
 * ```
 */
export class PlacementController {
  private readonly sdk: RevTurbineCustomerSdk;
  private readonly options: PlacementControllerOptions;
  private readonly listeners = new Set<ChangeListener>();

  private _placementId = '';
  private _decision: RevTurbinePlacementDecision | null = null;
  private _isLoading = false;
  private _error = '';
  private _impressionTracked = false;
  private _loadSeq = 0;

  constructor(sdk: RevTurbineCustomerSdk, options: PlacementControllerOptions) {
    this.sdk = sdk;
    this.options = options;
  }

  /** Current state snapshot. */
  get state(): PlacementControllerState {
    return {
      isLoading: this._isLoading,
      error: this._error,
      placementId: this._placementId,
      visible: Boolean(this._decision?.visible),
      decision: this._decision,
      content: this._decision?.content ?? null,
    };
  }

  /** Convenience: `true` when the current decision says the placement is visible. */
  get visible(): boolean {
    return Boolean(this._decision?.visible);
  }

  /** Current resolved content, or `null` if no decision has been loaded. */
  get content(): RevTurbinePlacementContent['content'] | null {
    return this._decision?.content ?? null;
  }

  /** Current decision, or `null` if not yet loaded. */
  get decision(): RevTurbinePlacementDecision | null {
    return this._decision;
  }

  /** Registered placement ID, or empty string before first `load()`. */
  get placementId(): string {
    return this._placementId;
  }

  /**
   * Register the placement (if needed) and fetch a decision.
   *
   * When `autoTrackImpression` is true (default), a visible decision
   * automatically records an impression event.
   */
  async load(): Promise<RevTurbinePlacementDecision | null> {
    const opts = this.options;
    const resolvedUserId = opts.userId || this.sdk.getUserContext().user_id;

    if (!resolvedUserId) {
      this._error = 'Cannot load placement: no userId available.';
      this.notify();
      return null;
    }

    const seq = ++this._loadSeq;
    this._isLoading = true;
    this._error = '';
    this.notify();

    try {
      // Register if we don't already have a placement ID
      if (!this._placementId) {
        if (opts.surfaceSlot) {
          this._placementId = await this.sdk.registerSurfaceSlot(opts.surfaceSlot);
        } else if (opts.placement) {
          this._placementId = await this.sdk.registerPlacement(opts.placement);
        } else {
          this._error = 'Either placement or surfaceSlot must be provided.';
          this._isLoading = false;
          this.notify();
          return null;
        }
      }
      if (seq !== this._loadSeq) return this._decision;

      // Fetch decision
      const decision = await this.sdk.getPlacementDecision({
        placementId: this._placementId,
        userId: resolvedUserId,
        contextMode: opts.contextMode,
        overrides: opts.overrides,
        traits: opts.traits,
        ttlMs: opts.ttlMs,
      });
      if (seq !== this._loadSeq) return this._decision;

      this._decision = decision;

      // Auto-track impression
      if (
        decision.visible
        && !this._impressionTracked
        && (opts.autoTrackImpression ?? true)
      ) {
        this._impressionTracked = true;
        await this.sdk.trackTreatmentInteraction({
          userId: resolvedUserId,
          placementId: this._placementId,
          interactionType: 'impression',
          metadata: { decision_source: decision.decisionSource },
        });
      }

      return decision;
    } catch (err) {
      if (seq === this._loadSeq) {
        this._error = err instanceof Error ? err.message : 'Failed to load placement decision.';
      }
      return null;
    } finally {
      if (seq === this._loadSeq) {
        this._isLoading = false;
        this.notify();
      }
    }
  }

  /** Re-fetch the placement decision (clears impression tracking). */
  async refresh(): Promise<RevTurbinePlacementDecision | null> {
    this._impressionTracked = false;
    return this.load();
  }

  /** Record a dismiss interaction and hide the placement. */
  async dismiss(cooldownMs = 24 * 60 * 60 * 1000): Promise<void> {
    await this.trackInteraction('dismiss', { cooldown_ms: cooldownMs });
  }

  /** Record a snooze/remind-me-later interaction and hide the placement. */
  async snooze(seconds = 3600): Promise<void> {
    await this.trackInteraction('remind_me_later', { remind_after_seconds: seconds });
  }

  /** Alias for {@link snooze}. */
  async remindMeLater(seconds = 3600): Promise<void> {
    await this.snooze(seconds);
  }

  /** Record a CTA click interaction. */
  async ctaClick(ctaTarget?: string): Promise<void> {
    await this.trackInteraction('cta_clicked', { cta_target: ctaTarget || null });
  }

  /** Record a CTA completion interaction and hide the placement. */
  async ctaComplete(ctaTarget?: string): Promise<void> {
    await this.trackInteraction('cta_completed', { cta_target: ctaTarget || null });
  }

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   *
   * @example
   * ```ts
   * const unsub = ctrl.onChange(() => console.log(ctrl.state));
   * // later...
   * unsub();
   * ```
   */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Reset the controller state (clears decision, placement ID, etc.). */
  reset(): void {
    this._placementId = '';
    this._decision = null;
    this._isLoading = false;
    this._error = '';
    this._impressionTracked = false;
    this._loadSeq++;
    this.notify();
  }

  private async trackInteraction(
    interactionType: 'dismiss' | 'remind_me_later' | 'cta_clicked' | 'cta_completed',
    metadata: SdkMetadata,
  ): Promise<void> {
    const resolvedUserId = this.options.userId || this.sdk.getUserContext().user_id;
    if (!this._placementId || !resolvedUserId) return;

    await this.sdk.trackTreatmentInteraction({
      userId: resolvedUserId,
      placementId: this._placementId,
      treatmentId: this._decision?.placementId,
      interactionType,
      metadata,
    });

    // Hide after dismiss/snooze/complete (same as React hook behavior)
    if (
      interactionType === 'dismiss'
      || interactionType === 'remind_me_later'
      || interactionType === 'cta_completed'
    ) {
      if (this._decision) {
        this._decision = { ...this._decision, visible: false };
        this.notify();
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// ── Entitlement gate controller ─────────────────────────────────────────────

/**
 * Options for creating an {@link EntitlementGate}.
 */
export interface EntitlementGateOptions {
  /** The entitlement handle to check (e.g. `'brand_kit'`, `'mp4_download'`). */
  handle: string;
  /** Optional context (usage, required tier, etc.). */
  context?: RevTurbineEntitlementContext;
  /**
   * When true, automatically resolve a gated placement for denied entitlements.
   * Default `false`.
   */
  autoGate?: boolean;
  /**
   * Optional placement request fields used when auto-gating needs to fetch
   * a placement and one is not attached to the entitlement response.
   */
  gatePlacementRequest?: Omit<RevTurbinePlacementRequestConfig, 'entitlementHandle'>;
}

/**
 * Read-only snapshot of an {@link EntitlementGate}'s state.
 */
export interface EntitlementGateState {
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly result: EntitlementResult | null;
  readonly allowed: boolean;
  readonly limited: boolean;
  readonly denied: boolean;
  readonly gatedPlacement: PlacementOutput | null;
}

/**
 * Framework-agnostic entitlement check + auto-gate controller.
 *
 * Encapsulates the same check → gate-resolve flow that the React
 * `useEntitlement()` hook provides.
 *
 * @example
 * ```ts
 * const gate = new EntitlementGate(sdk, { handle: 'brand_kit', autoGate: true });
 * gate.onChange(() => updateUI(gate.state));
 * await gate.check();
 * if (gate.denied && gate.gatedPlacement) { showUpgradeModal(gate.gatedPlacement); }
 * ```
 */
export class EntitlementGate {
  private readonly sdk: RevTurbineCustomerSdk;
  private readonly options: EntitlementGateOptions;
  private readonly listeners = new Set<ChangeListener>();

  private _isLoading = false;
  private _error: string | null = null;
  private _result: EntitlementResult | null = null;
  private _gatedPlacement: PlacementOutput | null = null;

  constructor(sdk: RevTurbineCustomerSdk, options: EntitlementGateOptions) {
    this.sdk = sdk;
    this.options = options;
  }

  /** Current state snapshot. */
  get state(): EntitlementGateState {
    return {
      isLoading: this._isLoading,
      error: this._error,
      result: this._result,
      allowed: this._result?.status === 'allowed',
      limited: this._result?.status === 'limited',
      denied: this._result?.status === 'denied',
      gatedPlacement: this._gatedPlacement,
    };
  }

  /** Convenience: `true` when the entitlement is allowed. */
  get allowed(): boolean { return this._result?.status === 'allowed'; }
  /** Convenience: `true` when usage is limited (partially exhausted). */
  get limited(): boolean { return this._result?.status === 'limited'; }
  /** Convenience: `true` when the entitlement is denied. */
  get denied(): boolean { return this._result?.status === 'denied'; }
  /** The raw entitlement result, or `null` before first check. */
  get result(): EntitlementResult | null { return this._result; }
  /** Resolved gated placement when `denied` and `autoGate` are active. */
  get gatedPlacement(): PlacementOutput | null { return this._gatedPlacement; }

  /**
   * Run the entitlement check. If denied and `autoGate` is true,
   * also resolves a gated placement.
   */
  async check(): Promise<EntitlementResult | null> {
    const { handle, context, autoGate, gatePlacementRequest } = this.options;
    this._isLoading = true;
    this._error = null;
    this.notify();

    try {
      const res = await this.sdk.checkEntitlement(handle, context);
      this._result = res;

      if (!autoGate || res.status !== 'denied') {
        this._gatedPlacement = null;
      } else if (res.placement) {
        this._gatedPlacement = res.placement;
      } else {
        // Fetch gated placement from API
        const resolved = await this.sdk.getPlacement({
          ...gatePlacementRequest,
          entitlementHandle: handle,
        });
        this._gatedPlacement = resolved;
      }

      return res;
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._gatedPlacement = null;
      return null;
    } finally {
      this._isLoading = false;
      this.notify();
    }
  }

  /** Re-run the entitlement check (alias of {@link check}). */
  async recheck(): Promise<EntitlementResult | null> {
    return this.check();
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// ── SDK session ─────────────────────────────────────────────────────────────

/**
 * Options for {@link initRevTurbine}, extending the standard init options
 * with optional bootstrap placements.
 */
export type SdkSessionOptions = RevTurbineInitInputOptions & {
  /** Placements to bootstrap (preload decisions) on creation. */
  bootstrapPlacements?: Array<{
    placement: RevTurbinePlacementConfig;
    userId?: string;
    contextMode?: RevTurbineContextMode;
    overrides?: RevTurbinePlacementDecisionOverrides;
    traits?: Record<string, string | number | boolean>;
    ttlMs?: number;
  }>;
};

/**
 * A fully-initialized SDK session with convenience methods for creating
 * placement and entitlement controllers, updating user context,
 * and accessing the underlying SDK instance.
 *
 * This is the recommended entry point for headless (non-React) consumers.
 *
 * @example
 * ```ts
 * const session = await initRevTurbine({
 *   tenantId: 'tenant_abc',
 *   apiKey: 'rt_live_xxx',
 *   endpoint: 'https://api.revturbine.io',
 *   user: { id: 'user_123', plan: { id: 'pro' } },
 * });
 *
 * // Get a placement by slot ID
 * const banner = session.placement({ surfaceSlot: { id: 'upsell_banner' } });
 * const decision = await banner.load();
 *
 * // Check an entitlement with auto-gate
 * const gate = session.entitlement({ handle: 'brand_kit', autoGate: true });
 * await gate.check();
 *
 * // Update user context (works in any runtime mode)
 * session.identify('user_456', { plan: { id: 'enterprise' } });
 * session.setUserContext({ personalization: { company: 'Acme' } });
 * ```
 */
export class SdkSession {
  /** The underlying SDK instance. Use for advanced/direct operations. */
  readonly sdk: RevTurbineCustomerSdk;
  /** Resolved theme. */
  readonly theme: RevTurbineTheme;

  constructor(sdk: RevTurbineCustomerSdk, theme: RevTurbineTheme) {
    this.sdk = sdk;
    this.theme = theme;
  }

  // ── User context ────────────────────────────────────────────────────────

  /**
   * Identify a user and optionally set traits/context.
   * Triggers segment re-evaluation and clears decision cache.
   */
  identify(userId: string, contextOrTraits?: Parameters<RevTurbineCustomerSdk['identify']>[1]): void {
    this.sdk.identify(userId, contextOrTraits);
  }

  /** Reset to anonymous user state. */
  resetIdentity(): void {
    this.sdk.resetIdentity();
  }

  /**
   * Hard-reset the user context to a blank slate (no anonymous inference) —
   * removes every user-context value plus usage balances and clears the
   * decision cache, interaction state, and impression history. Mostly for
   * demo / fixture flows. See {@link RevTurbineCustomerSdk.resetUserContext}.
   */
  resetUserContext(): void {
    this.sdk.resetUserContext();
  }

  /**
   * Merge fields into the current user context.
   * Triggers segment re-evaluation.
   */
  setUserContext(context: RevTurbineUserContext): void {
    this.sdk.setUserContext(context);
  }

  /** Get the current resolved user context (includes `tenant_id`, `user_id`). */
  getUserContext(): ReturnType<RevTurbineCustomerSdk['getUserContext']> {
    return this.sdk.getUserContext();
  }

  /** Update usage balances (e.g. after a meter event). */
  updateUsage(balances: UsageBalances): void {
    this.sdk.updateUsage(balances);
  }

  /** Fetch full user context from the server (server runtime mode). */
  async fetchUserContext(userId: string): Promise<UserTargetingContext> {
    return this.sdk.fetchUserContext(userId);
  }

  /** Get the current trial status. */
  async getTrialStatus(): Promise<RevTurbineTrialContext> {
    return this.sdk.getTrialStatus();
  }

  /** Get a snapshot of current usage balances. */
  getUsage(): RevTurbineUsageSnapshot {
    return this.sdk.getUsage();
  }

  // ── Placement controllers ──────────────────────────────────────────────

  /**
   * Create a {@link PlacementController} bound to this session's SDK.
   *
   * @example
   * ```ts
   * const banner = session.placement({ surfaceSlot: { id: 'upsell_banner' } });
   * await banner.load();
   * if (banner.visible) { renderBanner(banner.content); }
   * ```
   */
  placement(options: PlacementControllerOptions): PlacementController {
    return new PlacementController(this.sdk, options);
  }

  /**
   * One-shot: register a surface slot, fetch a decision, and return it.
   *
   * For repeated use or interaction tracking, prefer {@link placement} which
   * returns a full controller.
   */
  async getPlacementBySlotId(
    slotId: string,
    options?: Omit<PlacementControllerOptions, 'surfaceSlot' | 'placement'>,
  ): Promise<RevTurbinePlacementDecision | null> {
    const ctrl = this.placement({
      ...options,
      surfaceSlot: { id: slotId, name: slotId },
    });
    return ctrl.load();
  }

  /**
   * Get a raw placement output by request config (slot, entitlement, plan, or chained).
   * Returns the full {@link PlacementOutput} or `null`.
   */
  async getPlacement(config: RevTurbinePlacementRequestConfig): Promise<PlacementOutput | null> {
    return this.sdk.getPlacement(config);
  }

  // ── Entitlement controllers ────────────────────────────────────────────

  /**
   * Create an {@link EntitlementGate} bound to this session's SDK.
   *
   * @example
   * ```ts
   * const gate = session.entitlement({ handle: 'brand_kit', autoGate: true });
   * await gate.check();
   * if (gate.denied) { showGate(gate.gatedPlacement); }
   * ```
   */
  entitlement(options: EntitlementGateOptions): EntitlementGate {
    return new EntitlementGate(this.sdk, options);
  }

  /**
   * One-shot entitlement check. For auto-gating or reactive updates,
   * prefer {@link entitlement} which returns a full controller.
   */
  async checkEntitlement(
    handle: string,
    context?: RevTurbineEntitlementContext,
  ): Promise<EntitlementResult> {
    return this.sdk.checkEntitlement(handle, context);
  }

  // ── Events ─────────────────────────────────────────────────────────────

  /** Track a custom event. */
  async trackEvent(name: string, data?: Record<string, JsonObject[string]>): Promise<void> {
    return this.sdk.trackEvent(name, data);
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a fully-initialized SDK session.
 *
 * This is the recommended entry point for headless (non-React) consumers.
 * It handles:
 * 1. SDK initialization via `initRevTurbine()`
 * 2. User identification (if `options.user.id` is provided)
 * 3. Theme resolution (from ExportedConfig or API)
 * 4. Placement bootstrapping (preloading decisions)
 *
 * The returned {@link SdkSession} exposes the full imperative API:
 * user context management, placement controllers, entitlement gates,
 * and event tracking.
 *
 * @example
 * ```ts
 * const session = await initRevTurbine({
 *   tenantId: 'tenant_abc',
 *   apiKey: 'rt_live_xxx',
 *   endpoint: 'https://api.revturbine.io',
 *   user: { id: 'user_123', plan: { id: 'pro' } },
 *   bootstrapPlacements: [
 *     { placement: { name: 'pricing_banner' } },
 *   ],
 * });
 * ```
 */
export async function initRevTurbine(options: SdkSessionOptions): Promise<SdkSession> {
  const { bootstrapPlacements, ...rest } = options;
  const initOptions = rest as RevTurbineInitInputOptions;
  const sdk = initRevTurbineCore(initOptions);

  // Identify user if provided
  const user = initOptions.user;
  if (user && typeof user === 'object' && (user as { id?: string }).id) {
    sdk.identify((user as { id: string }).id, user as UserContextInput);
  }

  // Resolve theme
  let theme: RevTurbineTheme = DEFAULT_THEME;
  const exportedConfig = initOptions.localRuntime?.exportedConfig;
  const configTheme = exportedConfig?.theme;

  if (configTheme && typeof configTheme === 'object') {
    theme = mergeTheme(configTheme as RevTurbineThemeInput);
  } else {
    theme = await loadTheme(
      {
        tenantId: initOptions.tenantId ?? 'local',
        endpoint: initOptions.endpoint ?? 'https://api.revturbine.local',
        apiKey: initOptions.apiKey ?? 'local-only',
      },
    );
  }

  // Bootstrap placements
  if (bootstrapPlacements && bootstrapPlacements.length > 0) {
    const sdkUserId = sdk.getUserContext().user_id;
    const preloads = [];

    for (const item of bootstrapPlacements) {
      const placementId = await sdk.registerPlacement(item.placement);
      const userId = item.userId || sdkUserId;
      if (!userId) continue;
      preloads.push({
        placementId,
        userId,
        contextMode: item.contextMode,
        overrides: item.overrides,
        traits: item.traits,
        ttlMs: item.ttlMs,
      });
    }

    if (preloads.length > 0) {
      await sdk.bootstrapPlacementDecisions(preloads);
    }
  }

  return new SdkSession(sdk, theme);
}
