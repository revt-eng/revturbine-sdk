/**
 * Headless SDK controllers — framework-agnostic orchestration.
 *
 * These classes encapsulate the register → decide → track → interact lifecycle
 * that the React hooks implement via `useState`/`useEffect`. Use them from
 * Vue, Svelte, Angular, vanilla JS, or server-side code.
 *
 * @example
 * ```ts
 * import { initRevTurbine, PlacementController, EntitlementGate } from '@revturbine/sdk/headless';
 *
 * const session = await initRevTurbine({
 *   tenantId: 'tenant_abc',
 *   publicKey: 'rtk_…',
 *   endpoint: 'https://edge.example.com',
 *   mode: 'snippet',
 *   user: { id: 'user_123', plan_handle: 'pro' },
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

import type { EventPayloadInput } from '@revt-eng/schema';
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
  Exact,
  UserContextInput,
  SdkMetadata,
  EntitlementResult,
  PlacementOutput,
  UserTargetingContext,
  RevTurbineUsageSnapshot,
  RevTurbineTrialContext,
  RevTurbineUpdateInput,
  UsageBalances,
  JsonObject,
  SdkEventProperties,
  RevTurbinePlaybookLoadState,
} from './customer-side';
import {
  DEFAULT_HOSTED_ENDPOINT,
  initRevTurbine as initRevTurbineCore,
  resolveBrowserPublicKey,
  resolveLocalPlaybook,
} from './customer-side';
import { exposureManager } from './telemetry';
import type { ExposureBasis } from './telemetry';
import type { RevTurbineTheme, RevTurbineThemeInput } from './theme/types';
import { DEFAULT_THEME, mergeTheme } from './theme/defaults';
import { loadTheme } from './theme/theme-loader';

// ── Change listener type ────────────────────────────────────────────────────

/** Callback used to subscribe to state changes in controllers. */
export type ChangeListener = () => void;

/**
 * Additive decision provenance introduced after this SDK's current core pin.
 * Keep the compatibility shape local until the normal dependency cascade
 * reaches the matching core release; the runtime decision may already carry
 * these optional fields without making older decisions invalid.
 */
type MessageBlockDecisionProvenance = PlacementOutput & {
  message_block_handle?: string;
  message_block_id?: string;
};

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
  /**
   * When the presentation-writing `impression` fires (plan 144 TASK-11 / REQ-17).
   * - `legacy_resolution` (default) — at decision resolution, exactly as today.
   * - `render` — when the placement's visual root renders.
   * - `viewport` — when the root scrolls into the viewport; if
   *   `IntersectionObserver` is unavailable it falls back to resolution
   *   (Q-8 ruling), tagged `render_fallback`.
   *
   * Only `viewport` (with `IntersectionObserver` present) moves the
   * `placement_presentations` denominator — a deliberate metric-definition
   * change (see the plan's Q-8 / REQ-17b). The default keeps the denominator and
   * its history unchanged.
   */
  placementExposure?: PlacementExposureMode;
}

/**
 * When the presentation-writing `impression` fires relative to a placement's
 * lifecycle (plan 144 TASK-11). See {@link PlacementControllerOptions.placementExposure}.
 */
export type PlacementExposureMode = 'legacy_resolution' | 'render' | 'viewport';

/**
 * The lifecycle point an `impression` was credited to, recorded on the
 * presentation row's `exposure_basis` (plan 144 TASK-11). `render_fallback` marks
 * a `viewport`-mode impression that fell back to resolution because
 * `IntersectionObserver` was unavailable (AC-10).
 */
export type PresentationBasis = 'legacy_resolution' | 'render' | 'viewport' | 'render_fallback';

/**
 * The slot delivery-diagnostics lifecycle (plan 144 TASK-10 / spec §10.1).
 * `slot_evaluated` fires on every resolution; then exactly one terminal —
 * `slot_filled` / `slot_empty` / `slot_suppressed` — or `slot_error` when
 * resolution fails. These are funnel-denominator signals, not engagement.
 */
export type SlotLifecycleEvent =
  | 'slot_evaluated'
  | 'slot_filled'
  | 'slot_empty'
  | 'slot_suppressed'
  | 'slot_error';

/**
 * How many times one load cycle re-decides after a Playbook load settles
 * (BL-0177).
 *
 * Small on purpose: the SDK already waits out an in-flight load inside
 * `getPlacementDecision`, so this budget only covers a load that outran that
 * bound or a first attempt that failed and a second that succeeded. It is what
 * keeps a provider that never yields a config from re-deciding forever.
 */
const MAX_CONFIG_RETRIES = 2;

/**
 * Entitlement reasons that mean "no Playbook rule covered this handle"
 * (BL-0179).
 *
 * One fact, two mode-specific names: Server mode reports
 * `config_unavailable`, local mode `entitlement_not_in_playbook`. Either one
 * seen while the load state is still `loading` is a race, not a verdict — the
 * load-state check is what keeps `entitlement_not_in_playbook` the honest
 * terminal verdict it has always been once a Playbook IS loaded.
 */
const CONFIG_MISS_REASONS: ReadonlySet<string> = new Set([
  'config_unavailable',
  'entitlement_not_in_playbook',
]);

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
  /**
   * How the placement's visual root came to be considered exposed, or `null`
   * before {@link PlacementController.markVisible} is called (plan 144 TASK-9).
   * `'render_fallback'` when `IntersectionObserver` was unavailable (AC-10).
   */
  readonly exposureBasis: ExposureBasis | null;
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
  private _rendered = false;
  private _exposed = false;
  private _exposureBasis: ExposureBasis | null = null;
  // Dedup key for the slot lifecycle diagnostics (plan 144 TASK-10 / spec §10.1).
  // Re-emits only when the resolved decision identity or outcome changes, so a
  // re-render against the same cached decision stays silent.
  private _lastSlotKey: string | null = null;
  // BL-0177 — a `config_unavailable` decision taken while the Playbook is still
  // in flight is not an answer, it is a race the slot lost. The controller waits
  // for the load to settle and re-decides itself, so no consumer has to.
  private _awaitingConfig = false;
  private _configRetries = 0;
  private _playbookUnsubscribe: (() => void) | null = null;

  constructor(sdk: RevTurbineCustomerSdk, options: PlacementControllerOptions) {
    this.sdk = sdk;
    this.options = options;
  }

  /**
   * Stop listening for Playbook loads. Idempotent; call it when the owning
   * component unmounts (`usePlacement` does).
   */
  dispose(): void {
    this._playbookUnsubscribe?.();
    this._playbookUnsubscribe = null;
    this._awaitingConfig = false;
  }

  /**
   * Is this decision a race against a Playbook load rather than a verdict?
   *
   * `config_unavailable` carries both meanings (see
   * `RevTurbinePlaybookLoadState`). Only the transient one is retried, and only
   * while the retry budget holds — a provider that never produces a config must
   * settle into the honest fallback instead of re-deciding forever.
   */
  private isTransientConfigMiss(decision: RevTurbinePlacementDecision): boolean {
    if (!decision.reasonCodes?.includes('config_unavailable')) return false;
    if (this._configRetries >= MAX_CONFIG_RETRIES) return false;
    return this.sdk.getPlaybookLoadState() === 'loading';
  }

  /**
   * Re-decide once a Playbook load attempt settles, if the decision we are
   * holding was only a config race and a config is now available.
   *
   * Bounded three ways: only while the held decision says
   * `config_unavailable`, only when the settled state is `ready`, and never
   * more than {@link MAX_CONFIG_RETRIES} times per load cycle. A successful
   * re-decide clears the reason, which ends the cycle on its own.
   */
  private handlePlaybookSettled(): void {
    if (!this._decision?.reasonCodes?.includes('config_unavailable')) {
      this.dispose();
      return;
    }
    if (this._configRetries >= MAX_CONFIG_RETRIES || this.sdk.getPlaybookLoadState() !== 'ready') {
      // Nothing more is coming — finalize the fallback we already hold so the
      // slot stops reporting "loading" (and emits its diagnostics honestly).
      if (this.sdk.getPlaybookLoadState() !== 'loading') this.finalizeAwaitedConfig();
      return;
    }
    this._configRetries += 1;
    this.dispose();
    void this.load();
  }

  /**
   * Give up waiting: publish the `config_unavailable` decision as the answer,
   * with the lifecycle + slot diagnostics that were withheld while a retry was
   * still expected.
   */
  private finalizeAwaitedConfig(): void {
    if (!this._awaitingConfig) return;
    this._awaitingConfig = false;
    this._isLoading = false;
    this.dispose();
    this.emitPlacementLifecycle('placement_resolved', null);
    this.emitSlotResolution();
    this.notify();
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
      exposureBasis: this._exposureBasis,
    };
  }

  /** The configured exposure mode (plan 144 TASK-11). Defaults to `legacy_resolution`. */
  private get exposureMode(): PlacementExposureMode {
    return this.options.placementExposure ?? 'legacy_resolution';
  }

  /**
   * Called when the placement's visual root renders (plan 144 TASK-11). Emits
   * `placement_rendered` once, and under `placementExposure: 'render'` credits
   * the presentation now. Idempotent.
   */
  markRendered(): void {
    if (this._rendered) return;
    this._rendered = true;
    this.emitPlacementLifecycle('placement_rendered', null);
    if (this.exposureMode === 'render') this.fireImpression('render');
    this.notify();
  }

  /**
   * Called by the viewport-exposure substrate when the placement's visual root
   * first enters the viewport — or immediately with `'render_fallback'` when
   * `IntersectionObserver` is unavailable (plan 144 TASK-9/11 / AC-9, AC-10).
   * Emits `placement_exposed` once with the basis, and under
   * `placementExposure: 'viewport'` a viewport exposure credits the presentation
   * here (Q-8). Idempotent.
   *
   * @param basis - how exposure was established; defaults to `'viewport'`
   */
  markVisible(basis: ExposureBasis = 'viewport'): void {
    if (this._exposed) return;
    this._exposed = true;
    this._exposureBasis = basis;
    this.emitPlacementLifecycle('placement_exposed', basis);
    // A true viewport exposure moves the impression here (Q-8); a
    // `render_fallback` does not — the resolution-time fallback already fired it.
    if (this.exposureMode === 'viewport' && basis === 'viewport') {
      this.fireImpression('viewport');
    }
    this.notify();
  }

  /**
   * Fire the presentation-writing `impression` (→ `placement_presentations`)
   * once, tagged with the lifecycle basis it was credited at (plan 144 TASK-11).
   * Honors `autoTrackImpression: false` and only fires for a visible decision.
   * Best-effort — telemetry never breaks a placement.
   */
  private fireImpression(basis: PresentationBasis): void {
    const decision = this._decision;
    if (!decision?.visible || this._impressionTracked) return;
    if (this.options.autoTrackImpression === false) return;
    const userId = this.options.userId || this.sdk.getUserContext().user_id;
    if (!userId) return;
    this._impressionTracked = true;
    const output = decision.output as MessageBlockDecisionProvenance | undefined;
    void this.sdk.trackTreatmentInteraction({
      userId,
      placementId: this._placementId,
      interactionType: 'impression',
      // Presentation context from the decision → placement_presentations (plan 114).
      surfaceSlotId: decision.output?.surface?.slot_id,
      surfaceTemplateId: decision.output?.surface?.template,
      payloadId: decision.output?.output_id,
      // Message attribution (plan 182). The resolver stamps the canonical
      // handle, plus a version id only when it genuinely knows one.
      messageBlockHandle: output?.message_block_handle,
      messageBlockId: output?.message_block_id,
      // Experiment attribution (plan 183). Read off the decision that produced
      // this treatment, so `experiment_perf` / `message_impact_by_variant` key
      // correctly without customer code supplying anything. Undefined when the
      // user is not enrolled — which stays distinct from being in control.
      experimentId: decision.output?.experiment_id,
      variantKey: decision.output?.variant_key,
      // BL-0182: the impression is an interaction like the rest, and the
      // decision that produced it is right here. `emitPlacementLifecycle`
      // beside this already stamps the same `rule_id` (BL-0062 / #389); the
      // interaction path was the one that did not.
      ruleHandle: decision.output?.rule_id,
      metadata: {
        decision_source: decision.decisionSource,
        exposure_basis: basis,
        decision_id: decision.output?.decision_id ?? null,
      },
    });
  }

  /**
   * Emit a placement lifecycle signal (`placement_rendered` / `placement_exposed`)
   * with decision provenance (plan 144 TASK-11). Best-effort.
   */
  private emitPlacementLifecycle(
    event: 'placement_resolved' | 'placement_rendered' | 'placement_exposed',
    basis: ExposureBasis | null,
  ): void {
    const decision = this._decision;
    try {
      void this.sdk.emitPlatformEvent(event, {
        placement_id: this._placementId,
        surface_slot_id: decision?.output?.surface?.slot_id ?? null,
        payload_id: decision?.output?.output_id ?? null,
        // Lifted to the wire `decision_id` column so every event caused by one
        // decision correlates (plan 144 TASK-10 / REQ-8).
        decision_id: decision?.output?.decision_id ?? null,
        decision_source: decision?.decisionSource ?? null,
        // BL-0062 (gap G3): the placement rule that won. It has been sitting on
        // `decision.output.rule_id` since plan 138 — the resolver selects it and
        // `customer-side.ts` already reads it as the treatment id — and was
        // never projected onto the event recording the verdict. Attribution
        // stamps the winning touch's rule key onto a movement, so exposure and
        // outcome need it, not just the resolve.
        rule_handle: decision?.output?.rule_id ?? null,
        ...(basis ? { exposure_basis: basis } : {}),
      }, { immediate: false });
    } catch {
      // Best-effort telemetry — never surface a placement error from this.
    }
  }

  /**
   * Shared slot-lifecycle context (plan 144 TASK-10 / spec §10.1): the slot
   * identity, resolved decision facts, and the lifted `decision_id`. Best-effort
   * fields default to `null` before a decision resolves.
   */
  // Return type inferred: the literal shape must satisfy the slot events'
  // payload contract, which the typed emit surface checks at compile time.
  private slotContext() {
    const decision = this._decision;
    const slot = this.options.surfaceSlot;
    return {
      surface_slot_id: decision?.output?.surface?.slot_id ?? slot?.id ?? null,
      slot_name: slot?.name ?? null,
      template_ids: slot?.surfaceTemplateIds ?? null,
      template_id: decision?.output?.surface?.template ?? null,
      surface_type: decision?.output?.surface?.type ?? null,
      category: decision?.output?.category ?? null,
      decision_source: decision?.decisionSource ?? null,
      reason_codes: decision?.reasonCodes ?? [],
      // Lifted → wire `decision_id` column so slot diagnostics correlate to the
      // decision that produced them (plan 144 TASK-10 / REQ-8).
      decision_id: decision?.output?.decision_id ?? null,
      // BL-0062 (gap G3): which placement rule won this slot. `slot_filled`
      // names it; `slot_empty` / `slot_suppressed` leave it null, because
      // nothing won. `reason_codes` beside it says WHY a slot resolved as it
      // did and never WHOSE rule it was.
      rule_handle: decision?.output?.rule_id ?? null,
    };
  }

  /**
   * Emit the slot resolution diagnostics (plan 144 TASK-10 / spec §10.1): always
   * `slot_evaluated`, then exactly one terminal — `slot_filled` (visible),
   * `slot_suppressed` (a cap/cooldown/explicit suppression), or `slot_empty`
   * (nothing matched). Deduped for the decision-cache lifetime and best-effort:
   * these are funnel-denominator signals, not engagement, and must never break a
   * placement. `slot_error` is emitted separately from `load()`'s catch.
   */
  private emitSlotResolution(): void {
    const decision = this._decision;
    const terminal: SlotLifecycleEvent = decision?.visible
      ? 'slot_filled'
      : decision?.suppressionReason
        ? 'slot_suppressed'
        : 'slot_empty';
    // Dedup on slot + resolved-decision identity + outcome, so re-loading the
    // same cached decision (same requestId) stays silent, but a fresh decision
    // or a changed outcome re-emits (spec §10.1 dedup-within-cache-lifetime).
    const key = `${this._placementId}|${decision?.output?.decision_id ?? decision?.requestId ?? ''}|${terminal}`;
    if (this._lastSlotKey === key) return;
    this._lastSlotKey = key;
    const context = this.slotContext();
    this.emitSlotEvent('slot_evaluated', context);
    this.emitSlotEvent(terminal, context);
  }

  /**
   * Emit `slot_error` when resolution fails and the additive fallback is used
   * (plan 144 TASK-10 / spec §10.1). Deduped per slot so a retrying loop does not
   * flood. Best-effort.
   */
  private emitSlotError(message: string): void {
    const key = `${this._placementId}|slot_error`;
    if (this._lastSlotKey === key) return;
    this._lastSlotKey = key;
    this.emitSlotEvent('slot_error', { ...this.slotContext(), error: message });
  }

  /** Emit one slot lifecycle event with the shared context. Best-effort. */
  private emitSlotEvent(event: SlotLifecycleEvent, context: EventPayloadInput<SlotLifecycleEvent>): void {
    try {
      // Typed platform lane (plan 228 TASK-4): slot diagnostics are taxonomy
      // vocabulary and must land raw, not through the namespacing generic lane.
      void this.sdk.emitPlatformEvent(event, context, { immediate: false });
    } catch {
      // Best-effort diagnostics — never surface a placement error from this.
    }
  }

  /**
   * Emit `placement_outcome` — the intended CTA outcome completed (plan 144
   * TASK-10 / spec §10.3). A treatment-attribution signal distinct from the
   * `cta_completed` interaction: it marks the terminal funnel step with decision
   * provenance. Best-effort.
   */
  private emitPlacementOutcome(ctaTarget: string | null): void {
    const decision = this._decision;
    try {
      void this.sdk.emitPlatformEvent('placement_outcome', {
        placement_id: this._placementId,
        surface_slot_id: decision?.output?.surface?.slot_id ?? null,
        payload_id: decision?.output?.output_id ?? null,
        decision_id: decision?.output?.decision_id ?? null,
        decision_source: decision?.decisionSource ?? null,
        // BL-0062: the outcome fact is what attribution reads, so it carries
        // the winning rule like the rest of the lifecycle.
        rule_handle: decision?.output?.rule_id ?? null,
        outcome: 'cta_completed',
        cta_target: ctaTarget,
      }, { immediate: false });
    } catch {
      // Best-effort telemetry — never surface a placement error from this.
    }
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

      // BL-0177 — the Playbook is still loading and this decision only says so.
      // Stay in `isLoading`, withhold the lifecycle + slot diagnostics (a
      // transient race is not a resolution and must not land in the funnel as
      // `slot_empty`), and re-decide when the load settles.
      if (this.isTransientConfigMiss(decision)) {
        this._awaitingConfig = true;
        this._playbookUnsubscribe ??= this.sdk.onPlaybookSettled(() => { this.handlePlaybookSettled(); });
        return decision;
      }
      this._awaitingConfig = false;
      this.dispose();

      // A decision resolved — emit the lifecycle marker once per load, with
      // decision provenance, regardless of visibility (plan 144 TASK-10).
      this.emitPlacementLifecycle('placement_resolved', null);
      // Slot delivery diagnostics: slot_evaluated + the terminal outcome
      // (filled / empty / suppressed), deduped for the cache lifetime (spec §10.1).
      this.emitSlotResolution();

      // Fire the resolution-time impression only for the modes that credit a
      // presentation at resolution (plan 144 TASK-11). `legacy_resolution` (the
      // default) always does — today's behavior, unchanged. `viewport` does too
      // ONLY when IntersectionObserver is unavailable (Q-8 fallback: emit as we
      // do today), tagged `render_fallback`. `render` and viewport-with-observer
      // defer to markRendered / markVisible.
      const mode = this.exposureMode;
      if (mode === 'legacy_resolution') {
        this.fireImpression('legacy_resolution');
      } else if (mode === 'viewport' && !exposureManager.supported) {
        this.fireImpression('render_fallback');
      }

      return decision;
    } catch (err) {
      if (seq === this._loadSeq) {
        this._error = err instanceof Error ? err.message : 'Failed to load placement decision.';
        // Resolution failed and the additive fallback is used → slot_error (spec §10.1).
        this.emitSlotError(this._error);
      }
      return null;
    } finally {
      if (seq === this._loadSeq) {
        // Still `isLoading` while a config-race retry is pending (BL-0177):
        // reporting a settled `config_unavailable` is what made slots paint a
        // permanent fallback.
        this._isLoading = this._awaitingConfig;
        this.notify();
      }
    }
  }

  /** Re-fetch the placement decision (clears impression + render + exposure tracking). */
  async refresh(): Promise<RevTurbinePlacementDecision | null> {
    this._impressionTracked = false;
    this._rendered = false;
    this._exposed = false;
    this._exposureBasis = null;
    // An explicit refresh is a fresh load cycle, so the config-race budget
    // resets with it (BL-0177).
    this._configRetries = 0;
    return this.load();
  }

  /** Record a dismiss interaction and hide the placement. */
  /**
   * Record a dismissal.
   *
   * @param cooldownMs - Optional explicit window. Omit it — which is the normal
   *   case — and the SDK resolves the payload's authored `caps.cooldown_days`,
   *   falling back to the 7-day default. This used to default to 24h here and
   *   pass it ALWAYS, so the authored value and the 7-day default were both
   *   unreachable from React (plan 233 TASK-8b).
   */
  async dismiss(cooldownMs?: number): Promise<void> {
    await this.trackInteraction(
      'dismiss',
      cooldownMs === undefined ? {} : { cooldown_ms: cooldownMs },
    );
  }

  /** Record a snooze/remind-me-later interaction and hide the placement. */
  /**
   * Record a snooze / remind-me-later.
   *
   * @param seconds - Optional explicit window. Omit it and the SDK resolves the
   *   payload's authored `remind_later_minutes`, falling back to the tenant
   *   default (plan 233 TASK-8c). Remind-later is a DIFFERENT window from
   *   dismiss and resolves independently.
   */
  async snooze(seconds?: number): Promise<void> {
    await this.trackInteraction(
      'remind_me_later',
      seconds === undefined ? {} : { remind_after_seconds: seconds },
    );
  }

  /** Alias for {@link snooze}. */
  async remindMeLater(seconds?: number): Promise<void> {
    await this.snooze(seconds);
  }

  /** Record a CTA click interaction. */
  async ctaClick(ctaTarget?: string): Promise<void> {
    await this.trackInteraction('cta_clicked', { cta_target: ctaTarget || null });
  }

  /** Record a CTA completion interaction and hide the placement. */
  async ctaComplete(ctaTarget?: string): Promise<void> {
    await this.trackInteraction('cta_completed', { cta_target: ctaTarget || null });
    // The intended CTA outcome completed → terminal treatment-attribution signal
    // (plan 144 TASK-10 / spec §10.3), distinct from the cta_completed interaction.
    this.emitPlacementOutcome(ctaTarget || null);
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
    this._rendered = false;
    this._exposed = false;
    this._exposureBasis = null;
    this._lastSlotKey = null;
    this._loadSeq++;
    this.notify();
  }

  private async trackInteraction(
    interactionType: 'dismiss' | 'remind_me_later' | 'cta_clicked' | 'cta_completed',
    metadata: SdkMetadata,
  ): Promise<void> {
    const resolvedUserId = this.options.userId || this.sdk.getUserContext().user_id;
    if (!this._placementId || !resolvedUserId) return;

    // decision_id correlates the interaction to its decision → wire provenance
    // column (plan 144 TASK-10). Added only when the decision carries one, so
    // interactions without a decision keep their bare metadata shape.
    const decisionId = this._decision?.output?.decision_id ?? null;
    const output = this._decision?.output as MessageBlockDecisionProvenance | undefined;

    await this.sdk.trackTreatmentInteraction({
      userId: resolvedUserId,
      placementId: this._placementId,
      treatmentId: this._decision?.placementId,
      interactionType,
      // Presentation context from the decision → placement_presentations (plan 114).
      surfaceSlotId: this._decision?.output?.surface?.slot_id,
      surfaceTemplateId: this._decision?.output?.surface?.template,
      payloadId: this._decision?.output?.output_id,
      messageBlockHandle: output?.message_block_handle,
      messageBlockId: output?.message_block_id,
      experimentId: this._decision?.output?.experiment_id,
      variantKey: this._decision?.output?.variant_key,
      // BL-0182: dismiss / remind_me_later / cta_clicked / cta_completed all
      // arrive here, so this one line puts every React and headless click into
      // the rule slice. Undefined when the controller holds no decision —
      // absent, not empty.
      ruleHandle: this._decision?.output?.rule_id,
      metadata: decisionId ? { ...metadata, decision_id: decisionId } : metadata,
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
/**
 * Whether an entitlement result denies access.
 *
 * A result denies when its `status` is `'denied'` OR the evaluator's `allowed`
 * verdict is explicitly `false`. The second clause matters for at-cap limit
 * rules: blocking enforcement — including the unset-enforcement default —
 * resolves `{ status: 'limited', allowed: false }`, and gating on status alone
 * silently granted access at the cap (plan 179 TASK-10; the cold-funnel
 * "cap never blocks" trap). Degrade mode (`limited` + `allowed: true`) stays
 * granted.
 */
export function entitlementResultDenies(result: EntitlementResult | null): boolean {
  return result !== null && (result.status === 'denied' || result.allowed === false);
}

export class EntitlementGate {
  private readonly sdk: RevTurbineCustomerSdk;
  private readonly options: EntitlementGateOptions;
  private readonly listeners = new Set<ChangeListener>();

  private _isLoading = false;
  private _error: string | null = null;
  private _result: EntitlementResult | null = null;
  private _gatedPlacement: PlacementOutput | null = null;
  // Dedup key for the passive gate_evaluated signal (plan 144 TASK-10). Re-emits
  // only when the evaluated outcome actually changes, not on every recheck.
  private _lastEvaluatedKey: string | null = null;
  // BL-0179 — a `config_unavailable` deny taken while the Playbook is still in
  // flight is not a verdict, it is a race the gate lost. It is PARKED here
  // rather than published: `_result` stays null, so `denied` stays false and no
  // `gate_evaluated` is emitted, until the load settles and the gate re-checks.
  private _awaitedResult: EntitlementResult | null = null;
  private _configRetries = 0;
  private _playbookUnsubscribe: (() => void) | null = null;

  constructor(sdk: RevTurbineCustomerSdk, options: EntitlementGateOptions) {
    this.sdk = sdk;
    this.options = options;
  }

  /**
   * Stop listening for Playbook loads. Idempotent; call it when the owning
   * component unmounts (`useEntitlement` does).
   */
  dispose(): void {
    this._playbookUnsubscribe?.();
    this._playbookUnsubscribe = null;
  }

  /** Current state snapshot. */
  get state(): EntitlementGateState {
    return {
      isLoading: this._isLoading,
      error: this._error,
      result: this._result,
      allowed: this._result?.status === 'allowed',
      limited: this._result?.status === 'limited',
      denied: entitlementResultDenies(this._result),
      gatedPlacement: this._gatedPlacement,
    };
  }

  /** Convenience: `true` when the entitlement is allowed. */
  get allowed(): boolean { return this._result?.status === 'allowed'; }
  /** Convenience: `true` when usage is limited (partially exhausted). */
  get limited(): boolean { return this._result?.status === 'limited'; }
  /**
   * Convenience: `true` when the entitlement denies — `status: 'denied'`, or
   * the evaluator's `allowed` verdict is explicitly `false` (an at-cap limit
   * with blocking enforcement resolves `limited` + `allowed: false`; see
   * {@link entitlementResultDenies}).
   */
  get denied(): boolean { return entitlementResultDenies(this._result); }
  /** The raw entitlement result, or `null` before first check. */
  get result(): EntitlementResult | null { return this._result; }
  /** Resolved gated placement when `denied` and `autoGate` are active. */
  get gatedPlacement(): PlacementOutput | null { return this._gatedPlacement; }

  /**
   * Run the entitlement check. If denied and `autoGate` is true,
   * also resolves a gated placement.
   */
  async check(): Promise<EntitlementResult | null> {
    const { handle, context } = this.options;
    this._isLoading = true;
    this._error = null;
    this.notify();

    try {
      const res = await this.sdk.checkEntitlement(handle, context);

      // BL-0179 — the Playbook outran `checkEntitlement`'s own bounded wait and
      // is still loading, so this deny only says "not yet". Park it, stay in
      // `isLoading`, withhold `gate_evaluated` (a lost race is not an
      // evaluation and must not land in the gate funnel as a denial), and
      // re-check when the load settles.
      if (this.isTransientConfigMiss(res)) {
        const unsubscribe = this._playbookUnsubscribe ?? this.subscribeToPlaybookSettled();
        if (unsubscribe) {
          this._playbookUnsubscribe = unsubscribe;
          this._awaitedResult = res;
          return res;
        }
        // Cannot subscribe (a test double without `onPlaybookSettled`): nothing
        // would ever wake this gate, so publish the deny rather than park it.
      }

      this._awaitedResult = null;
      this.dispose();
      // A real verdict ends the cycle, so the next race starts with a full
      // budget (a context change re-checks through this path).
      if (!CONFIG_MISS_REASONS.has(res.reason ?? '')) this._configRetries = 0;
      await this.publishResult(res);
      return res;
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._gatedPlacement = null;
      this._awaitedResult = null;
      this.dispose();
      return null;
    } finally {
      // Still `isLoading` while a config-race re-check is pending (BL-0179):
      // publishing a transient `config_unavailable` as a settled deny is what
      // made gates paint a permanent paywall.
      this._isLoading = this._awaitedResult !== null;
      this.notify();
    }
  }

  /**
   * Re-run the entitlement check (alias of {@link check}).
   *
   * An explicit recheck is a fresh cycle, so the config-race budget resets with
   * it (BL-0179) — the caller asking again is not the SDK retrying itself.
   */
  async recheck(): Promise<EntitlementResult | null> {
    this._configRetries = 0;
    return this.check();
  }

  /**
   * Publish a settled entitlement result: the state, the passive telemetry, and
   * the auto-gated placement.
   *
   * Extracted so the first-pass check and the post-config-wait finalize
   * (BL-0179) cannot drift apart — a second copy is how a re-check ends up
   * skipping the `gate_evaluated` emit or the `autoGate` resolution.
   */
  private async publishResult(res: EntitlementResult): Promise<void> {
    const { handle, autoGate, gatePlacementRequest } = this.options;
    this._result = res;

    // Passive evaluation → `gate_evaluated` (plan 144 TASK-10 / REQ-20, AC-11).
    // NEVER `gate_attempted` — that names an active, user-invoked gate run
    // (useGatedAction, TASK-14). `gate_limited` / `gate_denied` are not
    // separate emissions: the outcome field carries the status, which the
    // existing `limited` state and `onDenied` callback already surface.
    // Deduped so a recheck with an unchanged outcome stays quiet; best-effort
    // so a telemetry hiccup never breaks the gate.
    this.emitGateEvaluated(handle, res);

    if (!autoGate || !entitlementResultDenies(res)) {
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
  }

  /**
   * Is this deny a race against a Playbook load rather than a verdict?
   *
   * Two conditions, both required. The reason must name a config miss —
   * `config_unavailable` in Server mode, `entitlement_not_in_playbook` in
   * local mode, which is the same fact under a mode-specific name — AND the
   * load state must still be `loading`. Once a Playbook is loaded the state is
   * `ready` and `entitlement_not_in_playbook` is the honest terminal verdict it
   * has always been; this never reinterprets it.
   *
   * Bounded by {@link MAX_CONFIG_RETRIES}: a provider that never yields a
   * config must settle into the fail-closed deny instead of re-checking
   * forever.
   */
  private isTransientConfigMiss(res: EntitlementResult): boolean {
    if (!CONFIG_MISS_REASONS.has(res.reason ?? '')) return false;
    if (!entitlementResultDenies(res)) return false;
    if (this._configRetries >= MAX_CONFIG_RETRIES) return false;
    return this.playbookLoadState() === 'loading';
  }

  /**
   * Re-check once a Playbook load attempt settles, if the deny we parked was
   * only a config race and a config is now available (BL-0179).
   *
   * Bounded three ways, mirroring `PlacementController`: only while a parked
   * deny exists, only when the settled state is `ready`, and never more than
   * {@link MAX_CONFIG_RETRIES} times.
   */
  private handlePlaybookSettled(): void {
    if (!this._awaitedResult) {
      this.dispose();
      return;
    }
    const state = this.playbookLoadState();
    if (this._configRetries >= MAX_CONFIG_RETRIES || state !== 'ready') {
      // Nothing more is coming — publish the deny we are holding so the gate
      // stops reporting `isLoading` and reports it honestly.
      if (state !== 'loading') void this.finalizeAwaitedConfig();
      return;
    }
    this._configRetries += 1;
    this.dispose();
    void this.check();
  }

  /**
   * Give up waiting: publish the parked `config_unavailable` deny as the
   * answer, with the `gate_evaluated` emit that was withheld while a re-check
   * was still expected.
   */
  private async finalizeAwaitedConfig(): Promise<void> {
    const parked = this._awaitedResult;
    if (!parked) return;
    this._awaitedResult = null;
    this.dispose();
    try {
      await this.publishResult(parked);
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._gatedPlacement = null;
    } finally {
      this._isLoading = false;
      this.notify();
    }
  }

  /**
   * Read the SDK's Playbook load state, degrading to `null` on a hand-rolled
   * test double that predates it — same contract as {@link watchUserContext}:
   * an SDK that can break the host app's render has failed at its one hard
   * guarantee. A `null` state is never transient, so such a double keeps
   * today's fail-closed behaviour exactly.
   */
  private playbookLoadState(): RevTurbinePlaybookLoadState | null {
    const read = (this.sdk as Partial<RevTurbineCustomerSdk>).getPlaybookLoadState;
    return typeof read === 'function' ? read.call(this.sdk) : null;
  }

  /** Subscribe to Playbook load settles, degrading on an older test double. */
  private subscribeToPlaybookSettled(): (() => void) | null {
    const subscribe = (this.sdk as Partial<RevTurbineCustomerSdk>).onPlaybookSettled;
    if (typeof subscribe !== 'function') return null;
    return subscribe.call(this.sdk, () => { this.handlePlaybookSettled(); });
  }

  /**
   * Emit the passive `gate_evaluated` signal for a resolved entitlement result
   * (plan 144 TASK-10). Deduped on handle+outcome for the gate's lifetime, and
   * best-effort — telemetry must never break a gate check.
   */
  private emitGateEvaluated(handle: string, res: EntitlementResult): void {
    const key = `${handle}|${res.status}`;
    if (this._lastEvaluatedKey === key) return;
    this._lastEvaluatedKey = key;
    try {
      void this.sdk.emitPlatformEvent('gate_evaluated', {
        entitlement_handle: handle,
        outcome: res.status, // 'allowed' | 'limited' | 'denied'
        gated: entitlementResultDenies(res),
        reason: res.reason ?? null,
        limit: res.limit ?? null,
        used: res.used ?? null,
        remaining: res.remaining ?? null,
        // BL-0062 (gap G3): the rule whose limit/enablement produced `outcome`.
        // This is not local plumbing — until scaffold v0.1.337 the winner was
        // discarded inside `deriveLocalEntitlementFromConfiguredRules`, five
        // frames below this emit, so there was nothing here to read. The result
        // now carries it and the event names it.
        rule_handle: res.rule_handle ?? null,
      }, { immediate: false });
    } catch {
      // Best-effort telemetry — never surface a gate error from this.
    }
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Re-evaluate whenever the user context changes (plan 194 REQ-3).
   *
   * `notify()` fires only from inside `check()` — it announces this gate's own
   * re-check and never knew a context change had happened. So after
   * `update({ usage: … })` the SDK returned `denied` while a mounted gate kept
   * rendering granted children, and only a remount or a manual `recheck()`
   * fixed it.
   *
   * Only re-checks a gate that has already produced a result: before the first
   * `check()` there is nothing on screen to be stale, and firing then would
   * turn every `identify()` at startup into a redundant evaluation.
   *
   * Returns an unsubscribe function. Call it when the gate is discarded —
   * without that, a gate outlives its consumer and keeps re-checking.
   */
  watchUserContext(): () => void {
    // `onUserContextChange` is new in this release, and `RevTurbineCustomerSdk`
    // is a class consumers hand-roll test doubles for. A double built against
    // the previous surface would otherwise throw from inside a React effect —
    // and an SDK that can break the host app's render has failed at its one
    // hard guarantee. Degrade to the pre-subscription behaviour instead.
    const subscribe = (this.sdk as Partial<RevTurbineCustomerSdk>).onUserContextChange;
    if (typeof subscribe !== 'function') return () => {};

    return subscribe.call(this.sdk, () => {
      if (this._result === null && !this._isLoading) return;
      void this.check();
    });
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
 *   publicKey: 'rtk_…',
 *   endpoint: 'https://edge.example.com',
 *   mode: 'snippet',
 *   user: { id: 'user_123', plan_handle: 'pro' },
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
 * session.identify('user_456', { plan_handle: 'enterprise' });
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

  /**
   * Patch the session-scoped user context — the whole-context-minus-`id`
   * upsert (`update({ plan: {...} })`, `update({ usage: {...} })`, …).
   * Alias of the SDK's `update()`, promoted onto the session facade so the
   * documented `session.update()` verb is real (plan 179 Q-1/Q-3 ruling).
   * Unrecognized keys warn (prod-visible, once per session) and drop, exactly
   * as on the SDK — plan 191 Q-5 made the warning prod-visible rather than
   * dev-only, so this comment was stale in the direction that matters.
   */
  update(patch: RevTurbineUpdateInput): void {
    this.sdk.update(patch);
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

  /**
   * The entitlement check as a `can` question — alias of
   * {@link checkEntitlement}, promoted onto the session facade so
   * `session.can('batch_export')` works without the `session.sdk` escape
   * hatch (plan 179 Q-1/Q-3 ruling). Read `.allowed` for the verdict; an
   * at-cap blocked limit resolves `limited` + `allowed: false`.
   */
  async can(
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

  /**
   * Track an event — the advertised alias of {@link trackEvent}, first-class
   * on the session facade so headless code carries the full telemetry surface
   * (plan 179 ruling, Kent 2026-08-13). Powers analytics, frequency caps,
   * attribution, and experiments.
   */
  track(name: string, data?: Record<string, JsonObject[string]>): Promise<void> {
    return this.sdk.track(name, data);
  }

  /**
   * Flush buffered events immediately. Headless processes are often
   * short-lived (scripts, jobs, edge handlers) — call this before exit so
   * buffered `track()` events aren't lost with the process.
   */
  async flushEvents(): Promise<void> {
    return this.sdk.flushEvents();
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
 * 3. Theme resolution (from RevTurbineConfig or API)
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
 *   publicKey: 'rtk_…',
 *   endpoint: 'https://edge.example.com',
 *   mode: 'snippet',
 *   user: { id: 'user_123', plan_handle: 'pro' },
 *   bootstrapPlacements: [
 *     { placement: { name: 'pricing_banner' } },
 *   ],
 * });
 * ```
 *
 * @public
 */
export async function initRevTurbine<TUser extends RevTurbineUserContext = RevTurbineUserContext>(
  options: SdkSessionOptions & { user?: Exact<RevTurbineUserContext, TUser> },
): Promise<SdkSession> {
  const { bootstrapPlacements, ...rest } = options;
  const initOptions = rest as RevTurbineInitInputOptions;
  const sdk = initRevTurbineCore(initOptions);

  // Identify user if provided
  const user = initOptions.user;
  if (user && typeof user === 'object' && user.id) {
    const { id, ...context } = user;
    sdk.identify(id, context as UserContextInput);
  }

  // Resolve theme
  let theme: RevTurbineTheme = DEFAULT_THEME;
  const playbook = resolveLocalPlaybook(initOptions.localRuntime);
  const configTheme = playbook?.theme;

  if (configTheme && typeof configTheme === 'object') {
    theme = mergeTheme(configTheme as RevTurbineThemeInput);
  } else {
    theme = await loadTheme(
      {
        tenantId: initOptions.tenantId ?? 'local',
        endpoint: initOptions.endpoint ?? (playbook ? 'https://api.revturbine.local' : DEFAULT_HOSTED_ENDPOINT),
        apiKey: resolveBrowserPublicKey(initOptions) ?? 'local-only',
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
