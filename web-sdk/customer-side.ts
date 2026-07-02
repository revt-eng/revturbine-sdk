import { DomainProviderRegistry } from './providers/registry';
import type { AnyDomainProvider } from './providers/types';
import { isServer, isBrowser } from './env';
import { redactPii, redactIdentityField } from './pii-redact';
import { evaluateSegments } from './segments';
import { buildControlPlaneEvent } from './control-plane-events';
import type { ControlPlaneEventType } from './control-plane-events';
import type { RevTurbineStorage } from './storage';
import { resolvePersistentStorage, resolveSessionStorage } from './storage';
import type {
  ServerEvaluationPayload as GeneratedServerEvaluationPayload,
  PlacementDecisionOutput,
  EntitlementStatus as SchemaEntitlementStatus,
  EntitlementCheckResult,
  RevTurbineConfig,
  RevTurbineConfigPlacementItem,
  RevTurbineConfigSegmentsItem,
  RevTurbineConfigSegmentsItemPredicatesItem,
  ContentUiPath,
  UserContext,
  UserTrialStatus,
  UserUsageEntry,
  UserPlanContext,
  SurfaceType,
  TriggerEventType,
  TrackEvent,
} from '@revt-eng/schema';
import {
  SurfaceTypeSchema,
  TriggerEventTypeSchema,
} from '@revt-eng/schema';
import type { components } from './generated/openapi';
import { version as SDK_VERSION } from './package.json';
import type {
  InteractionState,
  PresentationCapState,
  PlacementCapPolicy,
  PlacementCapRule,
  CapPeriod,
  LocalLookupParts,
  CapCheckResult,
  EntitlementCheckInput,
  HelperTrialContext,
  JsonValue,
  JsonObject,
  PredicateEvaluationResult,
} from '@revt-eng/core';
import {
  ImpressionHistory,
  StorageImpressionStore,
  // ── Pure helpers (from core/helpers.ts) ──
  isRecord,
  ensureArray,
  firstStringValue,
  parseNumberish,
  normalizedRoute,
  sanitizeSlug as coreSanitizeSlug,
  normalizeEventType,
  parseCapRule,
  periodWindowStart,
  parseLocalLookupKey,
  planTargetAliases,
  placementTargetPlanIds,
  placementMatchesPlanTarget,
  usageTokenPrefixFromEntitlementId,
  sanitizeUsageTokenPrefix,
  looksGenericUsageUnit,
  usageAmountsFromEntries,
  configuredPlanNameFromExportedConfig,
  parseExportedConfigOrThrow,
  categoryBucket,
  placementScore,
  placementPriority,
  serverOrder,
  milestoneVersion,
  supersededVersions,
  stableStringify,
  validateTrialStatusShape,
  // ── Crypto helpers ──
  base64UrlFromBytes,
  fallbackHashBase64Url,
  // ── Evaluation helpers ──
  evaluatePredicateVerbose,
  // ── Lifecycle pure functions ──
  mergeUserContext as coreMergeUserContext,
  toSegmentEvaluationTraits as coreToSegmentEvaluationTraits,
  buildTargetingState as coreBuildTargetingState,
  generatePlacementId as coreGeneratePlacementId,
  localPlacementLookupKey as coreLocalPlacementLookupKey,
  decisionCacheKey as coreDecisionCacheKey,
  applyCategoryConflictSuppression as coreApplyCategoryConflictSuppression,
  resolveLocalPlacementFromCandidates as coreResolveLocalPlacementFromCandidates,
  normalizeDecisionFromResponse as coreNormalizeDecisionFromResponse,
  normalizePlacementOutput as coreNormalizePlacementOutput,
  extractPlacementCapPolicies as coreExtractPlacementCapPolicies,
  checkPlacementCaps,
  interactionStateKey as coreInteractionStateKey,
  suppressionForState as coreSuppression,
  deriveLocalEntitlementFromConfiguredRules as coreDeriveLocalEntitlement,
  normalizeEntitlementResult as coreNormalizeEntitlementResult,
  usageThresholdForEntitlement as coreUsageThreshold,
  evaluateUsageThresholdCrossings as coreEvaluateUsageCrossings,
  deriveTrialTriggerStage as coreDeriveTrialStage,
  recalculateDerivedUsageTokens,
  getPersonalizationTokens as coreGetPersonalizationTokens,
  getUsage as coreGetUsage,
} from '@revt-eng/core';
import { PlacementTypeRegistry } from './placements/registry';
import { registerBuiltinSlotTypes } from './placements/builtin';
import {
  resolveRecommendedPlanTokens,
  type RecommendationStrategy,
} from './placements/recommendation';
import {
  createStaticPlacementResolver,
  type LocalPlacementDataset,
} from './placements/local-resolver';

// ── Semantic type aliases ─────────────────────────────────────────────────────
// These replace raw `Record<string, unknown>` and `unknown` with named types
// that communicate intent and satisfy the SDK type-safety gate.

// Re-export core JSON types for public SDK surface
export type { JsonValue, JsonObject } from '@revt-eng/core';

/** Extensible metadata bag attached to placements, events, and interactions. */
export type SdkMetadata = Record<string, JsonValue>;

/** User-provided traits or custom context (inherently untyped from customer code). */
export type SdkTraits = Record<string, JsonValue>;

/** Properties attached to analytics events. */
export type SdkEventProperties = Record<string, JsonValue>;

// --- Provider Pattern Types ---
export interface RevTurbineSdkProvider {
  getPlacement?: (config: RevTurbinePlacementRequestConfig) => Promise<PlacementOutput | null>;
  checkEntitlement?: (handle: string, context?: RevTurbineEntitlementContext) => Promise<EntitlementResult>;
  persistPlacementTypes?: (types: RevTurbinePlacementTypeEntity[]) => Promise<void>;
  identify?: (userId: string, contextOrTraits?: UserContextInput | SdkTraits) => void;
}

export type RevTurbineProviderFactory = (options: RevTurbineInitOptions) => RevTurbineSdkProvider;

export type RevTurbineProviderFailureSlotBehavior = 'placeholder' | 'invisible';

interface RevTurbineProviderOptionAugmentations {
  provider?: RevTurbineSdkProvider | RevTurbineProviderFactory;
  providerFallbacks?: Array<RevTurbineSdkProvider | RevTurbineProviderFactory>;
}

export type RevTurbineInitWithProviderOptions = RevTurbineInitOptions & RevTurbineProviderOptionAugmentations;

/**
 * Minimal initialization options for local-only mode.
 *
 * When `localRuntime.exportedConfig` is provided, core transport options can be
 * omitted and the SDK will inject safe local defaults.
 */
export type RevTurbineLocalOnlyMinimalInitOptions = Omit<
  RevTurbineInitOptions,
  'tenantId' | 'apiKey' | 'endpoint' | 'mode' | 'runtimeMode' | 'localRuntime'
> & {
  tenantId?: string;
  apiKey?: string;
  endpoint?: string;
  mode?: RevTurbineSdkMode;
  runtimeMode?: 'local_only';
  localRuntime: RevTurbineLocalRuntimeOptions & {
    exportedConfig: RevTurbineConfig;
  };
};

/**
 * Public SDK initialization input.
 *
 * Accepts either full options for any runtime mode, or local-only minimal
 * options when `localRuntime.exportedConfig` is provided.
 */
export type RevTurbineInitInputOptions =
  | RevTurbineInitWithProviderOptions
  | (RevTurbineLocalOnlyMinimalInitOptions & RevTurbineProviderOptionAugmentations);

/**
 * SDK integration mode.
 * - `snippet` — lightweight script tag embed
 * - `react` — React component integration
 * - `iframe` — sandboxed iframe embed
 */
export type RevTurbineSdkMode = 'snippet' | 'react' | 'iframe';

/**
 * Canonical surface type for placement rendering.
 * Re-exported from `@revt-eng/core` — single source of truth.
 */
export type { RevTurbineSurfaceType } from '@revt-eng/core';
import type { RevTurbineSurfaceType } from '@revt-eng/core';

const VALID_SURFACE_TYPES: ReadonlySet<RevTurbineSurfaceType> = new Set<RevTurbineSurfaceType>(
  SurfaceTypeSchema.options,
);

/**
 * Convenience input type for identify / setUserContext calls.
 * Omits the persistence envelope fields (`tenant_id`, `user_id`,
 * `created_at`, `updated_at`) which the SDK populates automatically.
 *
 * @example
 * ```ts
 * sdk.identify('user_123', {
 *   account_id: 'acct_456',
 *   email: 'jane@acme.com',
 *   plan: { id: 'pro', name: 'Professional' },
 *   entitlements: { data_export: true },
 *   custom: { role: 'editor' },
 * });
 * ```
 */
export type UserContextInput = Omit<UserContext, 'id' | 'tenant_id' | 'user_id' | 'created_at' | 'updated_at'>;

/**
 * A placement output returned by the decision engine.
 * Re-exported from `@revt-eng/core`.
 */
export type { PlacementOutput } from '@revt-eng/core';
import type { PlacementOutput } from '@revt-eng/core';

/**
 * Canonical entitlement check status.
 * Re-exported from `@revt-eng/schema`.
 */
export type EntitlementStatus = SchemaEntitlementStatus;

/**
 * Result from an entitlement check.
 * Re-exported from `@revt-eng/core`.
 */
export type { EntitlementResult } from '@revt-eng/core';
import type { EntitlementResult } from '@revt-eng/core';

export type { RevTurbineEntitlementContext } from '@revt-eng/core';
import type { RevTurbineEntitlementContext } from '@revt-eng/core';

export interface RevTurbinePlacementRequestConfig {
  /** Slot identifier used for slot-based decisions. */
  slotId?: string;
  /** Surface type declared by the slot integration point. */
  surfaceType?: RevTurbineSurfaceType;
  /** Entitlement handle used for entitlement-based decisions. */
  entitlementHandle?: string;
  /** Optional plan context when rendering plan-specific placements. */
  planHandle?: string;
  /** Optional placement handle for chaining from a prior CTA path. */
  placementHandle?: string;
  /**
   * When true, restrict candidate resolution to Fixed-category placements
   * only for this call. Use when a slot is reserved for PM-wired content
   * (e.g., a header upgrade button that should never show an RT-initiated
   * nudge). RT-initiated placements (Usage/Trial/Conversion/Retention) are
   * filtered out even if they would otherwise match the slot.
   *
   * Defaults to `false`. See placement-prioritization-logic spec §1 and
   * placement-studio-ui.md Appendix C.2 "Restricting a slot to Fixed".
   */
  fixedOnly?: boolean;
}

/** Tenant-scoped placement type metadata persisted by SDK integrations. */
export interface RevTurbinePlacementTypeEntity {
  id: string;
  label: string;
  description: string;
  surfaceType: RevTurbineSurfaceType;
  priority?: number;
}

/**
 * Current trial status for the identified user.
 *
 * Re-exported from the schema's {@link UserTrialStatus} — uses the
 * canonical snake_case field names (`in_trial`, `trial_type`, etc.)
 * to match the wire format and avoid brittle remapping.
 */
export type RevTurbineTrialContext = UserTrialStatus;

/**
 * Arbitrary key/value metadata persisted with an impression record.
 *
 * Free-form by design — consumers attach whatever context is useful
 * for downstream analytics (CTA type, variant id, surface slot id,
 * experiment arm, etc.). The shape is intentionally untyped because
 * it's a passthrough into the scaffold's ImpressionRecord.metadata
 * field, which is the same type (`Record<string, unknown>`) on the
 * persistence side. Defining the alias here gives the SDK type-
 * safety scan one place to suppress instead of three identical
 * parameter sites.
 */
export type RevTurbineImpressionMetadata = Record<string, unknown>; // sdk-ok: type-definition

/** Map of entitlement handle → current usage count. */
export type UsageBalances = Record<string, number>;

/**
 * Outcome of {@link RevTurbineCustomerSdk.gate} — the advertised `gate(action, fn)`
 * verb. When the action was permitted, `ran` is `true` and `result` holds the
 * callback's return value; otherwise `ran` is `false`, the callback did not run,
 * and the caller should surface the `entitlement` (e.g. render an `<RTSlot>` paywall).
 */
export type RevTurbineGateResult<T> =
  | { ran: true; result: T; entitlement: EntitlementResult }
  | { ran: false; entitlement: EntitlementResult };

/**
 * Input to {@link RevTurbineCustomerSdk.update} — the advertised `update({ usage })`
 * verb. Patches customer-reported usage balances; for identity or full user-context
 * changes use {@link RevTurbineCustomerSdk.identify} / {@link RevTurbineCustomerSdk.setUserContext}.
 */
export interface RevTurbineUpdateInput {
  /** Usage balances to merge into the current snapshot (absolute values). */
  usage?: UsageBalances;
}

/** Usage snapshot entry for a usage unit. */
export interface RevTurbineUsageSnapshotEntry {
  /** Current consumed amount for the usage unit. */
  current: number;
  /** Configured limit for the usage unit when available. */
  limit?: number;
}

/** Map of usage unit -> usage snapshot. */
export type RevTurbineUsageSnapshot = Record<string, RevTurbineUsageSnapshotEntry>;

/** Snapshot of policy-related SDK runtime settings and loaded config metadata. */
export interface RevTurbinePolicySnapshot {
  contextPolicy: Required<RevTurbineContextPolicy>;
  placementBehavior: RevTurbinePlacementBehaviorFlags;
  runtimeMode: RevTurbineRuntimeMode;
  exportedConfigVersion?: string;
}

export type RevTurbinePersonalizationTokens = Record<string, string | number>;

/**
 * Snapshot of the active targeting context used by placement eligibility.
 */
export interface RevTurbineTargeting extends UserTargetingContext {
  /** Segment definitions configured in the active RevTurbineConfig. */
  configuredSegments: RevTurbineConfigSegmentsItem[];
  /** Predicate fields discovered from configured segments (targeting dimensions). */
  configuredTraitFields: string[];
}

/**
 * Payload shape accepted by {@link RevTurbineCustomerSdk.hydrate}.
 *
 * This is a re-export of the generated `ServerEvaluationPayload` from the
 * schema, which is the contract between the server-side SDK's `evaluate()`
 * output and the client-side SDK's hydration input.
 */
export type ServerEvaluationHydrationPayload = GeneratedServerEvaluationPayload;

/**
 * SDK-local user context state.
 *
 * Extends the canonical {@link UserContextInput} with a local `id` field
 * for user identification. The full persistence-ready {@link UserContext}
 * (with `tenant_id`, `user_id`, timestamps) is built by the SDK via
 * {@link RevTurbineCustomerSdk.getUserContext getUserContext()}.
 *
 * `custom` is widened to `Record<string, unknown>` at the SDK boundary
 * for customer convenience; values are narrowed to `TraitValue` when
 * persisted via the API.
 */
export interface RevTurbineUserContext
  extends Omit<
    UserContextInput,
    'custom' | 'entitlements' | 'usage' | 'personalization' | 'derived_computed_at' | 'context_hash'
  > {
  /** Authenticated user identifier. When undefined, the SDK uses an anonymous ID. */
  id?: string;
  /**
   * Server-computed derived-entitlement cache stamp (plan 74). Optional at the
   * SDK input boundary — local mode does not compute it; the control plane
   * populates and round-trips it, defaulting to `null` when absent.
   */
  derived_computed_at?: UserContextInput['derived_computed_at'];
  /**
   * Server-computed user-context hash (plan 74). Optional at the SDK input
   * boundary for the same reason as `derived_computed_at`.
   */
  context_hash?: UserContextInput['context_hash'];
  /** Customer-defined fields for segmentation and personalization. */
  custom?: SdkTraits;
  /** Feature entitlements granted by plan + entitlement rules. */
  entitlements?: Record<string, boolean>;
  /** Usage entries derived from credits / usage_limit entitlements, keyed by handle. */
  usage?: UserContextInput['usage'];
  /**
   * Transient personalization token map.
   *
   * Holds SDK-derived tokens (plan_name, usage_current, etc.) merged with
   * app-provided tokens.  Not persisted — rebuilt on each SDK session.
   * Widened to accept `unknown` at the SDK boundary; narrowed to
   * `string | number` when serialized.
   */
  personalization?: SdkTraits;
}

/** Page-level context automatically inferred or manually set. */
export interface RevTurbinePageContext {
  /** Fully qualified page URL. */
  url?: string;
  /** Document title. */
  title?: string;
  /** HTTP referrer. */
  referrer?: string;
  /** Semantic tags for page classification (e.g. `['pricing', 'upgrade']`). */
  tags?: string[];
}

/**
 * Controls automatic context inference behavior.
 * All flags default to `true` when omitted.
 */
export interface RevTurbineContextPolicy {
  /** Infer anonymous user context from browser APIs. */
  inferUser?: boolean;
  /** Infer page context (URL, title, referrer) from `window.location`. */
  inferPage?: boolean;
  /** Automatically track SPA route changes via History API patching. */
  routerAutoTrack?: boolean;
}

/**
 * Feature flags for placement pipeline behavior that may alter decision semantics.
 *
 * All flags default to `false` to preserve backward compatibility.
 */
export interface RevTurbinePlacementBehaviorFlags {
  /** Enable client-side payload cap enforcement (max-per-period + cooldown precedence). */
  enableClientCapsEnforcement: boolean;
  /** Enable automatic gated placement rendering helpers on entitlement denial. */
  enableAutoGatedPlacement: boolean;
  /** Enable automatic trial lifecycle trigger derivation in local-only mode. */
  enableTrialAutoTriggers: boolean;
}

/** Resolver function for a UI path action type. */
export type RevTurbineUiPathResolver = (uiPath: JsonObject) => void | Promise<void>;

/** Map of `action_type` -> resolver implementation supplied by the customer app. */
export type RevTurbineUiPathResolverMap = Record<string, NonNullable<RevTurbineUiPathResolver>>;

/** Extracts `action_type` string literals from a UI path array type. */
export type RevTurbineUiPathActionTypes<TUiPaths extends readonly unknown[]> = Extract<
  {
    [Index in keyof TUiPaths]: TUiPaths[Index] extends { action_type: infer ActionType }
      ? ActionType
      : never;
  }[number],
  string
>;

/** Resolver map that requires handlers for every `action_type` present in `TUiPaths`. */
export type RevTurbineRequiredUiPathResolvers<TUiPaths extends readonly unknown[]> = {
  [ActionType in RevTurbineUiPathActionTypes<TUiPaths>]: RevTurbineUiPathResolver;
};

/**
 * Compile-time helper for authoring complete UI-path resolver maps.
 *
 * When `uiPaths` is provided as a `const` array, TypeScript enforces that
 * `resolvers` contains every `action_type` key.
 */
export function defineUiPathResolvers<const TUiPaths extends readonly unknown[]>(
  uiPaths: TUiPaths,
  resolvers: RevTurbineRequiredUiPathResolvers<TUiPaths> & RevTurbineUiPathResolverMap,
): RevTurbineUiPathResolverMap {
  void uiPaths;
  return sanitizeUiPathResolverMap(resolvers, 'defineUiPathResolvers(resolvers)');
}

function sanitizeUiPathResolverMap(
  resolvers: RevTurbineUiPathResolverMap | undefined,
  sourceLabel: string,
): RevTurbineUiPathResolverMap {
  if (!resolvers) return {};

  const normalized: RevTurbineUiPathResolverMap = {};

  for (const [actionType, resolver] of Object.entries(resolvers)) {
    const normalizedActionType = String(actionType || '').trim();
    if (!normalizedActionType) {
      throw new Error(`[RevTurbine] ${sourceLabel} contains an empty action_type key.`);
    }
    if (typeof resolver !== 'function') {
      throw new Error(`[RevTurbine] ${sourceLabel} contains a non-function resolver for action_type '${normalizedActionType}'.`);
    }
    normalized[normalizedActionType] = resolver;
  }

  return normalized;
}

export interface RevTurbineUiPathResolverValidationIssue {
  uiPathId?: string;
  name?: string;
  actionType: string;
  reason: 'missing_resolver' | 'missing_action_type';
}

export interface RevTurbineUiPathResolverValidationReport {
  valid: boolean;
  totalUiPaths: number;
  resolvedUiPaths: number;
  issues: RevTurbineUiPathResolverValidationIssue[];
}

export interface RevTurbineUiPathResolverValidationOptions {
  /** Optional explicit UI path definitions to validate. Defaults to exportedConfig.content_ui_paths. */
  uiPaths?: ContentUiPath[];
  /** Additional action resolver map to validate against for this invocation. */
  resolvers?: RevTurbineUiPathResolverMap;
  /** Include CTA handler provider resolvers from domain providers. Default true. */
  includeProviderHandlers?: boolean;
  /** Throw when missing resolver coverage is detected. Default false. */
  throwOnMissing?: boolean;
}

/**
 * Provider abstraction for RevTurbineConfig access inside the SDK.
 *
 * Local mode typically uses a static provider backed by `localRuntime.exportedConfig`.
 * Other modes can provide custom or REST-backed resolvers via `refresh()`.
 */
export interface RevTurbineConfigProvider {
  /** Return the latest available RevTurbineConfig snapshot. */
  getExportedConfig(): RevTurbineConfig | undefined;
  /** Optionally refresh the snapshot (for example, from a REST API). */
  refresh?(): Promise<RevTurbineConfig | undefined>;
}

/**
 * @deprecated Renamed to {@link RevTurbineConfigProvider} (plan 104). Kept as a
 * back-compat alias so existing integrations keep compiling; will be removed in
 * a future major. Use `RevTurbineConfigProvider`.
 */
export type ExportedConfigProvider = RevTurbineConfigProvider;

/**
 * Options for initializing the RevTurbine SDK.
 *
 * @example
 * ```ts
 * import { initRevTurbine } from '@revt-eng/sdk';
 *
 * const sdk = initRevTurbine({
 *   tenantId: 'tenant_abc',
 *   apiKey: 'rt_live_xxx',
 *   endpoint: 'https://api.revturbine.io',
 *   mode: 'react',
 * });
 * ```
 */
export interface RevTurbineInitOptions {
  /** Your RevTurbine tenant identifier. */
  tenantId: string;
  /** API key for authentication. */
  apiKey: string;
  /**
   * Public ingest key for SDK clickstream ingestion (`POST /api/track`).
   *
   * Mint one in your RevTurbine tenant under **Settings → Ingest keys**.
   * This is a tenant-scoped, embeddable `public` token distinct from
   * {@link apiKey}: it authorizes *only* event ingestion (the
   * `ingest:write` scope) and carries no role authority, so it is safe
   * to ship in client bundles. When omitted, the SDK falls back to
   * {@link apiKey} for the ingest request — but `/api/track` accepts
   * **only** a `public` token, so a non-public `apiKey` fallback will be
   * rejected. Set this for any integration that emits events.
   */
  ingestPublicKey?: string;
  /**
   * Environment identifier stamped on every ingested clickstream event
   * (`TrackEvent.environment_id`, e.g. `'prod'` / `'staging'`). Lets a
   * tenant separate analytics by deployment environment. Defaults to
   * `'default'` when omitted.
   */
  environmentId?: string;
  /**
   * Analytics/clickstream telemetry opt-out.
   *
   * Analytics is **on by default** (`true`). Set to `false` to opt out:
   * the SDK then emits **no** clickstream events to `POST /api/track`
   * across every path (`capture` / `track` / batched flush / page-unload).
   * Locally-registered {@link RevTurbineEventConsumer} adapters and
   * `local_only` runtime state are unaffected — this flag governs only the
   * RevTurbine ingest network call.
   *
   * Note: this opt-out covers the authed clickstream. The separate keyless
   * anonymous SDK-init beacon has its own opt-out ({@link anonymousTelemetry}).
   */
  analytics?: boolean;
  /**
   * Keyless anonymous SDK-init telemetry opt-out (plan 95).
   *
   * When **no** {@link ingestPublicKey} is configured, the SDK sends a single
   * anonymous `sdk_init` beacon to `POST /api/sdk/meta` carrying config-shape
   * **counts only** (number of plans, entitlements, placements, etc.), the SDK
   * version, runtime/schema/bundle versions, and a one-way hashed config id —
   * **never** any user, account, or PII context. It powers RevTurbine's
   * SDK-adoption metrics for installs that haven't wired an ingest key.
   *
   * On by default (`true`). Set to `false` to opt out entirely; the SDK then
   * sends no keyless telemetry. When active, the SDK logs a one-time info
   * console notice naming this flag. Has no effect once an `ingestPublicKey`
   * is present (that path uses the authed clickstream instead), nor in
   * `local_only` runtime mode.
   */
  anonymousTelemetry?: boolean;
  /**
   * Client-side clickstream batching policy (plan 95). Events are buffered and
   * flushed to `POST /api/track` on whichever comes first: the batch reaching
   * {@link RevTurbineEventBatchingOptions.maxBatchSize}, the
   * {@link RevTurbineEventBatchingOptions.flushIntervalMs} timer elapsing, or a
   * page-unload signal (`pagehide` / `visibilitychange: hidden`). Tune for
   * low-volume sessions that would otherwise strand events.
   */
  eventBatching?: RevTurbineEventBatchingOptions;
  /** Base URL of the RevTurbine API Edge. */
  endpoint: string;
  /** SDK integration mode. */
  mode: RevTurbineSdkMode;
  /**
   * SDK deployment/runtime mode:
   * - `revturbine_server` (default): standard RevTurbine-hosted endpoints.
   * - `custom_endpoints`: customer-provided endpoint replacements.
   * - `local_only`: no server calls, runtime data initialized locally.
   */
  runtimeMode?: RevTurbineRuntimeMode;
  /** Optional endpoint overrides used in `custom_endpoints` mode. */
  endpointOverrides?: Partial<RevTurbineEndpointOverrides>;
  /** Optional provider for RevTurbineConfig-backed data (plans, segments, rules, ui paths). */
  configProvider?: RevTurbineConfigProvider;
  /** Local-only runtime configuration used in `local_only` mode. */
  localRuntime?: RevTurbineLocalRuntimeOptions;
  /**
   * Slot behavior after provider-chain failure disables the SDK.
   * - `invisible` (default): slots return hidden decisions.
   * - `placeholder`: slots return visible placeholder content.
   */
  providerFailureSlotBehavior?: RevTurbineProviderFailureSlotBehavior;
  /** Typed domain providers (plan, entitlements, segments, content, rules, traits). */
  domainProviders?: AnyDomainProvider[];
  /** Optional UI path resolver map used by `validateUiPathResolvers()`. */
  uiPathResolvers?: RevTurbineUiPathResolverMap;
  user?: RevTurbineUserContext;
  page?: RevTurbinePageContext;
  contextPolicy?: RevTurbineContextPolicy;
  /**
   * Opt-in flags for placement decision behavior changes.
   *
   * Defaults are conservative (`false`) so existing integrations do not change behavior
   * until explicitly enabled.
   */
  placementBehavior?: Partial<RevTurbinePlacementBehaviorFlags>;
  extension?: {
    enabled?: boolean;
  };
  /**
   * Persistent storage provider (survives page reloads).
   * Browser default: `localStorage`. Server default: in-memory.
   * Override with a Redis/cookie/DB-backed implementation for SSR persistence.
   */
  persistentStorage?: RevTurbineStorage;
  /**
   * Session-scoped storage provider (cleared when the tab/session ends).
   * Browser default: `sessionStorage`. Server default: in-memory.
   */
  sessionStorage?: RevTurbineStorage;
}

/** Base init options shared by all runtime mode helper builders. */
export type RevTurbineInitBaseOptions = Omit<
  RevTurbineInitOptions,
  'runtimeMode' | 'endpointOverrides' | 'localRuntime'
>;

export type RevTurbineRuntimeMode = 'revturbine_server' | 'custom_endpoints' | 'local_only';

/**
 * Per-operation endpoint path/URL overrides for `custom_endpoints` mode.
 * Each key maps to a fully-qualified URL or an `endpoint`-relative path.
 */
export interface RevTurbineEndpointOverrides {
  decideContext: string;
  bootstrapContext: string;
  decide: string;
  getPlacement: string;
  checkEntitlement: string;
  userContext: string;
  trialStatus: string;
  ingestEvents: string;
  /** Keyless anonymous SDK telemetry endpoint (`POST /api/sdk/meta`). */
  ingestSdkMeta: string;
  touchpointTransition: string;
  legacyInteractions: string;
  placementTypes: string;
  surfaceSlots: string;
}

/** Client-side clickstream batching policy (plan 95 TASK-6). */
export interface RevTurbineEventBatchingOptions {
  /**
   * Flush the buffer once this many events are queued. Default `20`.
   * Clamped to a minimum of `1`.
   */
  maxBatchSize?: number;
  /**
   * Also flush the buffer on this interval, in milliseconds, so low-volume
   * sessions don't strand events. Default `5000`. Set to `0` to disable the
   * timer (size + page-unload flushing still apply).
   */
  flushIntervalMs?: number;
}

export interface RevTurbineLocalRuntimeData {
  placementDecisionsByPlacementId?: Record<string, RevTurbinePlacementDecision>;
  placementsByLookupKey?: Record<string, PlacementOutput | null>;
  entitlementByHandle?: Record<string, EntitlementResult>;
  userContextByUserId?: Record<string, UserTargetingContext>;
  trialStatus?: RevTurbineTrialContext;
}

export interface RevTurbineLocalRuntimeResolvers {
  getPlacementDecision?: (input: RevTurbinePlacementDecisionInput, placement?: RevTurbinePlacementRecord, context?: JsonObject) => RevTurbinePlacementDecision | Promise<RevTurbinePlacementDecision>;
  getPlacement?: (config: RevTurbinePlacementRequestConfig) => PlacementOutput | null | Promise<PlacementOutput | null>;
  checkEntitlement?: (handle: string, context?: RevTurbineEntitlementContext) => EntitlementResult | Promise<EntitlementResult>;
  fetchUserContext?: (userId: string) => UserTargetingContext | Promise<UserTargetingContext>;
  getTrialStatus?: () => RevTurbineTrialContext | Promise<RevTurbineTrialContext>;
  /** Optional RevTurbineConfig resolver for provider-backed config access in any mode. */
  resolveExportedConfig?: () => RevTurbineConfig | Promise<RevTurbineConfig>;
}

export interface RevTurbineLocalRuntimeOptions {
  /**
   * Full RevTurbineConfig snapshot loaded at initialization for local-only execution.
   * Contains plans, entitlements, entitlement rules, segments, ui paths,
   * surface templates, trial, and theme. Providers and resolvers can read
   * this to hydrate domain state without a server.
   */
  exportedConfig?: RevTurbineConfig;
  /** Optional static placements dataset used by the SDK's built-in local resolver. */
  placements?: LocalPlacementDataset;
  /**
   * Arbitrary configuration/context/content passed at initialization for local-only execution.
   * This is persisted under localStorage and used as runtime source-of-truth.
   */
  initialData?: RevTurbineLocalRuntimeData;
  /** Optional resolver callbacks for advanced local decisioning behavior. */
  resolvers?: RevTurbineLocalRuntimeResolvers;
  /** Optional explicit storage key for persisted local-only runtime state. */
  storageKey?: string;
  /**
   * Reactive context callback. When provided, the SDK calls this before every
   * local decision request and passes the result as the third argument to
   * `resolvers.getPlacementDecision`.
   *
   * This allows local resolvers to react to user context changes (plan state,
   * trial day, usage counters) without rebuilding the provider.
   */
  getContext?: () => JsonObject | Promise<JsonObject>;
}

type RevTurbineBaseInitWithoutRuntimeSpecifics = Omit<
  RevTurbineInitOptions,
  'runtimeMode' | 'localRuntime' | 'uiPathResolvers'
>;

/**
 * Strict initialization mode for compile-time safety:
 * when using `local_only` runtime with `localRuntime.exportedConfig`,
 * `uiPathResolvers` is required.
 */
export type RevTurbineInitOptionsStrict =
  | (RevTurbineBaseInitWithoutRuntimeSpecifics & {
      runtimeMode: 'local_only';
      localRuntime: RevTurbineLocalRuntimeOptions & {
        exportedConfig: RevTurbineConfig;
      };
      uiPathResolvers: RevTurbineUiPathResolverMap;
    })
  | (RevTurbineBaseInitWithoutRuntimeSpecifics & {
      runtimeMode: 'local_only';
      localRuntime: RevTurbineLocalRuntimeOptions & {
        exportedConfig?: undefined;
      };
      uiPathResolvers?: RevTurbineUiPathResolverMap;
    })
  | (RevTurbineBaseInitWithoutRuntimeSpecifics & {
      runtimeMode?: Exclude<RevTurbineRuntimeMode, 'local_only'>;
      localRuntime?: RevTurbineLocalRuntimeOptions;
      uiPathResolvers?: RevTurbineUiPathResolverMap;
    });

/**
 * Build a server-backed SDK config (default runtime mode).
 */
export function createServerRuntimeConfig(
  options: RevTurbineInitBaseOptions,
): RevTurbineInitOptions {
  return {
    ...options,
    runtimeMode: 'revturbine_server',
  };
}

/**
 * Build a custom-endpoint SDK config.
 */
export function createCustomEndpointRuntimeConfig(
  options: RevTurbineInitBaseOptions & {
    endpointOverrides: Partial<RevTurbineEndpointOverrides>;
  },
): RevTurbineInitOptions {
  return {
    ...options,
    runtimeMode: 'custom_endpoints',
    endpointOverrides: options.endpointOverrides,
  };
}

/**
 * Build a local-only SDK config.
 */
export function createLocalRuntimeConfig<const TUiPaths extends readonly unknown[]>(
  options: RevTurbineInitBaseOptions & {
    localRuntime: RevTurbineLocalRuntimeOptions & {
      exportedConfig: Omit<RevTurbineConfig, 'content_ui_paths'> & { content_ui_paths: TUiPaths };
    };
    uiPathResolvers: RevTurbineRequiredUiPathResolvers<TUiPaths> & RevTurbineUiPathResolverMap;
  },
): RevTurbineInitOptions;
export function createLocalRuntimeConfig(
  options: RevTurbineInitBaseOptions & {
    localRuntime: RevTurbineLocalRuntimeOptions;
    uiPathResolvers?: RevTurbineUiPathResolverMap;
  },
): RevTurbineInitOptions;
export function createLocalRuntimeConfig(
  options: RevTurbineInitBaseOptions & {
    localRuntime: RevTurbineLocalRuntimeOptions;
    uiPathResolvers?: RevTurbineUiPathResolverMap;
  },
): RevTurbineInitOptions {
  const normalizedUiPathResolvers = sanitizeUiPathResolverMap(
    options.uiPathResolvers,
    'createLocalRuntimeConfig(uiPathResolvers)',
  );

  return {
    ...options,
    runtimeMode: 'local_only',
    localRuntime: options.localRuntime,
    uiPathResolvers: normalizedUiPathResolvers,
  };
}

/**
 * Build a strict local-only SDK config.
 *
 * Unlike {@link createLocalRuntimeConfig}, this helper always requires
 * `exportedConfig.content_ui_paths` and complete `uiPathResolvers` coverage at
 * compile time for action types present in that exported config.
 */
export function createStrictLocalRuntimeConfig<const TUiPaths extends readonly unknown[]>(
  options: RevTurbineInitBaseOptions & {
    localRuntime: RevTurbineLocalRuntimeOptions & {
      exportedConfig: Omit<RevTurbineConfig, 'content_ui_paths'> & { content_ui_paths: TUiPaths };
    };
    uiPathResolvers: RevTurbineRequiredUiPathResolvers<TUiPaths> & RevTurbineUiPathResolverMap;
  },
): RevTurbineInitOptions {
  return createLocalRuntimeConfig(options);
}

/** Optional context for slot-based placement requests. */
export interface RevTurbineSlotPlacementRequestOptions {
  entitlementHandle?: string;
  planHandle?: string;
  placementHandle?: string;
}

/** Optional context for entitlement-based placement requests. */
export interface RevTurbineEntitlementPlacementRequestOptions {
  slotId?: string;
  surfaceType?: RevTurbineSurfaceType;
  planHandle?: string;
  placementHandle?: string;
}

/** Optional context for chained placement requests. */
export interface RevTurbineChainedPlacementRequestOptions {
  slotId?: string;
  surfaceType?: RevTurbineSurfaceType;
  entitlementHandle?: string;
  planHandle?: string;
}

/**
 * Create a typed placement request for slot + surface lookups.
 */
export function createSlotPlacementRequest(
  slotId: string,
  surfaceType: RevTurbineSurfaceType,
  options: RevTurbineSlotPlacementRequestOptions = {},
): RevTurbinePlacementRequestConfig {
  return {
    slotId,
    surfaceType,
    entitlementHandle: options.entitlementHandle,
    planHandle: options.planHandle,
    placementHandle: options.placementHandle,
  };
}

/**
 * Create a typed placement request for entitlement-gated lookups.
 */
export function createEntitlementPlacementRequest(
  entitlementHandle: string,
  options: RevTurbineEntitlementPlacementRequestOptions = {},
): RevTurbinePlacementRequestConfig {
  return {
    entitlementHandle,
    slotId: options.slotId,
    surfaceType: options.surfaceType,
    planHandle: options.planHandle,
    placementHandle: options.placementHandle,
  };
}

/**
 * Create a typed placement request for chained/CTA follow-up lookups.
 */
export function createChainedPlacementRequest(
  placementHandle: string,
  options: RevTurbineChainedPlacementRequestOptions = {},
): RevTurbinePlacementRequestConfig {
  return {
    placementHandle,
    slotId: options.slotId,
    surfaceType: options.surfaceType,
    entitlementHandle: options.entitlementHandle,
    planHandle: options.planHandle,
  };
}

/**
 * Configuration for registering a placement slot.
 * The combination of name + route + scope key produces a deterministic placement ID.
 *
 * @deprecated Use `RevTurbineSurfaceSlotConfig`.
 */
export interface RevTurbinePlacementConfig {
  /** Human-readable placement name (e.g. `'pricing_banner'`). */
  name: string;
  /** Optional scope key to differentiate placements on the same route. */
  placementScopeKey?: string;
  /** Arbitrary metadata attached to the placement for analytics. */
  metadata?: SdkMetadata;
}

/**
 * Canonical configuration for a renderable surface slot.
 *
 * `id` must be unique within the customer app integration.
 */
export interface RevTurbineSurfaceSlotConfig {
  /** Required unique identifier for the surface slot. */
  id: string;
  /** Optional human-readable label used for analytics and debugging. */
  name?: string;
  /**
   * Surface template IDs that this slot accepts.
   *
   * When provided, only placements whose surface template matches one of
   * these IDs are eligible to render in this slot. This acts as a filter
   * at decision time — both the local resolver and the remote
   * decide-context endpoint use this constraint.
   */
  surfaceTemplateIds?: string[];
  /** Arbitrary metadata attached to the slot for analytics and traceability. */
  metadata?: SdkMetadata;
}

export type { RevTurbinePlacementRecord } from '@revt-eng/core';
import type { RevTurbinePlacementRecord } from '@revt-eng/core';

export interface RevTurbinePlacementContent {
  placementId: string;
  requestId: string;
  decisionSource: 'remote' | 'fallback';
  content: RevTurbineDecisionContent;
}

/**
 * Simplified content fields carried on placement decisions.
 * Re-exported from `@revt-eng/core`.
 */
export type { RevTurbineDecisionContent } from '@revt-eng/core';
import type { RevTurbineDecisionContent } from '@revt-eng/core';

/** Build a {@link RevTurbineDecisionContent} populating both canonical and deprecated aliases. */
function decisionContent(header: string, body: string, ctaLabel: string): RevTurbineDecisionContent {
  return { header, body, cta_label: ctaLabel, title: header, cta: ctaLabel };
}

export type { RevTurbineContextMode } from '@revt-eng/core';
import type { RevTurbineContextMode } from '@revt-eng/core';

export type { RevTurbineMeterUsageOverride } from '@revt-eng/core';
import type { RevTurbineMeterUsageOverride } from '@revt-eng/core';

export type { RevTurbinePlacementDecisionOverrides } from '@revt-eng/core';
import type { RevTurbinePlacementDecisionOverrides } from '@revt-eng/core';

/**
 * Input for requesting a placement decision.
 * Re-exported from `@revt-eng/core`.
 */
export type { RevTurbinePlacementDecisionInput } from '@revt-eng/core';
import type { RevTurbinePlacementDecisionInput } from '@revt-eng/core';

export interface RevTurbineBootstrapDecisionInput {
  userId: string;
  contextMode?: RevTurbineContextMode;
  overrides?: RevTurbinePlacementDecisionOverrides;
  traits?: Record<string, string | number | boolean>;
  ttlMs?: number;
  placementIds: string[];
}

/**
 * A placement decision returned by the decision engine.
 * Re-exported from `@revt-eng/core`.
 */
export type { RevTurbinePlacementDecision } from '@revt-eng/core';
import type { RevTurbinePlacementDecision } from '@revt-eng/core';

/** Predicate-level evaluation detail for segment matching diagnostics. */
export type RevTurbineSegmentPredicateEvaluation = PredicateEvaluationResult;

/** Segment-level evaluation detail for placement diagnostics. */
export interface RevTurbineSegmentEvaluation {
  segmentId: string;
  segmentName?: string;
  matched: boolean;
  predicates: RevTurbineSegmentPredicateEvaluation[];
}

/** Entitlement-rule evaluation detail for placement diagnostics. */
export interface RevTurbineEntitlementRuleEvaluation {
  ruleId: string;
  entitlementId?: string;
  entitlementHandle?: string;
  kind?: string;
  /** Human-readable plan scopes resolved from `planIds` (e.g. `starter`, `professional`). */
  planScopes: string[];
  planIds: string[];
  /**
   * Segment IDs the rule is scoped to. Empty array means "matches all users".
   * Evaluated with intra-dimension OR + cross-dimension AND per spec §2.5
   * (plan #39 REQ-8).
   */
  segmentIds?: string[];
  matchesPlan: boolean;
  matchesSegment: boolean;
  matched: boolean;
  outcome: EntitlementStatus | 'unknown';
  /** Human-readable description of what this rule grants (e.g. "grants access", "sets limit to 5,000 calls / month"). */
  outcomeDescription?: string;
  reason?: string;
}

/** Placement rule signals extracted from the selected placement output. */
export interface RevTurbinePlacementRuleEvaluation {
  ruleId?: string;
  decisionId?: string;
  category?: string;
  suppressionReason?: string;
  reasonCodes: string[];
  capPolicies: Array<{
    count: number;
    period: 'session' | 'day' | 'week' | 'month' | 'lifetime';
    cooldownMs?: number;
  }>;
}

/** Placement payload eligibility detail for explainability UI. */
export interface RevTurbinePlacementPayloadEvaluation {
  payloadId: string;
  placementId: string;
  placementName: string;
  status: 'draft' | 'active' | 'disabled';
  planIds: string[];
  planScopes: string[];
  segmentChips: string[];
  surfaceTemplateIds: string[];
  matchesPlan: boolean;
  matchesSegment: boolean;
  eligible: boolean;
  selected: boolean;
}

/** Structured explanation object for placement decision visualization. */
export interface RevTurbinePlacementDecisionExplanation {
  generatedAt: string;
  input: RevTurbinePlacementDecisionInput;
  decision: RevTurbinePlacementDecision;
  targeting: RevTurbineTargeting;
  policy: RevTurbinePolicySnapshot;
  entitlements: Record<string, EntitlementResult>;
  segments: RevTurbineSegmentEvaluation[];
  entitlementRules: RevTurbineEntitlementRuleEvaluation[];
  eligiblePayloads: RevTurbinePlacementPayloadEvaluation[];
  placementRules: RevTurbinePlacementRuleEvaluation;
}

/**
 * Types of user interactions with a placement treatment.
 * Re-exported from `@revt-eng/core`.
 */
export type { RevTurbineTreatmentInteractionType } from '@revt-eng/core';
import type { RevTurbineTreatmentInteractionType } from '@revt-eng/core';

export type { RevTurbineTreatmentInteractionInput } from '@revt-eng/core';
import type { RevTurbineTreatmentInteractionInput } from '@revt-eng/core';

/**
 * Optional fields for constructing typed interaction payloads.
 */
export interface RevTurbineTreatmentInteractionOptions {
  treatmentId?: string;
  interactionAt?: string;
  metadata?: SdkMetadata;
}

/**
 * Create a typed treatment interaction payload.
 */
export function createTreatmentInteraction(
  userId: string,
  placementId: string,
  interactionType: RevTurbineTreatmentInteractionType,
  options: RevTurbineTreatmentInteractionOptions = {},
): RevTurbineTreatmentInteractionInput {
  return {
    userId,
    placementId,
    interactionType,
    treatmentId: options.treatmentId,
    interactionAt: options.interactionAt,
    metadata: options.metadata,
  };
}

export interface RevTurbineEventOptions {
  immediate?: boolean;
}

/**
 * User targeting context for payload eligibility.
 * Re-exported from `@revt-eng/core`.
 */
export type { UserTargetingContext } from '@revt-eng/core';
import type { UserTargetingContext } from '@revt-eng/core';

/** A named semantic event with structured payload. */
export interface RevTurbineSemanticEvent {
  /** Event type name (e.g. `'checkout_started'`). */
  eventType: string;
  /** Structured event payload. */
  payload: SdkEventProperties;
  /** Delivery options. */
  options?: RevTurbineEventOptions;
}

/**
 * Canonical trigger event names recognised by the SDK and decision engine.
 *
 * These correspond to the placement categories defined in the product requirements
 * (trial lifecycle, usage/limits, feature gating, retention, expansion).
 */
export type RevTurbineTriggerEvent = TriggerEventType;

/** Payload for trial-related trigger events. */
export interface TrialTriggerPayload {
  days_remaining?: number;
}

/** Payload for usage/limit trigger events. */
export interface UsageTriggerPayload {
  /** The entitlement handle this usage event refers to. */
  entitlement_handle?: string;
  /** Current usage count for the entitlement. */
  current_usage?: number;
  /** Usage limit configured for the entitlement on the active plan. */
  usage_limit?: number;
  usage_percent?: number;
  threshold?: number;
  balance?: number;
  allocation?: number;
  seats_used?: number;
  seats_allowed?: number;
}

/** Payload for feature-gate trigger events. */
export interface FeatureGateTriggerPayload {
  feature: string;
}

/** Payload for payment-related trigger events. */
export interface PaymentTriggerPayload {
  retry_count?: number;
  renewal_date?: string;
}

/** Union of all typed trigger payloads. */
export type RevTurbineTriggerPayload =
  | TrialTriggerPayload
  | UsageTriggerPayload
  | FeatureGateTriggerPayload
  | PaymentTriggerPayload
  | SdkEventProperties;

/**
 * Create a typed semantic event payload.
 */
export function createSemanticEvent(
  eventType: string,
  payload: SdkEventProperties,
  options?: RevTurbineEventOptions,
): RevTurbineSemanticEvent {
  return {
    eventType,
    payload,
    options,
  };
}

export type { RevTurbineEventEnvelope } from '@revt-eng/core';
import type { RevTurbineEventEnvelope } from '@revt-eng/core';

interface RevTurbineBridge {
  getSnapshot: () => {
    tenantId: string;
    user: RevTurbineUserContext;
    page: RevTurbinePageContext;
    placements: RevTurbinePlacementRecord[];
  };
  setPageContext: (context: RevTurbinePageContext) => void;
  setUserContext: (context: RevTurbineUserContext) => void;
}

interface HistoryWithPatchMarker extends History {
  __rtPatched?: boolean;
}

const ROUTE_CHANGE_EVENT = 'revturbine:sdk-route-change';
const SDK_WARNING_EVENT_TYPE = 'sdk_validation_warning';
const DECISION_CACHE_STORAGE_PREFIX = 'revturbine:decision-cache';
const INTERACTION_STATE_STORAGE_PREFIX = 'revturbine:interaction-state';
const PRESENTATION_CAPS_STORAGE_PREFIX = 'revturbine:presentation-caps';
const INGEST_GATEWAY_PATH = '/api/track';
const SDK_META_GATEWAY_PATH = '/api/sdk/meta';
// Treatment interactions (impression / dismiss / cta) POST here so the control
// plane can write a `placement_presentations` row (plan 114). The public
// `touchpointTransition` endpoint-override key is kept for back-compat; the
// default target is the events interactions route.
const TOUCHPOINT_TRANSITION_PATH = '/api/events/interactions';
const LEGACY_INTERACTIONS_PATH = '/api/placements/interactions';
const SDK_EVENT_SOURCE = 'revturbine-web-sdk';

/**
 * Reserved clickstream event name for the user-context field-names signal
 * (plan 114 TASK-4). Emitted on identify/setUserContext carrying only the NAMES
 * of the custom fields set (never their values). The tenant-scoped
 * `user_context_fields` pipe (TASK-5) reads `events_clickstream` filtered on
 * this name and unnests `properties.context_fields` into per-field last-seen.
 */
const USER_CONTEXT_FIELDS_EVENT = 'user_context_observed';

/** Default client-side clickstream batching policy (plan 95 TASK-6). */
const DEFAULT_EVENT_BATCH_SIZE = 20;
const DEFAULT_EVENT_FLUSH_INTERVAL_MS = 5_000;

// Keyless anonymous SDK telemetry body shapes — sourced from the generated
// OpenAPI client (the scaffold contract), never hand-rolled (plan 95 TASK-7).
type SdkMetaIngestBatchBody = components['schemas']['SdkMetaIngestBatch'];
type SdkMetaEventBody = components['schemas']['SdkMetaEvent'];
type SdkConfigShapeBody = components['schemas']['SdkConfigShape'];

interface ValidationIssue {
  code: string;
  reason: string;
  details?: JsonObject;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

// InteractionState, CapPeriod, PlacementCapRule, PlacementCapPolicy,
// PresentationCapState — imported from @revt-eng/core at top of file.

/**
 * Pull an optional clickstream string field (`placement_id`,
 * `experiment_id`, …) out of an SDK event's free-form properties bag for
 * the `/api/track` `TrackEvent` mapping. Placement events carry these
 * either at the top level or nested under a semantic `payload` object
 * (see `collectPayloadIssues`), so both shapes are checked. Returns
 * `null` when absent — matching the nullable scaffold contract — which
 * keeps `experiment_id`/`variant_key` preserved end-to-end (plan 41
 * REQ-7) without inventing values.
 */
function pickClickstreamField(
  properties: Record<string, unknown>, // sdk-ok: boundary-parse
  key: string,
): string | null {
  const top = properties[key];
  if (typeof top === 'string' && top.trim().length > 0) return top;
  const semantic = properties.payload;
  if (isRecord(semantic)) {
    const nested = semantic[key];
    if (typeof nested === 'string' && nested.trim().length > 0) return nested;
  }
  return null;
}

/** Wraps core sanitizeSlug with a browser-secure random fallback suffix. */
function sanitizeSlug(input: string): string {
  return coreSanitizeSlug(input, secureRandomHex(8));
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlFromBytes(new Uint8Array(digest));
}

function secureRandomHex(length: number): string {
  const byteLength = Math.ceil(length / 2);
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byteHex = bytes[i].toString(16).padStart(2, '0');
    hex += byteHex;
  }
  return hex.slice(0, length);
}

function requestId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${secureRandomHex(16)}`;
}

function inferPageContext(): RevTurbinePageContext {
  if (isServer()) return {};
  return {
    url: window.location.href,
    title: document.title,
    referrer: document.referrer || undefined,
  };
}

function inferUserContext(): RevTurbineUserContext {
  return {
    id: undefined,
    custom: {},
    entitlements: {},
    usage: {},
    personalization: {},
  };
}

function evaluateSegmentPredicateForDiagnostics(
  predicate: RevTurbineConfigSegmentsItemPredicatesItem,
  traits: SdkTraits,
): RevTurbineSegmentPredicateEvaluation {
  // Narrow SdkTraits (Record<string, JsonValue>) to Trait (Record<string, string|number|boolean>)
  // by filtering out non-primitive values — matches core's Trait constraint.
  const narrowed: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(traits)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      narrowed[k] = v;
    }
  }
  return evaluatePredicateVerbose(predicate, narrowed);
}

/**
 * Apply intra-dimension OR + cross-dimension AND segment matching for one
 * entitlement rule, mirroring scaffold's `segment-matching.ts` helper
 * (plan #39 REQ-8). Empty `ruleSegmentIds` means "matches all users".
 * Segments missing a `dimension_id` bucket together under `__no_dim__`,
 * preserving flat-OR back-compat for pre-PR-B exports.
 */
function matchesEntitlementRuleSegmentsForDiagnostics(
  ruleSegmentIds: readonly string[],
  userSegments: ReadonlySet<string>,
  segmentDimensionsById: ReadonlyMap<string, string>,
): boolean {
  if (ruleSegmentIds.length === 0) return true;
  const byDimension = new Map<string, string[]>();
  for (const segId of ruleSegmentIds) {
    const dim = segmentDimensionsById.get(segId) ?? '__no_dim__';
    const bucket = byDimension.get(dim) ?? [];
    bucket.push(segId);
    byDimension.set(dim, bucket);
  }
  for (const bucket of byDimension.values()) {
    if (!bucket.some((s) => userSegments.has(s))) return false;
  }
  return true;
}

class StaticExportedConfigProvider implements RevTurbineConfigProvider {
  private readonly exportedConfig?: RevTurbineConfig;

  constructor(exportedConfig?: RevTurbineConfig) {
    this.exportedConfig = exportedConfig;
  }

  getExportedConfig(): RevTurbineConfig | undefined {
    return this.exportedConfig;
  }
}

class ResolverBackedExportedConfigProvider implements RevTurbineConfigProvider {
  private cached?: RevTurbineConfig;
  private readonly resolver: () => RevTurbineConfig | Promise<RevTurbineConfig>;

  constructor(
    resolver: () => RevTurbineConfig | Promise<RevTurbineConfig>,
    initialConfig?: RevTurbineConfig,
  ) {
    this.resolver = resolver;
    this.cached = initialConfig;
  }

  getExportedConfig(): RevTurbineConfig | undefined {
    return this.cached;
  }

  async refresh(): Promise<RevTurbineConfig | undefined> {
    const next = parseExportedConfigOrThrow(
      await this.resolver(),
      'localRuntime.resolvers.resolveExportedConfig()',
    );
    if (next) {
      this.cached = next;
    }
    return this.cached;
  }
}

/**
 * The core RevTurbine customer-facing SDK.
 *
 * Provides methods for:
 * - **Identity** — `identify()`, `resetIdentity()`
 * - **Placements** — `registerPlacement()`, `getPlacementDecision()`, `getPlacement()`
 * - **Entitlements** — `checkEntitlement()`, `updateUsage()`
 * - **Trials** — `getTrialStatus()`
 * - **Events** — `capture()`, `trackEvent()`, `emitSemantic()`
 * - **Interactions** — `trackTreatmentInteraction()`, `dismiss()`, `convert()`
 * - **Context** — `setUserContext()`, `setPageContext()`, `refreshPageContext()`
 *
 * @example
 * ```ts
 * const sdk = initRevTurbine({
 *   tenantId: 'tenant_abc',
 *   apiKey: 'rt_live_xxx',
 *   endpoint: 'https://api.revturbine.io',
 *   mode: 'react',
 * });
 *
 * sdk.identify('user_123', { plan: 'pro' });
 * const decision = await sdk.getPlacementDecision({ placementId, userId: 'user_123' });
 * ```
 */
export class RevTurbineCustomerSdk {
  private readonly tenantId: string;
  private readonly apiKey: string;
  private readonly ingestPublicKey?: string;
  private readonly environmentId: string;
  private readonly analyticsEnabled: boolean;
  private readonly anonymousTelemetryEnabled: boolean;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private flushTimer?: ReturnType<typeof setInterval>;
  private readonly batchingTeardown: Array<() => void> = [];
  private anonTelemetryNoticeShown = false;
  private piiRedactionWarned = false;
  private readonly endpoint: string;
  private readonly runtimeMode: RevTurbineRuntimeMode;
  private readonly endpointOverrides: Partial<RevTurbineEndpointOverrides>;
  private readonly localRuntime?: RevTurbineLocalRuntimeOptions;
  private readonly localStorageKey: string;
  private readonly mode: RevTurbineSdkMode;
  private readonly policy: Required<RevTurbineContextPolicy>;
  private readonly extensionEnabled: boolean;
  private readonly placementBehavior: RevTurbinePlacementBehaviorFlags;
  private readonly providerFailureSlotBehavior: RevTurbineProviderFailureSlotBehavior;
  private readonly uiPathResolvers: RevTurbineUiPathResolverMap;
  private readonly persistentStore: RevTurbineStorage;
  private readonly sessionStore: RevTurbineStorage;
  private readonly anonymousId: string;
  private readonly sessionId: string;
  private readonly decisionCache = new Map<string, CacheEntry<RevTurbinePlacementDecision>>();
  private readonly interactionState = new Map<string, InteractionState>();
  private readonly interactionQueue: RevTurbineTreatmentInteractionInput[] = [];
  private readonly defaultDecisionTtlMs = 60_000;
  private readonly defaultDismissCooldownMs = 24 * 60 * 60 * 1000;
  private readonly defaultRemindLaterMs = 60 * 60 * 1000;
  private readonly defaultUsageWarningPercent = 80;
  private readonly defaultTrialExpiringDays = 3;
  private readonly events: RevTurbineEventEnvelope[] = [];
  private readonly placements = new Map<string, RevTurbinePlacementRecord>();
  private readonly syncedSurfaceSlotIds = new Set<string>();
  private userContext: RevTurbineUserContext;
  private pageContext: RevTurbinePageContext;
  private usageBalances: UsageBalances = {};
  private localDecisionsByPlacementId = new Map<string, RevTurbinePlacementDecision>();
  private localPlacementsByLookupKey = new Map<string, PlacementOutput | null>();
  private localEntitlementsByHandle = new Map<string, EntitlementResult>();
  private localUserContextsByUserId = new Map<string, UserTargetingContext>();
  private localTrialStatus: RevTurbineTrialContext = { in_trial: false };
  private readonly presentationCapsByKey = new Map<string, PresentationCapState>();
  private readonly usageLimitByEntitlement = new Map<string, { limit: number; warningPercent: number }>();
  private readonly usageTokenPrefixByEntitlement = new Map<string, string>();
  private readonly segmentIdsByPredicateField = new Map<string, Set<string>>();
  private readonly configuredSegmentsById = new Map<string, RevTurbineConfigSegmentsItem>();
  private readonly dirtySegmentIds = new Set<string>();
  private readonly segmentMembershipBySegmentId = new Map<string, boolean>();
  private segmentMembershipUserId?: string;
  private lastTrialTriggerStage: 'none' | 'midpoint' | 'expiring' | 'expired' = 'none';
  private readonly configProvider?: RevTurbineConfigProvider;
  private readonly defaultLocalPlacementDecisionResolver?: NonNullable<RevTurbineLocalRuntimeResolvers['getPlacementDecision']>;
  private sdkDisabledByProviderFailure = false;
  private sdkDisabledReason?: string;
  readonly providerRegistry: DomainProviderRegistry;
  readonly placementTypeRegistry: PlacementTypeRegistry;
  readonly impressionHistory: ImpressionHistory;

  constructor(options: RevTurbineInitOptions) {
    this.tenantId = options.tenantId;
    this.apiKey = options.apiKey;
    this.ingestPublicKey = options.ingestPublicKey;
    this.environmentId = options.environmentId?.trim() || 'default';
    this.analyticsEnabled = options.analytics !== false;
    this.anonymousTelemetryEnabled = options.anonymousTelemetry !== false;
    this.maxBatchSize = Math.max(1, options.eventBatching?.maxBatchSize ?? DEFAULT_EVENT_BATCH_SIZE);
    this.flushIntervalMs = Math.max(0, options.eventBatching?.flushIntervalMs ?? DEFAULT_EVENT_FLUSH_INTERVAL_MS);
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.runtimeMode = options.runtimeMode ?? 'revturbine_server';
    this.endpointOverrides = options.endpointOverrides ?? {};
    this.localRuntime = options.localRuntime;
    this.configProvider = this.resolveConfigProvider(options);
    this.localStorageKey =
      options.localRuntime?.storageKey ?? `revturbine:${this.tenantId}:local-runtime`;
    this.mode = options.mode;
    this.policy = {
      inferUser: options.contextPolicy?.inferUser ?? true,
      inferPage: options.contextPolicy?.inferPage ?? true,
      routerAutoTrack: options.contextPolicy?.routerAutoTrack ?? true,
    };
    this.extensionEnabled = Boolean(options.extension?.enabled);
    this.placementBehavior = {
      enableClientCapsEnforcement: options.placementBehavior?.enableClientCapsEnforcement ?? false,
      enableAutoGatedPlacement: options.placementBehavior?.enableAutoGatedPlacement ?? false,
      enableTrialAutoTriggers: options.placementBehavior?.enableTrialAutoTriggers ?? false,
    };
    this.providerFailureSlotBehavior = options.providerFailureSlotBehavior ?? 'invisible';
    this.uiPathResolvers = sanitizeUiPathResolverMap(options.uiPathResolvers, 'RevTurbineInitOptions.uiPathResolvers');
    this.persistentStore = resolvePersistentStorage(options.persistentStorage);
    this.sessionStore = resolveSessionStorage(options.sessionStorage);
    this.userContext = {
      usage: {},
      ...(this.policy.inferUser ? inferUserContext() : {}),
      ...(options.user || {}),
    };
    this.pageContext = {
      ...(this.policy.inferPage ? inferPageContext() : {}),
      ...(options.page || {}),
      tags: ensureArray(options.page?.tags),
    };
    this.anonymousId = this.resolveAnonymousId();
    this.sessionId = requestId();
    this.providerRegistry = new DomainProviderRegistry();
    this.placementTypeRegistry = new PlacementTypeRegistry();
    this.impressionHistory = new ImpressionHistory({
      store: new StorageImpressionStore({
        storage: this.persistentStore,
        tenantId: this.tenantId,
      }),
      userId: this.userContext.id ?? this.anonymousId,
    });
    registerBuiltinSlotTypes(this.placementTypeRegistry);
    this.defaultLocalPlacementDecisionResolver = this.buildDefaultLocalPlacementDecisionResolver();
    if (options.domainProviders) {
      for (const p of options.domainProviders) {
        this.providerRegistry.register(p);
      }
    }
    this.assertUiPathResolverCoverageOrThrow();
    this.hydrateDecisionCache();
    this.hydrateInteractionState();
    this.hydratePresentationCaps();
    this.hydrateLocalRuntimeState();
    // Hydrate impression history so retired-placement cache is warm before resolutions.
    void this.impressionHistory.hydrate();
    this.rebuildSegmentPredicateFieldIndex();
    void this.refreshExportedConfigSnapshot();
    // recalculateDerivedUsageTraits() hydrates usage limits for the current plan.
    this.recalculateDerivedUsageTraits();

    if (isBrowser() && this.policy.routerAutoTrack) {
      this.installRouteTracking();
    }

    if (isBrowser() && this.extensionEnabled) {
      this.installBridge();
    }

    void this.capture('page_view', {
      mode: this.mode,
      runtime_mode: this.runtimeMode,
      source: 'sdk_init',
      placement_behavior_flags: this.placementBehavior as unknown as JsonValue, // sdk-ok: boundary-parse
    });

    // Plan 95 TASK-6: time-interval + page-unload flushing so buffered
    // clickstream events reach /api/track even in low-volume sessions.
    this.startEventBatchFlushing();
    // Plan 95 TASK-7: keyless anonymous adoption beacon — only fires when no
    // ingest key is configured (see emitSdkInitTelemetry); best-effort.
    void this.emitSdkInitTelemetry();
  }

  private isLocalOnlyMode(): boolean {
    return this.runtimeMode === 'local_only';
  }

  private resolveConfigProvider(options: RevTurbineInitOptions): RevTurbineConfigProvider | undefined {
    if (options.configProvider) {
      return options.configProvider;
    }

    const initialConfig = parseExportedConfigOrThrow(
      options.localRuntime?.exportedConfig,
      'localRuntime.exportedConfig',
    );
    const configResolver = options.localRuntime?.resolvers?.resolveExportedConfig;

    if (configResolver) {
      return new ResolverBackedExportedConfigProvider(configResolver, initialConfig);
    }

    if (initialConfig) {
      return new StaticExportedConfigProvider(initialConfig);
    }

    return undefined;
  }

  private async refreshExportedConfigSnapshot(): Promise<void> {
    try {
      await this.configProvider?.refresh?.();
      this.rebuildSegmentPredicateFieldIndex();
    } catch {
      // Config refresh is best-effort; keep SDK operational without throwing.
    }
  }

  private getConfiguredExportedConfig(): RevTurbineConfig | undefined {
    return this.configProvider?.getExportedConfig();
  }

  private rebuildSegmentPredicateFieldIndex(): void {
    this.segmentIdsByPredicateField.clear();
    this.configuredSegmentsById.clear();

    const exportedConfig = this.getConfiguredExportedConfig();
    const configuredSegments = exportedConfig?.segments ?? [];

    for (const segment of configuredSegments) {
      this.configuredSegmentsById.set(segment.id, segment);
      if (!segment.predicates || segment.predicates.length === 0) continue;

      for (const predicate of segment.predicates) {
        const field = String(predicate.field || '').trim();
        if (!field) continue;
        const segmentIds = this.segmentIdsByPredicateField.get(field) ?? new Set<string>();
        segmentIds.add(segment.id);
        this.segmentIdsByPredicateField.set(field, segmentIds);
      }
    }

    this.markAllSegmentsDirty();
  }

  private buildDefaultLocalPlacementDecisionResolver(): RevTurbineLocalRuntimeResolvers['getPlacementDecision'] | undefined {
    if (!this.isLocalOnlyMode()) return undefined;
    if (this.localRuntime?.resolvers?.getPlacementDecision) return undefined;

    const exportedConfig = this.getConfiguredExportedConfig();
    const placements = this.localRuntime?.placements
      ?? (Array.isArray(exportedConfig?.placements)
        ? { placements: exportedConfig.placements }
        : undefined);

    if (!exportedConfig || !placements) return undefined;

    return createStaticPlacementResolver({
      placements,
      exportedConfig,
      impressionHistory: this.impressionHistory,
    });
  }

  /**
   * Build a minimal provider context from the SDK's user state when no
   * explicit domain providers are registered.  This allows the local
   * placement resolver to access plan and usage data for token
   * interpolation (e.g. `{{usage_remaining}}`).
   */
  private synthesizeProviderContext(): Awaited<ReturnType<DomainProviderRegistry['resolveAll']>> | undefined {
    const plan = this.userContext.plan;
    const usage = this.userContext.usage;
    const trial = this.localTrialStatus;
    if (!plan && !usage) return undefined;

    const usageEntries: Record<string, { used: number; limit: number; remaining: number; unit?: string; reset_date?: string }> = {};
    if (usage && typeof usage === 'object') {
      const mergedAmounts = usageAmountsFromEntries(usage);
      for (const [handle, entry] of Object.entries(usage)) {
        if (!entry || typeof entry !== 'object') continue;
        const amount = typeof (entry as UserUsageEntry).amount === 'number'
          ? (entry as UserUsageEntry).amount
          : (mergedAmounts[handle] ?? 0);
        const limit = typeof (entry as UserUsageEntry).limit === 'number'
          ? (entry as UserUsageEntry).limit!
          : 0;
        const remaining = limit > 0 ? Math.max(0, limit - amount) : 0;
        usageEntries[handle] = {
          used: amount,
          limit,
          remaining,
          unit: typeof (entry as UserUsageEntry).unit === 'string' ? (entry as UserUsageEntry).unit : undefined,
          reset_date: typeof (entry as UserUsageEntry).reset_date === 'string' ? (entry as UserUsageEntry).reset_date : undefined,
        };
      }
    }

    // PlanProvider trial fields — pass through every UserTrialStatus
    // field the @revt-eng/core types declare (plan 43 TASK-8). Both
    // the bundle resolver's matchesTrialTrigger and applyMilestoneSupersession
    // read from these; partial population would silently break
    // trial-trigger gating for usage-mode trials and trial_ended /
    // trial_converted placements. UserTrialStatus.day_number + days_remaining
    // are time-mode-only; usage_consumed / usage_remaining / usage_limit
    // are usage-mode-only; progress_percent + state are universal.
    const planTrialFields = {
      ...(trial.in_trial !== undefined ? { trialActive: trial.in_trial } : {}),
      ...(trial.trial_limit_type !== undefined ? { trialLimitType: trial.trial_limit_type } : {}),
      ...(trial.progress_percent !== undefined ? { trialProgressPercent: trial.progress_percent } : {}),
      ...(trial.days_remaining !== undefined ? { trialDaysRemaining: trial.days_remaining } : {}),
      ...(trial.day_number !== undefined && trial.days_remaining !== undefined
        ? { trialDaysTotal: trial.day_number + trial.days_remaining }
        : {}),
      ...(trial.state !== undefined ? { trialState: trial.state } : {}),
      ...(trial.usage_entitlement_handle !== undefined ? { trialUsageEntitlementHandle: trial.usage_entitlement_handle } : {}),
      ...(trial.usage_consumed !== undefined ? { trialUsageConsumed: trial.usage_consumed } : {}),
      ...(trial.usage_limit !== undefined ? { trialUsageLimit: trial.usage_limit } : {}),
    };

    return {
      ...(plan ? {
        plan: {
          currentPlanHandle: plan.id ?? plan.name ?? '',
          currentPlanName: plan.name,
          ...planTrialFields,
        },
      } : {}),
      ...(Object.keys(usageEntries).length > 0 ? {
        entitlements: {
          entries: {},
          usage: usageEntries,
        },
      } : {}),
    };
  }

  private markAllSegmentsDirty(): void {
    this.dirtySegmentIds.clear();
    for (const segmentId of this.configuredSegmentsById.keys()) {
      this.dirtySegmentIds.add(segmentId);
    }
    this.segmentMembershipBySegmentId.clear();
  }

  private markSegmentsDirtyForFields(fields: Iterable<string>): void {
    for (const field of fields) {
      const segmentIds = this.segmentIdsByPredicateField.get(field);
      if (!segmentIds) continue;
      for (const segmentId of segmentIds) {
        this.dirtySegmentIds.add(segmentId);
      }
    }
  }

  private toSegmentEvaluationTraits(
    traits: SdkTraits,
    effectivePlan: string | undefined,
    usage: Record<string, number>,
  ): Record<string, string | number | boolean> {
    return coreToSegmentEvaluationTraits(traits, effectivePlan, usage);
  }

  private buildTargetingState(context: RevTurbineUserContext): {
    effectivePlan: string | undefined;
    traits: SdkTraits;
    usage: Record<string, number>;
    segmentTraits: Record<string, string | number | boolean>;
  } {
    return coreBuildTargetingState(context, this.getConfiguredExportedConfig(), this.usageBalances);
  }

  private markSegmentsDirtyFromContextChange(
    previousContext: RevTurbineUserContext,
    nextContext: RevTurbineUserContext,
  ): void {
    if (this.configuredSegmentsById.size === 0) return;

    const previousUserId = previousContext.id || this.anonymousId;
    const nextUserId = nextContext.id || this.anonymousId;
    if (previousUserId !== nextUserId) {
      this.segmentMembershipUserId = nextUserId;
      this.markAllSegmentsDirty();
      return;
    }

    const previousState = this.buildTargetingState(previousContext);
    const nextState = this.buildTargetingState(nextContext);

    const changedFields = new Set<string>();
    const allFields = new Set<string>([
      ...Object.keys(previousState.segmentTraits),
      ...Object.keys(nextState.segmentTraits),
    ]);

    for (const field of allFields) {
      if (previousState.segmentTraits[field] !== nextState.segmentTraits[field]) {
        changedFields.add(field);
      }
    }

    this.markSegmentsDirtyForFields(changedFields);
  }

  /** Resolve current pathname from page context or window.location (server-safe). */
  private currentPathname(): string {
    if (this.pageContext.url) {
      try { return new URL(this.pageContext.url).pathname; } catch { /* fall through */ }
    }
    if (isBrowser()) return window.location.pathname;
    return '/';
  }

  disableForProviderFailure(reason: string): void {
    if (this.sdkDisabledByProviderFailure) return;
    this.sdkDisabledByProviderFailure = true;
    this.sdkDisabledReason = reason;
    this.decisionCache.clear();
    this.persistDecisionCache();
    console.warn(`[RevTurbine] SDK disabled after provider fallback chain failed: ${reason}`);
  }

  private isDisabledByProviderFailure(): boolean {
    return this.sdkDisabledByProviderFailure;
  }

  private disabledDecisionForPlacement(
    placementId: string,
    placementName?: string,
  ): RevTurbinePlacementDecision {
    const visible = this.providerFailureSlotBehavior === 'placeholder';
    const title = visible
      ? `${placementName ?? placementId} temporarily unavailable`
      : `${placementName ?? placementId} unavailable`;
    const body = visible
      ? 'This placement is in safe fallback mode because all configured providers failed.'
      : 'This placement is currently hidden because provider fallback resolution failed.';

    return {
      placementId,
      requestId: requestId(),
      visible,
      decisionSource: 'fallback',
      reasonCodes: ['sdk_disabled_provider_failure'],
      suppressionReason: visible ? undefined : 'sdk_disabled_provider_failure',
      content: decisionContent(
        title,
        body,
        visible ? 'Retry later' : 'Continue',
      ),
    };
  }

  private disabledPlacementOutputForConfig(
    config: RevTurbinePlacementRequestConfig,
  ): PlacementOutput | null {
    if (this.providerFailureSlotBehavior !== 'placeholder') {
      return null;
    }

    const outputId = `disabled_output_${requestId()}`;
    const title = config.slotId
      ? `${config.slotId} temporarily unavailable`
      : 'Placement temporarily unavailable';

    return {
      output_id: outputId,
      category: 'fallback',
      surface: {
        type: config.surfaceType ?? 'banner',
        slot_id: config.slotId,
      },
      content: {
        title,
        header: title,
        body: 'This placement is in safe fallback mode because all configured providers failed.',
        cta_label: 'Retry later',
      },
      rule_id: 'sdk_disabled_provider_failure',
      decision_id: outputId,
      config_version: 'sdk-fallback',
      present_upsell: false,
    };
  }

  private endpointFor(
    key: keyof RevTurbineEndpointOverrides,
    defaultPath: string,
  ): string {
    const override = this.endpointOverrides[key];
    if (override && override.trim().length > 0) {
      if (/^https?:\/\//i.test(override)) {
        return override;
      }
      return `${this.endpoint}${override.startsWith('/') ? '' : '/'}${override}`;
    }
    return `${this.endpoint}${defaultPath}`;
  }

  private localPlacementLookupKey(config: RevTurbinePlacementRequestConfig): string {
    return coreLocalPlacementLookupKey(config);
  }

  private localLookupMatchesConfig(parts: LocalLookupParts, config: RevTurbinePlacementRequestConfig): boolean {
    if (config.slotId && parts.slotId && parts.slotId !== config.slotId) return false;
    if (config.surfaceType && parts.surfaceType && parts.surfaceType !== config.surfaceType) return false;

    const matchesOptional = (requested?: string, candidate?: string) => {
      if (!requested) return true;
      if (!candidate) return true;
      return requested === candidate;
    };

    return matchesOptional(config.entitlementHandle, parts.entitlementHandle)
      && matchesOptional(config.planHandle, parts.planHandle)
      && matchesOptional(config.placementHandle, parts.placementHandle);
  }

  private localOutputMatchesConfig(output: PlacementOutput, config: RevTurbinePlacementRequestConfig): boolean {
    return placementMatchesPlanTarget(output, config.planHandle);
  }

  private applyCategoryConflictSuppression(outputs: PlacementOutput[]): PlacementOutput[] {
    return coreApplyCategoryConflictSuppression(outputs);
  }

  private resolveLocalPlacementFromCandidates(
    candidates: PlacementOutput[],
    config?: RevTurbinePlacementRequestConfig,
  ): PlacementOutput | null {
    return coreResolveLocalPlacementFromCandidates(candidates, true, {
      fixedOnly: config?.fixedOnly ?? false,
    });
  }

  private localPlacementForConfig(config: RevTurbinePlacementRequestConfig): PlacementOutput | null {
    const exact = this.localPlacementsByLookupKey.get(this.localPlacementLookupKey(config));
    if (exact && !this.localOutputMatchesConfig(exact, config)) {
      return null;
    }

    // Always collect every matching candidate and run the category-aware
    // pipeline (supersession + per-category conflict suppression + tier-aware
    // sort). The legacy exact-match shortcut was deprecated per plan #45
    // TASK-5 / Q-3 (c) — it bypassed every prioritization rule shipped in
    // TASK-2 through TASK-4.
    const candidates: PlacementOutput[] = [];
    for (const [lookupKey, output] of this.localPlacementsByLookupKey.entries()) {
      if (!output) continue;
      const parts = parseLocalLookupKey(lookupKey);
      if (!this.localLookupMatchesConfig(parts, config)) continue;
      if (!this.localOutputMatchesConfig(output, config)) continue;
      candidates.push(output);
    }

    if (exact && !candidates.some((item) => item.output_id === exact.output_id)) {
      candidates.push(exact);
    }

    return this.resolveLocalPlacementFromCandidates(candidates, config);
  }

  private hydrateLocalRuntimeState(): void {
    if (!this.isLocalOnlyMode()) return;

    const fromInit = this.localRuntime?.initialData;
    if (fromInit?.placementDecisionsByPlacementId) {
      for (const [key, value] of Object.entries(fromInit.placementDecisionsByPlacementId)) {
        this.localDecisionsByPlacementId.set(key, value);
      }
    }
    if (fromInit?.placementsByLookupKey) {
      for (const [key, value] of Object.entries(fromInit.placementsByLookupKey)) {
        this.localPlacementsByLookupKey.set(key, value);
      }
    }
    if (fromInit?.entitlementByHandle) {
      for (const [key, value] of Object.entries(fromInit.entitlementByHandle)) {
        this.localEntitlementsByHandle.set(key, value);
      }
    }
    if (fromInit?.userContextByUserId) {
      for (const [key, value] of Object.entries(fromInit.userContextByUserId)) {
        this.localUserContextsByUserId.set(key, value);
      }
    }
    if (fromInit?.trialStatus) {
      this.localTrialStatus = fromInit.trialStatus;
    }

    const raw = this.persistentStore.getItem(this.localStorageKey);
    if (!raw) {
      this.persistLocalRuntimeState();
      return;
    }

    try {
      const parsed = JSON.parse(raw) as {
        userContext?: RevTurbineUserContext;
        pageContext?: RevTurbinePageContext;
        usageBalances?: UsageBalances;
        placements?: RevTurbinePlacementRecord[];
        decisions?: Record<string, RevTurbinePlacementDecision>;
        placementLookup?: Record<string, PlacementOutput | null>;
        entitlements?: Record<string, EntitlementResult>;
        userContexts?: Record<string, UserTargetingContext>;
        trialStatus?: RevTurbineTrialContext;
      };

      if (parsed.userContext) this.userContext = this.mergeUserContext(parsed.userContext);
      if (parsed.pageContext) this.pageContext = this.mergePageContext(parsed.pageContext);
      if (parsed.usageBalances) this.usageBalances = { ...this.usageBalances, ...parsed.usageBalances };
      for (const placement of parsed.placements || []) {
        this.placements.set(placement.id, placement);
      }
      for (const [key, value] of Object.entries(parsed.decisions || {})) {
        this.localDecisionsByPlacementId.set(key, value);
      }
      for (const [key, value] of Object.entries(parsed.placementLookup || {})) {
        this.localPlacementsByLookupKey.set(key, value);
      }
      for (const [key, value] of Object.entries(parsed.entitlements || {})) {
        this.localEntitlementsByHandle.set(key, value);
      }
      for (const [key, value] of Object.entries(parsed.userContexts || {})) {
        this.localUserContextsByUserId.set(key, value);
      }
      if (parsed.trialStatus) {
        this.localTrialStatus = parsed.trialStatus;
      }
    } catch {
      this.persistentStore.removeItem(this.localStorageKey);
      this.persistLocalRuntimeState();
    }
  }

  private persistLocalRuntimeState(): void {
    if (!this.isLocalOnlyMode()) return;
    try {
      const payload = {
        userContext: this.userContext,
        pageContext: this.pageContext,
        usageBalances: this.usageBalances,
        placements: Array.from(this.placements.values()),
        decisions: Object.fromEntries(this.localDecisionsByPlacementId.entries()),
        placementLookup: Object.fromEntries(this.localPlacementsByLookupKey.entries()),
        entitlements: Object.fromEntries(this.localEntitlementsByHandle.entries()),
        userContexts: Object.fromEntries(this.localUserContextsByUserId.entries()),
        trialStatus: this.localTrialStatus,
      };
      this.persistentStore.setItem(this.localStorageKey, JSON.stringify(payload));
    } catch {
      // Best effort persistence for local-only runtime.
    }
  }

  private decisionCacheStorageKey(): string {
    return `${DECISION_CACHE_STORAGE_PREFIX}:${this.tenantId}:${this.anonymousId}`;
  }

  private interactionStateStorageKey(): string {
    return `${INTERACTION_STATE_STORAGE_PREFIX}:${this.tenantId}:${this.anonymousId}`;
  }

  private presentationCapsStorageKey(): string {
    return `${PRESENTATION_CAPS_STORAGE_PREFIX}:${this.tenantId}:${this.anonymousId}`;
  }

  private hydrateDecisionCache(): void {
    const raw = this.sessionStore.getItem(this.decisionCacheStorageKey());
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as Record<string, CacheEntry<RevTurbinePlacementDecision>>;
      const now = Date.now();
      Object.entries(parsed).forEach(([key, entry]) => {
        if (!entry || typeof entry !== 'object') return;
        if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) return;
        this.decisionCache.set(key, entry);
      });
    } catch {
      this.sessionStore.removeItem(this.decisionCacheStorageKey());
    }
  }

  private persistDecisionCache(): void {
    const now = Date.now();
    const payload = Object.fromEntries(
      Array.from(this.decisionCache.entries()).filter(([, value]) => value.expiresAt > now),
    );
    try {
      this.sessionStore.setItem(this.decisionCacheStorageKey(), JSON.stringify(payload));
    } catch {
      // Swallow quota/serialization issues and continue with in-memory cache.
    }
  }

  private hydrateInteractionState(): void {
    const raw = this.persistentStore.getItem(this.interactionStateStorageKey());
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as Record<string, InteractionState>;
      Object.entries(parsed).forEach(([key, state]) => {
        if (!state || typeof state !== 'object') return;
        this.interactionState.set(key, state);
      });
    } catch {
      this.persistentStore.removeItem(this.interactionStateStorageKey());
    }
  }

  private persistInteractionState(): void {
    const payload = Object.fromEntries(this.interactionState.entries());
    try {
      this.persistentStore.setItem(this.interactionStateStorageKey(), JSON.stringify(payload));
    } catch {
      // Swallow quota/serialization issues and continue with in-memory state.
    }
  }

  private hydratePresentationCaps(): void {
    const raw = this.persistentStore.getItem(this.presentationCapsStorageKey());
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as Record<string, PresentationCapState>;
      for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue;
        const seenAt = Array.isArray(value.seenAt)
          ? value.seenAt.filter((ts): ts is number => Number.isFinite(ts) && ts > 0)
          : [];
        const cooldownUntil = Number.isFinite(value.cooldownUntil)
          ? value.cooldownUntil
          : undefined;
        this.presentationCapsByKey.set(key, { seenAt, cooldownUntil });
      }
    } catch {
      this.persistentStore.removeItem(this.presentationCapsStorageKey());
    }
  }

  private persistPresentationCaps(): void {
    try {
      const payload = Object.fromEntries(this.presentationCapsByKey.entries());
      this.persistentStore.setItem(this.presentationCapsStorageKey(), JSON.stringify(payload));
    } catch {
      // Best effort persistence.
    }
  }

  /**
   * The set of identifiers (lowercased plan id + unique_handle) that name the
   * user's CURRENT plan, so an `entitlement_rule` whose plan target carries
   * either form is matched. The app may set `plan.id` to the handle (`"free"`)
   * or the config id (`"plan_free"`); both resolve to the same plan here.
   */
  private activePlanIdentifiers(exportedConfig: RevTurbineConfig): Set<string> {
    const raw = (isRecord(this.userContext.plan) && typeof this.userContext.plan.id === 'string')
      ? this.userContext.plan.id
      : (typeof this.userContext.custom?.plan === 'string' ? this.userContext.custom.plan : '');
    const current = String(raw || '').toLowerCase();
    const ids = new Set<string>();
    if (!current) return ids;
    ids.add(current);
    for (const plan of exportedConfig.plans ?? []) {
      const id = typeof plan.id === 'string' ? plan.id.toLowerCase() : '';
      const handle = typeof plan.unique_handle === 'string' ? plan.unique_handle.toLowerCase() : '';
      if (id === current || handle === current) {
        if (id) ids.add(id);
        if (handle) ids.add(handle);
      }
    }
    return ids;
  }

  /** Whether a rule's plan targets include the active plan (no plan target = applies to all plans). */
  private ruleTargetsActivePlan(rule: JsonObject, activePlanIds: Set<string>): boolean {
    const targets = Array.isArray(rule.targets) ? rule.targets : [];
    const planTargets = targets.filter((t): t is JsonObject => isRecord(t) && t.kind === 'plan');
    if (planTargets.length === 0) return true;
    return planTargets.some((t) => typeof t.id === 'string' && activePlanIds.has(t.id.toLowerCase()));
  }

  private hydrateUsageLimitRulesFromExportedConfig(): void {
    const exportedConfig = this.getConfiguredExportedConfig();
    if (!exportedConfig) return;

    // Rebuilt on every context change (via recalculateDerivedUsageTraits), so
    // reset and re-scope to the CURRENT user's plan. Without this, every plan's
    // rule wrote to the same key (last-write-wins → the highest tier's limit
    // leaked to all users), and a plan switch kept the prior plan's limit.
    this.usageLimitByEntitlement.clear();
    const activePlanIds = this.activePlanIdentifiers(exportedConfig);

    const entitlementHandleById = new Map<string, string>();
    const entitlements = exportedConfig.entitlements ?? [];
    for (const item of entitlements) {
      const id = typeof item.id === 'string' ? item.id : '';
      const handle = typeof item.unique_handle === 'string' ? item.unique_handle : '';
      if (id && handle) entitlementHandleById.set(id, handle);
    }

    const rules = exportedConfig.entitlement_rules ?? [];

    for (const rule of rules) {
      if (!isRecord(rule)) continue;
      const entitlementId = typeof rule.entitlement_id === 'string'
        ? rule.entitlement_id
        : typeof rule.entitlementId === 'string'
          ? rule.entitlementId
          : '';
      if (!entitlementId) continue;

      const typeFields = isRecord(rule.type_fields)
        ? rule.type_fields
        : isRecord(rule.typeFields)
          ? rule.typeFields
          : {};
      const kind = typeof typeFields.kind === 'string' ? typeFields.kind : '';
      const supportsUsageThreshold = kind === 'usage_limit' || kind === 'credits' || kind === 'seat';
      if (!supportsUsageThreshold) continue;

      const entitlementHandle = entitlementHandleById.get(entitlementId) ?? '';

      const rawUsageUnit = typeof typeFields.usage_unit === 'string'
        ? typeFields.usage_unit
        : typeof typeFields.usageUnit === 'string'
          ? typeFields.usageUnit
          : '';

      const normalizedUsageUnit = sanitizeUsageTokenPrefix(rawUsageUnit);
      const prefix = normalizedUsageUnit && !looksGenericUsageUnit(normalizedUsageUnit)
        ? normalizedUsageUnit
        : usageTokenPrefixFromEntitlementId(entitlementHandle || entitlementId);
      if (prefix) {
        this.usageTokenPrefixByEntitlement.set(entitlementId, prefix);
        if (entitlementHandle) {
          this.usageTokenPrefixByEntitlement.set(entitlementHandle, prefix);
        }
      }

      const limit = Number(typeFields.limit_value ?? typeFields.allowance ?? typeFields.limit);
      if (!Number.isFinite(limit) || limit <= 0) continue;

      // Only record the limit when the rule applies to the user's current plan.
      // (The usage-unit prefix above is plan-agnostic and stays unconditional.)
      if (!this.ruleTargetsActivePlan(rule, activePlanIds)) continue;

      const warningPercentRaw = Number(
        rule.warning_threshold_percent
        ?? rule.warning_percentage
        ?? typeFields.warning_threshold_percent
        ?? typeFields.warning_percentage,
      );
      const warningPercent = Number.isFinite(warningPercentRaw) && warningPercentRaw > 0
        ? Math.min(100, warningPercentRaw)
        : this.defaultUsageWarningPercent;

      this.usageLimitByEntitlement.set(entitlementId, { limit, warningPercent });
      if (entitlementHandle) {
        this.usageLimitByEntitlement.set(entitlementHandle, { limit, warningPercent });
      }
    }
  }

  private recalculateDerivedUsageTraits(): void {
    const exportedConfig = this.getConfiguredExportedConfig();

    // Re-scope usage limits to the current plan on every context change — the
    // plan may have changed (identify / setUser) since the last hydrate.
    this.hydrateUsageLimitRulesFromExportedConfig();

    const usageTokens = recalculateDerivedUsageTokens({
      context: this.userContext,
      exportedConfig,
      usageBalances: this.usageBalances,
      usageTokenPrefixByEntitlement: this.usageTokenPrefixByEntitlement,
      usageThresholdLookup: (entitlement) => this.usageThresholdForEntitlement(entitlement),
    });

    const recommendationTokens = this.deriveRecommendedPlanTokens(exportedConfig);

    this.userContext = {
      ...this.userContext,
      personalization: { ...usageTokens, ...recommendationTokens },
    };
  }

  /**
   * Resolves `{{recommended_plan_handle}}` and `{{recommended_plan_name}}`
   * tokens against the user's current commercial plan (per Appendix C.3
   * and targeting-studio-ui.md §4.1 — the base plan, NOT the trial-grant
   * overlay). Falls back to empty strings when the user has no current
   * plan, the plan is at the top of the hierarchy, or the exported config
   * has no plans.
   *
   * Q-3 (plan #46) audit: `userContext.plan.id` is the commercial plan;
   * `effectivePlanHandle` (resolved separately in `deriveLocalEntitlement`
   * for reverse-trial grants) is the trial overlay. The spec example
   * "Free user on Pro reverse trial → recommends Pro" works because Free
   * is the base; next-tier-up from Free is Pro.
   */
  private deriveRecommendedPlanTokens(
    exportedConfig: RevTurbineConfig | undefined,
    recommendation?: { strategy: RecommendationStrategy; planOverride?: string },
  ): { recommended_plan_handle: string; recommended_plan_name: string } {
    const empty = { recommended_plan_handle: '', recommended_plan_name: '' };
    if (!exportedConfig?.plans?.length) return empty;

    const currentPlanHandleRaw =
      (typeof this.userContext.plan === 'object' && this.userContext.plan?.id)
      || (typeof this.userContext.custom?.plan === 'string' ? this.userContext.custom.plan : '');
    const currentPlanHandle = String(currentPlanHandleRaw || '').toLowerCase();

    const planIRs = exportedConfig.plans.map((p) => ({
      source_id: p.id,
      unique_handle: p.unique_handle,
      name: p.name,
      tier_position: p.tier_position ?? 0,
      sort_order: p.sort_order ?? 0,
    }));

    // Plan #47 (Q-1, option b): the user-context-time call uses the
    // `next_tier_up` default; per-placement callers (getPersonalizationTokens
    // with a payload) overlay a placement's authored strategy. Dispatch lives
    // in the parity-locked `resolveRecommendedPlanTokens` helper.
    return resolveRecommendedPlanTokens({
      strategy: recommendation?.strategy ?? 'next_tier_up',
      planOverride: recommendation?.planOverride,
      currentPlanHandle,
      plans: planIRs,
    });
  }

  /**
   * Return the SDK-resolved personalization token map.
   *
   * Reads from the transient `personalization` map on the user context,
   * which holds both SDK-derived tokens (plan_name, usage_current, etc.)
   * and app-provided tokens set via `setPersonalization()` or `identify()`.
   *
   * Pass the placement's payload (its `recommendation_strategy` /
   * `recommendation_plan_override` fields) to resolve the
   * `{{recommended_plan_handle}}` / `{{recommended_plan_name}}` tokens for
   * that specific placement (plan #47, Appendix C.3). Without a payload the
   * map carries the user-level `next_tier_up` default; with one, the
   * placement's authored strategy (e.g. a `custom` forced plan) overlays
   * those two tokens. All other tokens are unaffected.
   *
   * @param payload Optional placement payload carrying the per-placement
   *   recommendation strategy. Omit for the user-level default.
   */
  getPersonalizationTokens(payload?: {
    recommendation_strategy?: RecommendationStrategy | null;
    recommendation_plan_override?: string | null;
  }): RevTurbinePersonalizationTokens {
    const tokens: RevTurbinePersonalizationTokens = {};
    const personalization = this.userContext.personalization ?? {};

    for (const [key, value] of Object.entries(personalization)) {
      if (key === 'user_id') continue;
      if (typeof value === 'string' || typeof value === 'number') {
        tokens[key] = value;
      }
    }

    if (tokens.plan_name === undefined) {
      const configuredPlanName = configuredPlanNameFromExportedConfig(
        this.getConfiguredExportedConfig(),
        this.userContext.plan,
      );
      if (configuredPlanName) {
        tokens.plan_name = configuredPlanName;
      } else if (typeof this.userContext.plan === 'object' && this.userContext.plan?.name) {
        tokens.plan_name = this.userContext.plan.name;
      }
    }

    // Plan #47: when a placement payload is supplied, overlay the
    // placement-specific recommended-plan tokens (dispatched on its authored
    // strategy) on top of the user-level default.
    if (payload?.recommendation_strategy) {
      const recommended = this.deriveRecommendedPlanTokens(this.getConfiguredExportedConfig(), {
        strategy: payload.recommendation_strategy,
        planOverride: payload.recommendation_plan_override ?? undefined,
      });
      tokens.recommended_plan_handle = recommended.recommended_plan_handle;
      tokens.recommended_plan_name = recommended.recommended_plan_name;
    }

    return tokens;
  }

  /**
   * Return the SDK-resolved entitlement snapshot for the active user.
   *
   * The returned object is keyed by entitlement handle and reflects the
   * latest results from local/runtime checks tracked by the SDK.
   */
  getEntitlements(): Record<string, EntitlementResult> {
    return Object.fromEntries(this.localEntitlementsByHandle.entries());
  }

  /**
   * Return the SDK-resolved usage snapshot for the active user.
   *
   * Keys are usage units (derived from configured usage token prefixes when available),
   * and values include current usage plus optional limit when known.
   */
  getUsage(): RevTurbineUsageSnapshot {
    const mergedUsage: Record<string, number> = {
      ...usageAmountsFromEntries(this.userContext.usage),
      ...this.usageBalances,
    };

    const snapshot: RevTurbineUsageSnapshot = {};

    for (const [entitlementId, current] of Object.entries(mergedUsage)) {
      if (!Number.isFinite(current)) continue;

      const usageUnit = this.usageTokenPrefixByEntitlement.get(entitlementId)
        ?? usageTokenPrefixFromEntitlementId(entitlementId)
        ?? entitlementId;
      const threshold = this.usageThresholdForEntitlement(entitlementId);

      snapshot[usageUnit] = {
        current,
        ...(threshold?.limit !== undefined ? { limit: threshold.limit } : {}),
      };
    }

    return snapshot;
  }

  /**
   * Return current SDK policy snapshot.
   */
  getPolicy(): RevTurbinePolicySnapshot {
    const exportedConfig = this.getConfiguredExportedConfig();
    return {
      contextPolicy: this.policy,
      placementBehavior: this.placementBehavior,
      runtimeMode: this.runtimeMode,
      ...(typeof exportedConfig?.version === 'string' ? { exportedConfigVersion: exportedConfig.version } : {}),
    };
  }

  private deriveLocalEntitlementFromConfiguredRules(
    handle: string,
    context?: RevTurbineEntitlementContext,
  ): EntitlementResult | null {
    const exportedConfig = this.getConfiguredExportedConfig();
    if (!exportedConfig) return null;

    const currentPlanHandleRaw =
      (typeof this.userContext.plan === 'object' && this.userContext.plan?.id)
      || (typeof this.userContext.custom?.plan === 'string' ? this.userContext.custom.plan : '');
    const currentPlanHandle = String(currentPlanHandleRaw || '').toLowerCase();

    const targeting = this.getTargeting();
    const segmentIds = new Set(targeting.segmentIds ?? []);

    // Reverse-trial grant resolution (plan 43 TASK-8b). When the user
    // is mid-reverse-trial, look up the matching ReverseTrialRule by
    // matching `fallback_plan_id` against the user's base plan
    // (UserTrialStatus.plan_handle is the base plan for reverse
    // trials per scaffold's deriveLocalTrialStatusFromInstance).
    // The rule's `entitlements_during_trial[]` becomes the granted
    // set; `premium_plan_id` becomes effectivePlanHandle (the plan
    // whose limits should apply during the trial).
    const { trialGrantedEntitlementHandles, effectivePlanHandle } =
      this.resolveReverseTrialGrants(exportedConfig);

    return coreDeriveLocalEntitlement({
      handle,
      context,
      currentPlanHandle,
      segmentIds,
      usageBalances: this.usageBalances,
      userUsage: this.userContext.usage as Record<string, unknown> | undefined, // sdk-ok: boundary-parse
      exportedConfig,
      ...(trialGrantedEntitlementHandles !== undefined ? { trialGrantedEntitlementHandles } : {}),
      ...(effectivePlanHandle !== undefined ? { effectivePlanHandle } : {}),
    });
  }

  /**
   * Inline adapter — given a UserTrialStatus + the tenant's
   * reverse_trial_rules from RevTurbineConfig, derive the inputs that
   * close plan 43 TASK-2. Returns undefined fields when the user
   * isn't on an active reverse trial, when no rule matches, or when
   * the rule has no entitlements_during_trial[].
   *
   * Why inline (not calling scaffold's deriveReverseTrialGrants):
   * the scaffold helper takes a `TrialInstance` (DB-side state) and
   * matches by `rule_id`. The SDK only holds `UserTrialStatus` (the
   * transient runtime shape) and doesn't see the rule_id. We match
   * by `fallback_plan_id === plan_handle` instead — that's the
   * single configured rule the user can be on per spec §2.4.2.
   */
  private resolveReverseTrialGrants(
    exportedConfig: RevTurbineConfig,
  ): { trialGrantedEntitlementHandles?: ReadonlySet<string>; effectivePlanHandle?: string } {
    const trial = this.localTrialStatus;
    if (!trial.in_trial || trial.trial_type !== 'reverse') return {};
    const basePlanHandle = trial.plan_handle;
    if (!basePlanHandle) return {};
    const rules = exportedConfig.reverse_trial_rules ?? [];
    const rule = rules.find(
      (r) => r.fallback_plan_id === basePlanHandle && r.is_active !== false,
    );
    if (!rule || rule.entitlements_during_trial.length === 0) return {};
    return {
      trialGrantedEntitlementHandles: new Set(rule.entitlements_during_trial),
      effectivePlanHandle: rule.premium_plan_id,
    };
  }

  /**
   * Return the SDK-resolved targeting snapshot for the active user.
   *
   * Includes user id, segment ids, traits, plan, and merged usage so demo
   * surfaces can display the same context used by placement eligibility.
   */
  getTargeting(): RevTurbineTargeting {
    const userId = this.userContext.id || this.anonymousId;
    const cachedContext = this.localUserContextsByUserId.get(userId);
    const exportedConfig = this.getConfiguredExportedConfig();
    const configuredPlanName = configuredPlanNameFromExportedConfig(exportedConfig, this.userContext.plan);
    const effectivePlan = configuredPlanName
      ?? cachedContext?.plan
      ?? (typeof this.userContext.plan === 'object' && this.userContext.plan?.id ? this.userContext.plan.id : undefined);
    const configuredSegments = [...(exportedConfig?.segments ?? [])];
    const configuredTraitFields = Array.from(new Set(
      configuredSegments.flatMap((segment) => (segment.predicates ?? []).map((predicate) => predicate.field)),
    )).sort((a, b) => a.localeCompare(b));

    const traits: SdkTraits = {
      ...(cachedContext?.traits ?? {}),
      ...(this.userContext.custom ?? {}),
    } as SdkTraits;

    // Flatten entitlements into traits for segment evaluation
    for (const [key, value] of Object.entries(this.userContext.entitlements ?? {})) {
      if (traits[key] === undefined) {
        traits[key] = value;
      }
    }

    if (configuredPlanName && traits.plan_name === undefined) {
      traits.plan_name = configuredPlanName;
    }
    if (effectivePlan && traits.plan === undefined) {
      traits.plan = effectivePlan;
    }

    const usage: Record<string, number> = {
      ...(cachedContext?.usage ?? {}),
      ...usageAmountsFromEntries(this.userContext.usage),
      ...this.usageBalances,
    };

    for (const [key, value] of Object.entries(usage)) {
      if (traits[key] === undefined) {
        traits[key] = value;
      }
    }

    const segmentEvaluationTraits: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(traits)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        segmentEvaluationTraits[key] = value;
      }
    }

    if (this.segmentMembershipUserId !== userId) {
      this.segmentMembershipUserId = userId;
      this.markAllSegmentsDirty();
    }

    if (configuredSegments.length > 0 && this.segmentIdsByPredicateField.size === 0) {
      this.rebuildSegmentPredicateFieldIndex();
    }

    if (configuredSegments.length > 0 && this.dirtySegmentIds.size > 0) {
      for (const segmentId of this.dirtySegmentIds) {
        const segment = this.configuredSegmentsById.get(segmentId)
          ?? configuredSegments.find((candidate) => candidate.id === segmentId);
        if (!segment) {
          this.segmentMembershipBySegmentId.delete(segmentId);
          continue;
        }

        const matched = evaluateSegments([segment], segmentEvaluationTraits).length > 0;
        this.segmentMembershipBySegmentId.set(segmentId, matched);
      }
      this.dirtySegmentIds.clear();
    }

    const segmentIds = configuredSegments.length > 0
      ? configuredSegments
        .filter((segment) => this.segmentMembershipBySegmentId.get(segment.id) === true)
        .map((segment) => segment.id)
      : [...(cachedContext?.segmentIds ?? [])];

    return {
      userId,
      segmentIds,
      traits,
      ...(effectivePlan ? { plan: effectivePlan } : {}),
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      configuredSegments,
      configuredTraitFields,
    };
  }

  /**
   * Explain why a placement decision was selected.
   *
   * Returns a structured diagnostic payload that includes:
   * - Segment membership evaluation with predicate-level pass/fail details
   * - Entitlement-rule matching outcomes for current targeting context
   * - Placement decision metadata (`rule_id`, reason codes, suppression)
   *
   * Useful for debuggers, QA tooling, and customer-facing explainability UIs.
   */
  async explainPlacementDecision(
    input: RevTurbinePlacementDecisionInput,
  ): Promise<RevTurbinePlacementDecisionExplanation> {
    const decision = await this.getPlacementDecision(input);
    const targeting = this.getTargeting();
    const entitlements = this.getEntitlements();
    const policy = this.getPolicy();
    const exportedConfig = this.getConfiguredExportedConfig();

    const segmentSet = new Set(targeting.segmentIds);
    const segments: RevTurbineSegmentEvaluation[] = targeting.configuredSegments.map((segment) => {
      const predicates = Array.isArray(segment.predicates)
        ? segment.predicates.map((predicate) => evaluateSegmentPredicateForDiagnostics(predicate, targeting.traits as SdkTraits))
        : [];
      const matched = predicates.length > 0
        ? predicates.every((predicate) => predicate.matched)
        : segmentSet.has(segment.id);

      return {
        segmentId: segment.id,
        ...(segment.name ? { segmentName: segment.name } : {}),
        matched,
        predicates,
      };
    });

    const entitlementHandleById = new Map<string, string>();
    const entitlementTypeById = new Map<string, string>();
    if (Array.isArray(exportedConfig?.entitlements)) {
      for (const entitlement of exportedConfig.entitlements) {
        const entitlementId = firstStringValue(entitlement.id);
        const entitlementHandle = firstStringValue(entitlement.unique_handle, entitlementId);
        if (entitlementId && entitlementHandle) {
          entitlementHandleById.set(entitlementId, entitlementHandle);
        }
        const entType = firstStringValue(entitlement.type);
        if (entitlementId && entType) {
          entitlementTypeById.set(entitlementId, entType);
        }
      }
    }

    const planHandleById = new Map<string, string>();
    if (Array.isArray(exportedConfig?.plans)) {
      for (const plan of exportedConfig.plans) {
        const planId = firstStringValue(plan.id);
        const planHandle = firstStringValue(plan.unique_handle);
        if (planId && planHandle) {
          planHandleById.set(planId, planHandle);
        }
      }
    }

    const currentPlanIdOrHandle = firstStringValue(
      targeting.plan,
      targeting.traits.plan,
      targeting.traits.plan_handle,
      targeting.traits.plan_id,
    ) ?? '';
    const normalizedCurrentPlan = currentPlanIdOrHandle.toLowerCase();

    // Build a segment_id → dimension_id lookup so the diagnostic mirrors
    // scaffold's intra-dimension-OR + cross-dimension-AND evaluator
    // (plan #39 REQ-8 / REQ-28). Older exports without `dimension_id`
    // fall back to flat-OR via the `__no_dim__` bucket inside the helper.
    const segmentDimensionsById = new Map<string, string>();
    if (Array.isArray(exportedConfig?.segments)) {
      for (const segment of exportedConfig.segments) {
        const segId = firstStringValue(segment.id);
        const dim = firstStringValue(segment.dimension_id);
        if (segId && dim) segmentDimensionsById.set(segId, dim);
      }
    }

    const entitlementRules: RevTurbineEntitlementRuleEvaluation[] = Array.isArray(exportedConfig?.entitlement_rules)
      ? exportedConfig.entitlement_rules
        .map((rule, index) => {
          const ruleId = firstStringValue(rule.id) ?? `entitlement_rule_${index}`;
          const entitlementId = firstStringValue(rule.entitlement_id);
          const entitlementHandle = entitlementId
            ? entitlementHandleById.get(entitlementId)
            : undefined;
          // Plan scoping derives from kind:'plan' targets. `plan_ids` was
          // removed from the canonical RevTurbineConfig entitlement rule in
          // plan 32 (`targets.min(1)`); plan-kind targets carry the same
          // plan ids. Matches the scaffold evaluators (entitlement-check.ts
          // / rules.ts) so the SDK doesn't drift from the reference.
          const planIds = Array.isArray(rule.targets)
            ? rule.targets.filter((t) => t.kind === 'plan').map((t) => t.id)
            : [];
          const planScopes = planIds.map((planId) => planHandleById.get(planId) ?? planId);
          const segmentIds = Array.isArray(rule.segment_ids)
            ? rule.segment_ids.filter((s): s is string => typeof s === 'string')
            : [];
          const typeFields = isRecord(rule.type_fields) ? rule.type_fields : {};
          const kind = firstStringValue(typeFields.kind);

          // Canonical targeting is explicit (plan 34 REQ-9 dropped the
          // implicit "empty ⇒ all plans" branch from both scaffold
          // evaluators). The no-plan-context tolerance is unchanged.
          const matchesPlan = !normalizedCurrentPlan
            || planIds.some((planId) => planId.toLowerCase() === normalizedCurrentPlan);
          const matchesSegment = matchesEntitlementRuleSegmentsForDiagnostics(
            segmentIds,
            segmentSet,
            segmentDimensionsById,
          );
          const matched = matchesPlan && matchesSegment;

          const entitlementState = entitlementHandle
            ? entitlements[entitlementHandle]
            : entitlementId
              ? entitlements[entitlementId]
              : undefined;

          const outcome: EntitlementStatus | 'unknown' = matched
            ? (entitlementState?.status ?? 'unknown')
            : 'unknown';

          // Build human-readable outcome description based on the rule's kind
          // and type_fields so the inspector shows *what* this rule grants
          // instead of a raw status string.
          let outcomeDescription: string | undefined;
          if (matched) {
            switch (kind) {
              case 'feature':
                outcomeDescription = typeFields.enabled === false
                  ? 'disables feature'
                  : 'grants access';
                break;
              case 'capability_tier': {
                const tierName = firstStringValue(typeFields.tier_name);
                outcomeDescription = tierName
                  ? `unlocks ${tierName} tier`
                  : 'unlocks capability tier';
                break;
              }
              case 'usage_limit': {
                const limitVal = typeof typeFields.limit_value === 'number' ? typeFields.limit_value : undefined;
                const unit = firstStringValue(typeFields.unit) ?? '';
                const period = firstStringValue(typeFields.period) ?? '';
                const periodLabel = period ? ` / ${period.replace('per_', '')}` : '';
                outcomeDescription = limitVal != null
                  ? `sets limit to ${limitVal.toLocaleString()}${unit ? ` ${unit}` : ''}${periodLabel}`
                  : 'sets usage limit';
                break;
              }
              case 'credits': {
                const allowance = typeof typeFields.allowance === 'number' ? typeFields.allowance : undefined;
                const creditUnit = firstStringValue(typeFields.unit) ?? 'credits';
                const creditPeriod = firstStringValue(typeFields.period) ?? '';
                const creditPeriodLabel = creditPeriod ? ` / ${creditPeriod.replace('per_', '')}` : '';
                outcomeDescription = allowance != null
                  ? `grants ${allowance.toLocaleString()} ${creditUnit}${creditPeriodLabel}`
                  : 'grants credit allowance';
                break;
              }
              case 'seat': {
                const seats = typeof typeFields.included_seats === 'number' ? typeFields.included_seats : undefined;
                outcomeDescription = seats != null
                  ? `includes ${seats} seat${seats === 1 ? '' : 's'}`
                  : 'includes seats';
                break;
              }
              default:
                // Fall back to the entitlement type from the parent entitlement
                // if the rule kind is absent.
                if (entitlementId) {
                  const parentType = entitlementTypeById.get(entitlementId);
                  if (parentType === 'feature') outcomeDescription = 'grants access';
                  else if (parentType) outcomeDescription = `${parentType.replace(/_/g, ' ')} entitlement`;
                }
                break;
            }
          }

          return {
            ruleId,
            ...(entitlementId ? { entitlementId } : {}),
            ...(entitlementHandle ? { entitlementHandle } : {}),
            ...(kind ? { kind } : {}),
            planScopes,
            planIds,
            ...(segmentIds.length > 0 ? { segmentIds } : {}),
            matchesPlan,
            matchesSegment,
            matched,
            outcome,
            ...(outcomeDescription ? { outcomeDescription } : {}),
            ...(entitlementState?.reason ? { reason: entitlementState.reason } : {}),
          };
        })
      : [];

    const selectedPayloadId = firstStringValue(decision.output?.output_id);
    const placementRecord = this.placements.get(input.placementId);
    const inputPlacementName = firstStringValue(placementRecord?.name) ?? '';
    const slotTemplateIds: string[] = Array.isArray(placementRecord?.metadata?.surface_template_ids)
      ? (placementRecord!.metadata!.surface_template_ids as string[])
      : [];

    // Collect all config placements relevant to this slot.
    // 1. Exact match by decision output rule_id (the selected placement).
    // 2. Name-based match (legacy).
    // 3. Template-based match — any placement with a surface template in the slot's accepted list.
    const candidatePlacements: RevTurbineConfigPlacementItem[] = [];
    const seenPlacementIds = new Set<string>();

    if (Array.isArray(exportedConfig?.placements)) {
      for (const configPlacement of exportedConfig.placements) {
        if (!configPlacement || typeof configPlacement !== 'object') continue;
        const configId = firstStringValue(configPlacement.id) ?? '';
        const configName = firstStringValue(configPlacement.name) ?? '';
        if (seenPlacementIds.has(configId)) continue;

        // Match by decision output (selected placement)
        const decisionRuleId = firstStringValue(decision.output?.rule_id);
        if (decisionRuleId && configId === decisionRuleId) {
          seenPlacementIds.add(configId);
          candidatePlacements.push(configPlacement);
          continue;
        }

        // Legacy name match
        if (inputPlacementName && (
          configId === inputPlacementName
          || configName === inputPlacementName
          || configId === `pl_${inputPlacementName}`
          || configName === `pl_${inputPlacementName}`
        )) {
          seenPlacementIds.add(configId);
          candidatePlacements.push(configPlacement);
          continue;
        }

        // Template-based match: any config placement with an active payload
        // whose surface template overlaps the slot's accepted templates.
        if (slotTemplateIds.length > 0) {
          const payloads = configPlacement.payloads ?? [];
          const matchesTemplate = payloads.some((payload) => {
            const surfaces = payload.surfaces ?? [];
            return surfaces.some((surface) => {
              const tid = firstStringValue(surface.template_id);
              return tid ? slotTemplateIds.includes(tid) : false;
            });
          });
          if (matchesTemplate) {
            seenPlacementIds.add(configId);
            candidatePlacements.push(configPlacement);
          }
        }
      }
    }

    const eligiblePayloads: RevTurbinePlacementPayloadEvaluation[] = candidatePlacements.flatMap((configPlacement) => {
      const payloads = configPlacement.payloads ?? [];
      return payloads.map((payload) => {
        const target = payload.target;
        const payloadPlanIds: string[] = target?.plan_ids ?? [];
        const payloadPlanScopes = payloadPlanIds.map((planId: string) => planHandleById.get(planId) ?? planId);
        const segmentChips: string[] = target?.segment_chips ?? [];
        const surfaces = payload.surfaces ?? [];
        const surfaceTemplateIds = surfaces
            .map((surface) => firstStringValue(surface.template_id))
            .filter((item: string | undefined): item is string => typeof item === 'string');

        const matchesPlan = payloadPlanIds.length === 0
          || !normalizedCurrentPlan
          || payloadPlanIds.some((planId: string) => planId.toLowerCase() === normalizedCurrentPlan);
        const matchesSegment = segmentChips.length === 0
          || segmentChips.some((segmentId: string) => segmentSet.has(segmentId));
        // Plan 76: the stored payload status was removed — presence in a live
        // config means released, so a payload's status is always 'active'
        // (runtime status is derived control-plane side).
        const status: 'draft' | 'active' | 'disabled' = 'active';
        const eligible = status === 'active' && matchesPlan && matchesSegment;

        return {
          payloadId: String(payload.id ?? ''),
          placementId: String(configPlacement.id ?? ''),
          placementName: String(configPlacement.name ?? ''),
          status,
          planIds: payloadPlanIds,
          planScopes: payloadPlanScopes,
          segmentChips,
          surfaceTemplateIds,
          matchesPlan,
          matchesSegment,
          eligible,
          selected: !!selectedPayloadId && selectedPayloadId === String(payload.id ?? ''),
        };
      });
    });

    const capPolicies = decision.output
      ? this.extractPlacementCapPolicies(decision.output).flatMap((policy) => {
        if (policy.rules.length === 0 && policy.cooldownMs === undefined) {
          return [];
        }

        if (policy.rules.length === 0) {
          return [{ count: 0, period: 'session' as const, cooldownMs: policy.cooldownMs }];
        }

        return policy.rules.map((rule) => ({
          count: rule.count,
          period: rule.period,
          ...(policy.cooldownMs !== undefined ? { cooldownMs: policy.cooldownMs } : {}),
        }));
      })
      : [];

    const placementRules: RevTurbinePlacementRuleEvaluation = {
      ruleId: decision.output?.rule_id,
      decisionId: decision.output?.decision_id,
      category: decision.output?.category,
      suppressionReason: decision.suppressionReason,
      reasonCodes: decision.reasonCodes,
      capPolicies,
    };

    return {
      generatedAt: new Date().toISOString(),
      input,
      decision,
      targeting,
      policy,
      entitlements,
      segments,
      entitlementRules,
      eligiblePayloads,
      placementRules,
    };
  }

  private usageThresholdForEntitlement(entitlement: string): { limit: number; warningPercent: number } | null {
    return coreUsageThreshold(
      entitlement,
      this.usageLimitByEntitlement,
      this.localEntitlementsByHandle,
      this.usageBalances,
      this.defaultUsageWarningPercent,
    );
  }

  private evaluateUsageThresholdCrossings(prevUsage: Record<string, number>, nextUsage: Record<string, number>): Array<Promise<void>> {
    const crossings = coreEvaluateUsageCrossings(
      prevUsage,
      nextUsage,
      (entitlement) => this.usageThresholdForEntitlement(entitlement),
    );
    return crossings.map((crossing) => this.emitTrigger(crossing.type, {
      entitlement_handle: crossing.entitlement_handle,
      current_usage: crossing.current_usage,
      usage_limit: crossing.usage_limit,
      usage_percent: crossing.usage_percent,
      threshold: crossing.threshold,
    }));
  }

  private deriveTrialTriggerStage(status: RevTurbineTrialContext): 'none' | 'midpoint' | 'expiring' | 'expired' {
    return coreDeriveTrialStage(status, this.lastTrialTriggerStage, this.defaultTrialExpiringDays);
  }

  private async evaluateTrialLifecycleTriggers(status: RevTurbineTrialContext): Promise<void> {
    const nextStage = this.deriveTrialTriggerStage(status);

    if (!this.placementBehavior.enableTrialAutoTriggers) {
      this.lastTrialTriggerStage = nextStage;
      return;
    }

    if (nextStage === this.lastTrialTriggerStage) return;
    this.lastTrialTriggerStage = nextStage;

    if (nextStage === 'midpoint') {
      await this.emitTrigger('trial_midpoint', { days_remaining: status.days_remaining });
      return;
    }
    if (nextStage === 'expiring') {
      await this.emitTrigger('trial_expiring', { days_remaining: status.days_remaining });
      return;
    }
    if (nextStage === 'expired') {
      await this.emitTrigger('trial_expired', { days_remaining: 0 });
    }
  }

  private resolveAnonymousId(): string {
    const storageKey = `revturbine:${this.tenantId}:anon`; 
    try {
      const existing = this.persistentStore.getItem(storageKey);
      if (existing) return existing;

      const generated = requestId();
      this.persistentStore.setItem(storageKey, generated);
      return generated;
    } catch {
      // Fallback to per-session anonymous id when storage is unavailable.
      return requestId();
    }
  }

  private installBridge(): void {
    const bridge: RevTurbineBridge = {
      getSnapshot: () => ({
        tenantId: this.tenantId,
        user: this.userContext,
        page: this.pageContext,
        placements: Array.from(this.placements.values()),
      }),
      setPageContext: (context) => {
        this.setPageContext(context);
      },
      setUserContext: (context) => {
        this.setUserContext(context);
      },
    };

    (window as Window & { __RT_SDK_BRIDGE__?: RevTurbineBridge }).__RT_SDK_BRIDGE__ = bridge;
  }

  private installRouteTracking(): void {
    if (isServer()) return;
    const historyRef = window.history as HistoryWithPatchMarker;
    if (historyRef.__rtPatched) {
      return;
    }

    const emitRouteChange = () => {
      window.dispatchEvent(new CustomEvent(ROUTE_CHANGE_EVENT, {
        detail: {
          path: window.location.pathname,
          title: document.title,
        },
      }));
    };

    const originalPushState = historyRef.pushState.bind(historyRef);
    historyRef.pushState = ((...args: Parameters<History['pushState']>) => {
      originalPushState(...args);
      emitRouteChange();
    }) as History['pushState'];

    const originalReplaceState = historyRef.replaceState.bind(historyRef);
    historyRef.replaceState = ((...args: Parameters<History['replaceState']>) => {
      originalReplaceState(...args);
      emitRouteChange();
    }) as History['replaceState'];

    window.addEventListener('popstate', emitRouteChange);
    window.addEventListener(ROUTE_CHANGE_EVENT, (event) => {
      const detail = (event as CustomEvent<{ path: string; title?: string; tags?: string[] }>).detail;
      this.onRouteChange({
        path: detail.path,
        title: detail.title,
        tags: detail.tags,
      });
    });

    historyRef.__rtPatched = true;
  }

  private mergeUserContext(next: Partial<RevTurbineUserContext>): RevTurbineUserContext {
    return coreMergeUserContext(this.userContext, next) as RevTurbineUserContext;
  }

  private mergePageContext(next: RevTurbinePageContext): RevTurbinePageContext {
    return {
      ...this.pageContext,
      ...next,
      tags: ensureArray(next.tags || this.pageContext.tags),
    };
  }

  private collectPageContextIssues(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const resolvedPage = {
      ...(this.policy.inferPage ? inferPageContext() : {}),
      ...this.pageContext,
    };

    const resolvedUrl = String(resolvedPage.url || '').trim();
    if (!resolvedUrl) {
      issues.push({ code: 'invalid_page_context_url', reason: 'Page context URL is missing.' });
    } else {
      try {
        new URL(resolvedUrl);
      } catch {
        issues.push({
          code: 'invalid_page_context_url',
          reason: 'Page context URL is not a valid absolute URL.',
          details: { value: resolvedUrl },
        });
      }
    }

    if (resolvedPage.tags && !Array.isArray(resolvedPage.tags)) {
      issues.push({ code: 'invalid_page_context_tags', reason: 'Page tags must be an array of strings.' });
    }

    return issues;
  }

  private collectPayloadIssues(payload: unknown): ValidationIssue[] { // sdk-ok: boundary-parse
    const issues: ValidationIssue[] = [];

    if (!isRecord(payload)) {
      issues.push({ code: 'invalid_event_payload', reason: 'Event payload must be a plain object.' });
      return issues;
    }

    const semanticPayload = isRecord(payload.payload) ? payload.payload : null;
    const placementId = (typeof payload.placement_id === 'string' && payload.placement_id.trim())
      ? payload.placement_id
      : (typeof semanticPayload?.placement_id === 'string' ? semanticPayload.placement_id : null);
    if (typeof placementId === 'string' && placementId.trim()) {
      if (!this.placements.has(placementId)) {
        issues.push({
          code: 'unknown_placement_id',
          reason: 'Payload placement_id is not registered in SDK runtime.',
          details: { placement_id: placementId },
        });
      }
    }

    return issues;
  }

  private buildValidationWarningEvent(
    normalizedEventType: string,
    issues: ValidationIssue[],
    payload: unknown, // sdk-ok: boundary-parse
  ): RevTurbineEventEnvelope {
    return this.toEventEnvelope(SDK_WARNING_EVENT_TYPE, {
      source_event_type: normalizedEventType,
      warning_count: issues.length,
      warning_codes: issues.map((issue) => issue.code),
      warnings: issues as unknown as JsonValue, // sdk-ok: boundary-parse
      page_context: {
        url: this.pageContext.url ?? null,
        title: this.pageContext.title ?? null,
      },
      payload_snapshot: isRecord(payload) ? payload : null,
    });
  }

  private toEventEnvelope(type: string, properties: SdkEventProperties): RevTurbineEventEnvelope {
    const resolvedPage = {
      ...(this.policy.inferPage ? inferPageContext() : {}),
      ...this.pageContext,
    };

    const url = resolvedPage.url || (isBrowser() ? window.location.href : '');
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return isBrowser() ? window.location.pathname : '/';
      }
    })();

    return {
      tenant_id: this.tenantId,
      type,
      level: 'INFO',
      message: `${type} captured by ${this.mode} runtime`,
      url,
      path,
      page_title: resolvedPage.title || (isBrowser() ? document.title : ''),
      event_time: new Date().toISOString(),
      anonymous_id: this.anonymousId,
      user_id: this.userContext.id || null,
      session_id: this.sessionId,
      tags: ensureArray(resolvedPage.tags),
      identity: {
        tenant_id: this.tenantId,
        user_id: this.userContext.id || null,
        anonymous_id: this.anonymousId,
        // The field-names signal (plan 114 TASK-4) is names-only: it must never
        // carry the custom VALUES that other events attach as traits (AC-9).
        traits: type === USER_CONTEXT_FIELDS_EVENT ? {} : { ...(this.userContext.custom || {}) },
      },
      properties,
    };
  }

  /**
   * Emit the one-time PII-redaction notice (plan 106 REQ-7). Idempotent per
   * SDK instance so a noisy event stream never floods the console.
   */
  private warnPiiRedactedOnce(): void {
    if (this.piiRedactionWarned) return;
    this.piiRedactionWarned = true;
    console.warn(
      '[RevTurbine] Detected and redacted PII-shaped values (emails / card numbers) ' +
        'from event data before sending. Do not put PII in event properties or traits; ' +
        'this is best-effort redaction, not a guarantee.',
    );
  }

  // ── Keyless anonymous SDK telemetry (plan 95 TASK-7) ──────────────────────
  //
  // When NO ingest key is configured, the SDK still reports a minimal,
  // anonymous adoption signal to the non-authed /api/sdk/meta endpoint:
  // config-shape COUNTS only + a one-way hashed config id, never any user
  // context or PII (REQ-6/REQ-7/REQ-9). On by default, opt out via
  // `anonymousTelemetry: false` (REQ-8); a one-time console notice names the
  // flag (REQ-8b).

  /** True when keyless anonymous telemetry should fire (REQ-4 conditions). */
  private anonymousTelemetryActive(): boolean {
    return (
      !this.ingestPublicKey && // keyless only — a keyed install uses /api/track
      this.anonymousTelemetryEnabled &&
      !this.isLocalOnlyMode() &&
      isBrowser()
    );
  }

  /** Fire the one anonymous `sdk_init` adoption beacon at startup. */
  private async emitSdkInitTelemetry(): Promise<void> {
    if (!this.anonymousTelemetryActive()) return;
    await this.emitAnonMeta('sdk_init', { config_shape: this.computeConfigShape() });
  }

  /**
   * Config-shape COUNTS only (REQ-6) — number of plans/entitlements/rules/etc.
   * No names, ids, or user context. Returns undefined when no config is loaded.
   */
  private computeConfigShape(): SdkConfigShapeBody | undefined {
    const cfg = this.getConfiguredExportedConfig();
    if (!cfg) return undefined;
    const placements = cfg.placements ?? [];
    const placementPayloads = placements.reduce(
      (total, placement) => total + (placement.payloads?.length ?? 0),
      0,
    );
    return {
      plans: cfg.plans?.length ?? 0,
      entitlements: cfg.entitlements?.length ?? 0,
      entitlement_rules: cfg.entitlement_rules?.length ?? 0,
      segments: cfg.segments?.length ?? 0,
      placements: placements.length,
      placement_payloads: placementPayloads,
      content_ui_paths: cfg.content_ui_paths?.length ?? 0,
      surface_templates: cfg.surface_templates?.length ?? 0,
    };
  }

  /**
   * Build + POST one allowlisted anonymous meta event to /api/sdk/meta.
   * No auth header (keyless), no tenant in the body (REQ-9), best-effort and
   * non-throwing. Stamps SDK/schema versions + a one-way hashed config id.
   */
  private async emitAnonMeta(
    eventType: components['schemas']['SdkMetaEventType'],
    extra: Pick<SdkMetaEventBody, 'config_shape' | 'message'> = {},
  ): Promise<void> {
    if (!this.anonymousTelemetryActive()) return;

    this.showAnonTelemetryNoticeOnce();

    // Whole body is best-effort: hashing, serialization, AND delivery must
    // never throw into the host app (REQ-3/REQ-4).
    try {
      const cfg = this.getConfiguredExportedConfig();
      const bundleVersion = cfg?.version != null ? String(cfg.version) : undefined;
      // One-way, non-reversible attribution so distinct deployments can be
      // counted without exposing the real id (REQ-7). The tenant handle is an
      // explicitly-sanctioned, non-secret input; hashing it is the point.
      const hashInput = bundleVersion ? `${this.tenantId}:${bundleVersion}` : this.tenantId;
      const configHashId = (await sha256Base64Url(hashInput)).slice(0, 64);

      const event: SdkMetaEventBody = {
        event_type: eventType,
        occurred_at: new Date().toISOString(),
        request_id: requestId(),
        config_hash_id: configHashId,
        sdk_version: SDK_VERSION,
        runtime_mode: this.runtimeMode,
        // schema_version is intentionally omitted: the only source
        // (@revt-eng/core/bundle SCHEMA_VERSION) drags the bundle compiler
        // into the client SDK. bundle_version (the RevTurbineConfig version)
        // and sdk_version already carry the meaningful version signal.
        ...(bundleVersion ? { bundle_version: bundleVersion } : {}),
        ...(extra.config_shape ? { config_shape: extra.config_shape } : {}),
        ...(extra.message ? { message: extra.message.slice(0, 500) } : {}),
      };
      const body: SdkMetaIngestBatchBody = { events: [event] };

      await fetch(this.endpointFor('ingestSdkMeta', SDK_META_GATEWAY_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      });
    } catch {
      // Best-effort: anonymous telemetry must never throw into the host app.
    }
  }

  /** One-time info notice that keyless telemetry is active + how to disable it (REQ-8b). */
  private showAnonTelemetryNoticeOnce(): void {
    if (this.anonTelemetryNoticeShown) return;
    this.anonTelemetryNoticeShown = true;
    console.info(
      '[RevTurbine] Sending anonymous SDK telemetry (config-shape counts and SDK ' +
        'version only — no user data or PII). Disable it by setting ' +
        '`anonymousTelemetry: false` in your initRevTurbine() options.',
    );
  }

  private async sendEvents(events: RevTurbineEventEnvelope[]): Promise<void> {
    if (events.length === 0) return;

    // Fan out to registered EventConsumer providers (analytics adapters, etc.)
    this.dispatchToEventConsumers(events);

    if (this.isLocalOnlyMode()) {
      this.persistLocalRuntimeState();
      return;
    }

    // Analytics opt-out (plan 106 REQ-8): when disabled, emit NOTHING to
    // /api/track across every path. Consumer dispatch + local state above
    // are intentionally unaffected — this flag governs only the RevTurbine
    // ingest network call.
    if (!this.analyticsEnabled) return;

    const rid = requestId();
    let valuesRedacted = 0;
    // Map each envelope to the canonical scaffold `TrackEvent`
    // (`@revt-eng/schema`). The SDK has no first-class environment /
    // account concept, so: `environment_id` comes from the init option
    // (default `'default'`), `user_id` falls back to the always-present
    // anonymous id, and `account_id` falls back through user → anon so
    // the required min-1 fields are never empty. The full SDK property
    // bag (level/message/url/traits/raw payload) is preserved as the
    // optional `properties` JSON string; `experiment_id`/`variant_key`
    // are lifted out so they survive end-to-end (plan 41 REQ-7).
    const trackEvents: TrackEvent[] = events.map((event) => {
      const rawUserId = event.user_id || event.anonymous_id;
      const rawAccountId = this.userContext.account_id || rawUserId;
      // Best-effort redaction BEFORE the value leaves the browser (plan 106
      // REQ-6): scrub obvious PII out of the property bag and hash
      // email-shaped identity ids. The server-side scrub at /api/track is
      // the authoritative gate; this is defense-in-depth.
      const userId = redactIdentityField(rawUserId);
      const accountId = redactIdentityField(rawAccountId);
      const redactedProps = redactPii({
        level: event.level,
        message: event.message,
        path: event.path,
        url: event.url,
        page_title: event.page_title,
        session_id: event.session_id,
        anonymous_id: event.anonymous_id,
        tags: event.tags,
        traits: event.identity.traits ?? null,
        payload: event.properties,
        source: SDK_EVENT_SOURCE,
      });
      valuesRedacted +=
        redactedProps.redactions + (userId.redacted ? 1 : 0) + (accountId.redacted ? 1 : 0);
      return {
        environment_id: this.environmentId,
        user_id: userId.value,
        account_id: accountId.value,
        event_name: normalizeEventType(event.type).slice(0, 120),
        event_ts: event.event_time,
        properties: JSON.stringify(redactedProps.value),
        surface_slot_id: pickClickstreamField(event.properties, 'surface_slot_id'),
        placement_id: pickClickstreamField(event.properties, 'placement_id'),
        payload_id: pickClickstreamField(event.properties, 'payload_id'),
        request_id: requestId(),
        experiment_id: pickClickstreamField(event.properties, 'experiment_id'),
        variant_key: pickClickstreamField(event.properties, 'variant_key'),
        tenant_id: event.tenant_id,
      };
    });

    // One-time warning when redaction fired (plan 106 REQ-7): tell the
    // developer that PII-shaped values were stripped and how to avoid it.
    // Once per SDK instance — never per event, never when nothing redacted.
    if (valuesRedacted > 0) this.warnPiiRedactedOnce();

    // `/api/track` accepts ONLY a `public` ingest token; the tenant is
    // derived from the verified token, never a header (plan 41 REQ-13),
    // so no `x-tenant-id` is sent. Best-effort: ingest failures must
    // never throw into the customer app, and there is no legacy fallback
    // sink (plan 41 Q-3 — `/api/telemetry` retired in TASK-4b).
    try {
      await fetch(this.endpointFor('ingestEvents', INGEST_GATEWAY_PATH), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.ingestPublicKey ?? this.apiKey}`,
          'x-request-id': rid,
        },
        body: JSON.stringify({ events: trackEvents }),
        // keepalive lets a page-unload flush (pagehide / visibilitychange)
        // complete after the document starts tearing down (plan 95 TASK-6).
        keepalive: true,
      });
    } catch {
      // Swallow — telemetry delivery is best-effort and non-fatal.
    }
  }

  private dispatchToEventConsumers(events: RevTurbineEventEnvelope[]): void {
    if (!this.providerRegistry.has('events')) return;
    void this.providerRegistry.get('events').then((resolved) => {
      const consumers = (resolved as { consumers?: Array<{ consume(events: RevTurbineEventEnvelope[]): void | Promise<void> }> } | undefined)?.consumers;
      if (!consumers || consumers.length === 0) return;
      for (const consumer of consumers) {
        try {
          consumer.consume(events);
        } catch {
          // Never let a consumer error crash the SDK event pipeline.
        }
      }
    }).catch(() => {
      // Registry resolution failed — that's fine, don't block event flow.
    });
  }

  async capture(eventName: string, properties: SdkEventProperties, options?: RevTurbineEventOptions): Promise<void> {
    const normalizedEventType = normalizeEventType(eventName);
    const primaryEnvelope = this.toEventEnvelope(normalizedEventType, properties);

    const issues = [
      ...this.collectPageContextIssues(),
      ...this.collectPayloadIssues(properties),
    ];

    const envelopesToQueue = [primaryEnvelope];
    if (issues.length > 0) {
      envelopesToQueue.push(this.buildValidationWarningEvent(normalizedEventType, issues, properties));
    }

    if (options?.immediate) {
      await this.sendEvents(envelopesToQueue);
      return;
    }

    this.events.push(...envelopesToQueue);
    if (this.events.length >= this.maxBatchSize) {
      await this.flushEvents();
    }
  }

  /**
   * Emit a typed control-plane semantic event (plan 112).
   *
   * The dogfood-faithful surface for RevTurbine's own product activity:
   * `eventType` is constrained to the canonical {@link ControlPlaneEventType}
   * taxonomy and the `system`/`workflow` source classification is stamped
   * automatically. Forwards through the same ingest + consumer path as
   * {@link capture} — so the event lands in clickstream AND any registered
   * analytics resolver (e.g. a PostHog provider from
   * {@link createPostHogAnalyticsProvider}).
   *
   * Identity comes from the active user context set via {@link identify} /
   * {@link setUserContext}: the operator is `user_id` and the acting RevTurbine
   * customer tenant is `account_id`. `tenant_id` is stamped server-side and is
   * never carried on the event (plan 112 REQ-3/REQ-4).
   *
   * @param eventType - A canonical control-plane event type.
   * @param payload - Optional event-specific properties (e.g. `{ resource, resource_id }`).
   * @param options - Emit options, e.g. `{ immediate: true }` to bypass batching.
   *
   * @example
   * ```ts
   * sdk.identify('operator_42', { account_id: 'tn_acme' });
   * await sdk.trackControlPlaneEvent('changeset_deployed', { change_set_id: 'cs_9' });
   * ```
   */
  async trackControlPlaneEvent(
    eventType: ControlPlaneEventType,
    payload: SdkEventProperties = {},
    options?: RevTurbineEventOptions,
  ): Promise<void> {
    const { eventName, properties } = buildControlPlaneEvent(eventType, payload);
    await this.capture(eventName, properties, options);
  }

  /**
   * Flush any buffered clickstream events to `POST /api/track` immediately.
   *
   * Called on the size threshold, the {@link RevTurbineEventBatchingOptions}
   * interval timer, and page-unload. Best-effort and non-throwing — delivery
   * failures are swallowed (plan 95 REQ-3). Safe to call when the buffer is
   * empty (no-op).
   */
  async flushEvents(): Promise<void> {
    if (this.events.length === 0) return;
    const batch = [...this.events];
    this.events.length = 0;
    await this.sendEvents(batch);
  }

  /**
   * Install the interval timer + page-unload listeners that flush buffered
   * clickstream events (plan 95 TASK-6). Browser-only and skipped in
   * `local_only` mode (no network sink). Listeners are released by
   * {@link dispose}.
   */
  private startEventBatchFlushing(): void {
    if (!isBrowser() || this.isLocalOnlyMode()) return;

    if (this.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flushEvents();
      }, this.flushIntervalMs);
      // Don't keep a (non-browser) event loop alive purely for the flush tick.
      (this.flushTimer as { unref?: () => void }).unref?.();
    }

    const flushOnHide = () => {
      void this.flushEvents();
    };
    const flushOnVisibilityHidden = () => {
      if (document.visibilityState === 'hidden') void this.flushEvents();
    };
    window.addEventListener('pagehide', flushOnHide);
    document.addEventListener('visibilitychange', flushOnVisibilityHidden);
    this.batchingTeardown.push(
      () => window.removeEventListener('pagehide', flushOnHide),
      () => document.removeEventListener('visibilitychange', flushOnVisibilityHidden),
    );
  }

  /**
   * Stop background clickstream flushing and release page-unload listeners.
   * Flushes any buffered events one last time. Call when tearing down an SDK
   * instance (e.g. SPA unmount) to avoid a dangling interval/listeners.
   */
  dispose(): void {
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    for (const teardown of this.batchingTeardown.splice(0)) {
      try {
        teardown();
      } catch {
        // Listener removal is best-effort.
      }
    }
    void this.flushEvents();
  }

  async emitSemantic(eventType: string, payload: SdkEventProperties, options?: RevTurbineEventOptions): Promise<void> {
    const semanticPayload = isRecord(payload) ? payload : {};
    await this.capture(eventType, {
      semantic: true,
      payload: semanticPayload,
    }, options);
  }


  /**
   * Optimized routine to evaluate segment membership and usage thresholds.
   * Should be called on every user context or usage update.
   *
   * @param update - Partial user context or usage update payload
   * @param isUsageUpdate - If true, also check usage thresholds
   */
  private async evaluateUserSegmentsAndUsage(update: Partial<RevTurbineUserContext>, isUsageUpdate = false): Promise<void> {
    const prevContext = await this.fetchUserContext(this.userContext.id || '');
    // Merge update into current context
    const nextContext: RevTurbineUserContext = {
      ...this.userContext,
      ...update,
      custom: {
        ...(this.userContext.custom || {}),
        ...(update.custom || {}),
      },
    };
    // Fetch new segment membership from backend (or local resolver)
    const newContext = await this.fetchUserContext(nextContext.id || '');
    // Compare segments
    const prevSegments = new Set(prevContext.segmentIds || []);
    const newSegments = new Set(newContext.segmentIds || []);
    // Find enrollments and unenrollments
    const enrolled = Array.from(newSegments).filter(s => !prevSegments.has(s));
    const unenrolled = Array.from(prevSegments).filter(s => !newSegments.has(s));
    // Fire events for changes
    for (const seg of enrolled) {
      await this.emitSemantic('segment_enrolled', { segment_id: seg, user_id: nextContext.id ?? null });
    }
    for (const seg of unenrolled) {
      await this.emitSemantic('segment_unenrolled', { segment_id: seg, user_id: nextContext.id ?? null });
    }
    // If usage update, check for threshold triggers
    if (isUsageUpdate) {
      const prevUsage = prevContext.usage || {};
      const newUsage = { ...prevUsage, ...this.usageBalances };
      const emissions = this.evaluateUsageThresholdCrossings(prevUsage, newUsage);
      await Promise.all(emissions);
    }
  }

  /**
   * Emit the NAMES of the custom user-context fields set in this identify /
   * setUserContext call — names only, never values (plan 114 TASK-4). `custom`
   * is `Pii`-classified, so only its keys are recorded (PII-safe, AC-9), under
   * the reserved {@link USER_CONTEXT_FIELDS_EVENT} clickstream event, giving the
   * control plane a per-`(tenant_id, field_name)` last-seen signal. Best-effort:
   * routes through the normal clickstream path and never throws into the app.
   */
  private emitObservedContextFields(custom: SdkTraits | undefined): void {
    const fieldNames = Object.keys(custom ?? {})
      .filter((name) => name.length > 0)
      .sort();
    if (fieldNames.length === 0) return;
    // context_fields is an array of field NAMES only — no values are included.
    void this.capture(USER_CONTEXT_FIELDS_EVENT, { context_fields: fieldNames });
  }

  setUserContext(userContext: RevTurbineUserContext): void {
    const previousContext = this.userContext;
    this.userContext = this.mergeUserContext(userContext);
    this.recalculateDerivedUsageTraits();
    this.markSegmentsDirtyFromContextChange(previousContext, this.userContext);
    this.persistLocalRuntimeState();
    void this.evaluateUserSegmentsAndUsage(userContext, false);
    this.emitObservedContextFields(userContext.custom);
  }

  setPageContext(pageContext: RevTurbinePageContext): void {
    this.pageContext = this.mergePageContext(pageContext);
    this.persistLocalRuntimeState();
  }

  refreshPageContext(): void {
    this.pageContext = this.mergePageContext(inferPageContext());
  }

  /**
   * Hydrate the SDK with a server-evaluated payload.
   *
   * Call this on the client after receiving a `ServerEvaluationPayload`
   * from the server-side SDK. Pre-populates the decision cache,
   * entitlements, trial status, and user context so the client SDK
   * avoids redundant API calls.
   *
   * @example
   * ```ts
   * // In your React component / page hydration:
   * const sdk = initRevTurbine({ tenantId, apiKey, endpoint, mode: 'react' });
   * sdk.hydrate(serverPayload);
   * ```
   */
  hydrate(payload: ServerEvaluationHydrationPayload): void {
    if (payload.version !== '1.0.0') {
      console.warn(`[RevTurbine] Unknown hydration payload version: ${payload.version}. Skipping.`);
      return;
    }

    const previousContext = this.userContext;

    // Merge user context
    if (payload.user) {
      this.userContext = this.mergeUserContext({
        id: payload.user.id,
        custom: payload.user.traits as SdkTraits | undefined,
        usage: {},
      });
      this.recalculateDerivedUsageTraits();
    }

    // Pre-populate decision cache
    const ttlMs = (payload.ttl_seconds ?? 60) * 1000;
    const expiresAt = Date.now() + ttlMs;
    for (const decision of payload.decisions ?? []) {
      if (!decision.output) continue;
      const cacheKey = [
        this.tenantId,
        decision.slot_id ?? decision.entitlement_handle ?? decision.placement_handle ?? 'unknown',
        payload.user?.id ?? this.anonymousId,
      ].join(':');

      const outputContent = isRecord(decision.output?.content) ? decision.output.content : {};
      this.decisionCache.set(cacheKey, {
        value: {
          placementId: decision.slot_id ?? decision.entitlement_handle ?? decision.placement_handle ?? 'unknown',
          requestId: payload.request_id,
          visible: decision.visible,
          decisionSource: 'cache',
          reasonCodes: decision.reason_codes ?? [],
          content: decisionContent(
            String(outputContent.header ?? ''),
            String(outputContent.body ?? ''),
            String(outputContent.cta_label ?? ''),
          ),
          // Wire-format output is Record<string, unknown>; narrow to PlacementOutput
          // at this deserialization boundary (runtime shape is guaranteed by server SDK).
          output: decision.output as unknown as PlacementOutput, // sdk-ok: boundary-parse
        },
        expiresAt,
      });
    }
    this.persistDecisionCache();

    // Pre-populate entitlements
    if (payload.entitlements) {
      for (const [handle, result] of Object.entries(payload.entitlements)) {
        this.localEntitlementsByHandle.set(handle, {
          status: result.status,
          allowed: result.allowed,
          reason: result.reason,
          current_tier: result.current_tier,
          placement: result.placement,
        });
      }
    }

    // Pre-populate trial status
    if (payload.trial_status) {
      this.localTrialStatus = {
        in_trial: payload.trial_status.in_trial,
        trial_type: payload.trial_status.trial_type,
        plan_handle: payload.trial_status.plan_handle,
        day_number: payload.trial_status.day_number,
        days_remaining: payload.trial_status.days_remaining,
      };
    }

    // Pre-populate usage balances from user context
    if (payload.user_context?.usage_balances) {
      this.usageBalances = { ...this.usageBalances, ...payload.user_context.usage_balances };
      this.recalculateDerivedUsageTraits();
    }

    this.markSegmentsDirtyFromContextChange(previousContext, this.userContext);
  }

  async generatePlacementId(input: {
    placementName: string;
    placementScopeKey?: string;
    normalizedPageRoute?: string;
  }): Promise<string> {
    return coreGeneratePlacementId(
      {
        tenantId: this.tenantId,
        placementName: input.placementName,
        placementScopeKey: input.placementScopeKey,
        pageRoute: input.normalizedPageRoute || this.currentPathname(),
      },
      { sha256Base64Url, randomHex: secureRandomHex },
    );
  }

  /**
   * @deprecated Use `registerSurfaceSlot`.
   */
  async registerPlacement(config: RevTurbinePlacementConfig): Promise<string> {
    const fallbackId = String(config.placementScopeKey || config.name || '').trim();

    return this.registerSurfaceSlot({
      id: fallbackId || String(config.name || 'surface_slot').trim(),
      name: config.name,
      metadata: isRecord(config.metadata) ? config.metadata : undefined,
    });
  }

  private async upsertSurfaceSlot(record: RevTurbinePlacementRecord): Promise<void> {
    if (this.isLocalOnlyMode()) {
      return;
    }

    const requestIdValue = requestId();
    const baseUrl = this.endpointFor('surfaceSlots', '/api/placements').replace(/\/+$/, '');
    const slug = sanitizeSlug(record.placementScopeKey || record.id || record.name);
    const metadata = {
      ...(isRecord(record.metadata) ? record.metadata : {}),
      surface_slot_id: record.placementScopeKey || record.id,
      registration_source: 'sdk_surface_slot',
      route: record.route,
    };

    const payload = {
      name: record.name,
      slug,
      description: `Surface slot ${record.placementScopeKey || record.id}`,
      slot_type: 'custom' as const,
      status: 'active' as const,
      targeting_rules: {},
      content: {},
      priority: 0,
      metadata,
    };

    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      'x-tenant-id': this.tenantId,
      'x-request-id': requestIdValue,
    };

    const putResponse = await fetch(`${baseUrl}/${encodeURIComponent(record.id)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload),
    });

    if (putResponse.ok) {
      this.syncedSurfaceSlotIds.add(record.id);
      return;
    }

    if (putResponse.status !== 404) {
      throw new Error(`surface_slot_upsert_failed:${putResponse.status}`);
    }

    const postResponse = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!postResponse.ok) {
      throw new Error(`surface_slot_create_failed:${postResponse.status}`);
    }

    this.syncedSurfaceSlotIds.add(record.id);
  }

  async registerSurfaceSlot(config: RevTurbineSurfaceSlotConfig): Promise<string> {
    const route = normalizedRoute(this.currentPathname());
    const slotId = String(config?.id || '').trim();
    const slotName = String(config?.name || slotId).trim();
    const placementIssues: ValidationIssue[] = [];

    if (!slotId) {
      placementIssues.push({
        code: 'invalid_surface_slot_id',
        reason: 'SurfaceSlot id is required and must be a non-empty string.',
      });
    }

    if (!slotName) {
      placementIssues.push({
        code: 'invalid_placement_name',
        reason: 'SurfaceSlot name is missing or empty.',
      });
    }

    if (config?.metadata !== undefined && !isRecord(config.metadata)) {
      placementIssues.push({
        code: 'invalid_placement_metadata',
        reason: 'Placement metadata must be a plain object when provided.',
      });
    }

    const id = await this.generatePlacementId({
      placementName: slotName || slotId || 'invalid_surface_slot',
      placementScopeKey: slotId || undefined,
      normalizedPageRoute: route,
    });

    const record: RevTurbinePlacementRecord = {
      id,
      route,
      name: slotName || 'invalid_surface_slot',
      placementScopeKey: slotId || undefined,
      metadata: {
        ...(isRecord(config.metadata) ? config.metadata : {}),
        surface_slot_id: slotId || null,
        ...(Array.isArray(config.surfaceTemplateIds) && config.surfaceTemplateIds.length > 0
          ? { surface_template_ids: config.surfaceTemplateIds }
          : {}),
      },
    };

    const existing = this.placements.get(id);
    const existingFingerprint = existing ? this.stableStringify(existing) : null;
    const nextFingerprint = this.stableStringify(record);

    if (!existing || existingFingerprint !== nextFingerprint) {
      this.placements.set(id, record);
      this.persistLocalRuntimeState();
      this.syncedSurfaceSlotIds.delete(id);
    }

    if (!this.isLocalOnlyMode() && !this.syncedSurfaceSlotIds.has(id)) {
      await this.upsertSurfaceSlot(record);
    }

    if (placementIssues.length > 0) {
      await this.sendEvents([
        this.buildValidationWarningEvent('placement_registered', placementIssues, {
          surface_slot_id: slotId || null,
          placement_id: id,
          route,
          placement_name: slotName || null,
        }),
      ]);
    }

    return id;
  }

  async persistPlacementTypes(types: RevTurbinePlacementTypeEntity[]): Promise<void> {
    if (this.isLocalOnlyMode()) return;

    const normalizedTypes = (Array.isArray(types) ? types : [])
      .map((entry) => normalizePlacementTypeEntity(entry))
      .filter((entry): entry is RevTurbinePlacementTypeEntity => entry !== null);

    if (normalizedTypes.length === 0) return;

    const rid = requestId();
    const response = await fetch(this.endpointFor('placementTypes', '/api/sdk/placement-types'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        'x-tenant-id': this.tenantId,
        'x-request-id': rid,
      },
      body: JSON.stringify({
        request_id: rid,
        tenant_id: this.tenantId,
        types: normalizedTypes,
      }),
    });

    if (!response.ok) {
      throw new Error(`persist_placement_types_failed:${response.status}`);
    }
  }

  private stableStringify(value: unknown): string { // sdk-ok: boundary-parse
    return stableStringify(value);
  }

  private decisionCacheKey(
    input: RevTurbinePlacementDecisionInput,
    runtimeContextFingerprint?: string,
  ): string {
    return coreDecisionCacheKey({
      tenantId: this.tenantId,
      placementId: input.placementId,
      userId: input.userId,
      contextMode: input.contextMode ?? 'auto',
      overrides: (input.overrides ?? {}) as Record<string, unknown>, // sdk-ok: boundary-parse
      traits: (input.traits ?? {}) as Record<string, unknown>, // sdk-ok: boundary-parse
      route: this.currentPathname(),
      ...(runtimeContextFingerprint ? { runtimeContextFingerprint } : {}),
    });
  }

  private interactionStateKey(input: { placementId: string; userId: string; treatmentId?: string }): string {
    return coreInteractionStateKey({ tenantId: this.tenantId, ...input });
  }

  private readDecisionCache(key: string): RevTurbinePlacementDecision | null {
    const cached = this.decisionCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.decisionCache.delete(key);
      this.persistDecisionCache();
      return null;
    }
    return {
      ...cached.value,
      decisionSource: 'cache',
    };
  }

  private writeDecisionCache(key: string, value: RevTurbinePlacementDecision, ttlMs?: number): void {
    const expiresAt = Date.now() + Math.max(5_000, ttlMs ?? this.defaultDecisionTtlMs);
    this.decisionCache.set(key, { expiresAt, value });
    this.persistDecisionCache();
  }

  private suppressionForState(state?: InteractionState): { suppressed: boolean; reason?: string } {
    return coreSuppression(state);
  }

  private placementCapKey(output: PlacementOutput): string {
    return [
      this.tenantId,
      this.userContext.id || this.anonymousId,
      output.surface.type,
      output.output_id,
    ].join(':');
  }

  private extractPlacementCapPolicies(output: PlacementOutput): PlacementCapPolicy[] {
    return coreExtractPlacementCapPolicies(output);
  }

  private applyPlacementCapsIfNeeded(
    output: PlacementOutput,
    options: { tick?: boolean } = {},
  ): { allowed: boolean; reason?: string } {
    if (!this.placementBehavior.enableClientCapsEnforcement) {
      return { allowed: true };
    }
    const tick = options.tick ?? true;

    const key = this.placementCapKey(output);
    const existing = this.presentationCapsByKey.get(key);
    const result = checkPlacementCaps(output, key, existing, Date.now());

    if (result.updatedState && tick) {
      this.presentationCapsByKey.set(key, result.updatedState);
      if (result.allowed) {
        this.persistPresentationCaps();
      }
    }

    return { allowed: result.allowed, reason: result.reason };
  }

  /**
   * Plan 43 TASK-14 — gate a getPlacementDecision result on `cap.v1` policies.
   *
   * On the first decision pass (`tick: true`), the cap state is ticked when
   * the cap allows firing — so a placement with
   * `max_per_period: { count: 1, period: 'lifetime' }` is consumed once.
   * On a cache-hit re-evaluation (`tick: false`), the cap state is only
   * read, so subsequent identical inputs observe the consumed budget and
   * the decision flips to `visible: false` with a `cap_exceeded` reason.
   * Without this re-evaluation, the decision cache would return the
   * stale `visible: true` from before the tick. When
   * `enableClientCapsEnforcement` is false, this helper is a no-op.
   */
  private gateDecisionByCaps(
    decision: RevTurbinePlacementDecision,
    options: { tick?: boolean } = {},
  ): RevTurbinePlacementDecision {
    if (!this.placementBehavior.enableClientCapsEnforcement) return decision;
    if (!decision.visible) return decision;
    if (!decision.output) return decision;

    const cap = this.applyPlacementCapsIfNeeded(decision.output, { tick: options.tick ?? true });
    if (cap.allowed) return decision;

    const reason = cap.reason ?? 'cap_exceeded';
    return {
      ...decision,
      visible: false,
      reasonCodes: [...(decision.reasonCodes ?? []), reason],
      suppressionReason: reason,
    };
  }

  private normalizeDecisionFromResponse(
    placementId: string,
    rid: string,
    placementName: string,
    payload: unknown, // sdk-ok: boundary-parse
  ): RevTurbinePlacementDecision {
    return coreNormalizeDecisionFromResponse(placementId, rid, placementName, payload);
  }

  async getPlacementDecision(input: RevTurbinePlacementDecisionInput): Promise<RevTurbinePlacementDecision> {
    const placement = this.placements.get(input.placementId);
    const rid = requestId();

    if (this.isDisabledByProviderFailure()) {
      return this.disabledDecisionForPlacement(input.placementId, placement?.name);
    }

    if (!placement) {
      return {
        placementId: input.placementId,
        requestId: rid,
        visible: false,
        decisionSource: 'fallback',
        reasonCodes: ['placement_not_registered'],
        suppressionReason: 'placement_not_registered',
        content: decisionContent(
          'Placement not found',
          'Register the placement before requesting a decision.',
          'Register placement',
        ),
      };
    }

    const interactionKey = this.interactionStateKey({
      placementId: input.placementId,
      userId: input.userId,
    });
    const suppression = this.suppressionForState(this.interactionState.get(interactionKey));

    if (suppression.suppressed) {
      return {
        placementId: input.placementId,
        requestId: rid,
        visible: false,
        decisionSource: 'cache',
        reasonCodes: suppression.reason ? [suppression.reason] : [],
        suppressionReason: suppression.reason,
        content: decisionContent(
          `${placement.name} suppressed`,
          'Suppressed due to recent interaction state.',
          'Continue',
        ),
      };
    }

    let legacyCtx: JsonObject | undefined;
    let providerCtx: Awaited<ReturnType<DomainProviderRegistry['resolveAll']>> | undefined;
    let runtimeContextFingerprint: string | undefined;

    if (this.isLocalOnlyMode()) {
      legacyCtx = await this.localRuntime?.getContext?.();
      providerCtx = this.providerRegistry.size > 0
        ? await this.providerRegistry.resolveAll()
        : this.synthesizeProviderContext();
      if (legacyCtx || providerCtx) {
        runtimeContextFingerprint = this.stableStringify({
          legacyCtx: legacyCtx ?? {},
          providerCtx: providerCtx ?? {},
        });
      }
    }

    const key = this.decisionCacheKey(input, runtimeContextFingerprint);
    const cached = this.readDecisionCache(key);
    if (cached) {
      // Plan 43 TASK-14: re-evaluate caps on cache hits with `tick: false`
      // (the resolver pass already ticked). Without this, a placement with
      // `max_per_period: 1 lifetime` would stay visible on every subsequent
      // call because the cache short-circuits the resolver path.
      return this.gateDecisionByCaps(cached, { tick: false });
    }

    if (this.isLocalOnlyMode()) {
      const resolver = this.localRuntime?.resolvers?.getPlacementDecision
        ?? this.defaultLocalPlacementDecisionResolver;
      if (resolver) {
        const ctx = {
          ...legacyCtx,
          ...(providerCtx ? { __providers: providerCtx } : {}),
        } as JsonObject;
        const decision = this.gateDecisionByCaps(await resolver(input, placement, ctx));
        this.localDecisionsByPlacementId.set(input.placementId, decision);
        this.writeDecisionCache(key, decision, input.ttlMs);
        this.persistLocalRuntimeState();
        return decision;
      }

      const localDecision = this.localDecisionsByPlacementId.get(input.placementId);
      if (localDecision) {
        const decision = this.gateDecisionByCaps({ ...localDecision, decisionSource: 'fallback' as const });
        this.writeDecisionCache(key, decision, input.ttlMs);
        this.persistLocalRuntimeState();
        return decision;
      }
    }

    try {
      const response = await fetch(this.endpointFor('decideContext', '/api/sdk/decide-context'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'x-tenant-id': this.tenantId,
          'x-request-id': rid,
        },
        body: JSON.stringify({
          request_id: rid,
          tenant_id: this.tenantId,
          placement_id: input.placementId,
          user_id: input.userId,
          context_mode: input.contextMode ?? 'auto',
          overrides: input.overrides
            ? {
              segment_id: input.overrides.segmentId,
              plan_id: input.overrides.planId,
              usage: input.overrides.usage?.map((item) => ({
                entitlement_id: item.entitlementId,
                meter_id: item.meterId,
                used: item.used,
              })),
            }
            : undefined,
          traits: input.traits,
          context: {
            user: this.userContext,
            page: this.pageContext,
            placement,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`decide-context failed: ${response.status}`);
      }

      const payload = await response.json();
      const decision = this.gateDecisionByCaps(
        this.normalizeDecisionFromResponse(input.placementId, rid, placement.name, payload),
      );
      this.writeDecisionCache(key, decision, input.ttlMs);
      this.localDecisionsByPlacementId.set(input.placementId, decision);
      this.persistLocalRuntimeState();
      return decision;
    } catch {
      const fallbackContent = await this.getPlacementContent(input.placementId, {
        user_id: input.userId,
        context_mode: input.contextMode ?? 'auto',
        overrides: input.overrides as unknown as JsonValue, // sdk-ok: boundary-parse
        traits: input.traits as unknown as JsonValue, // sdk-ok: boundary-parse
      });
      const fallbackDecision: RevTurbinePlacementDecision = {
        placementId: input.placementId,
        requestId: fallbackContent.requestId,
        visible: true,
        decisionSource: 'fallback',
        reasonCodes: ['fallback_content'],
        content: fallbackContent.content,
      };
      this.writeDecisionCache(key, fallbackDecision, input.ttlMs);
      this.localDecisionsByPlacementId.set(input.placementId, fallbackDecision);
      this.persistLocalRuntimeState();
      return fallbackDecision;
    }
  }

  async preloadPlacementDecisions(inputs: RevTurbinePlacementDecisionInput[]): Promise<void> {
    const uniqueByKey = new Map<string, RevTurbinePlacementDecisionInput>();
    for (const input of inputs) {
      uniqueByKey.set(this.decisionCacheKey(input), input);
    }
    await Promise.allSettled(Array.from(uniqueByKey.values()).map((input) => this.getPlacementDecision(input)));
  }

  async bootstrapPlacementDecisions(inputs: RevTurbinePlacementDecisionInput[]): Promise<void> {
    if (this.isDisabledByProviderFailure()) {
      await Promise.all(inputs.map(async (input) => {
        const decision = await this.getPlacementDecision(input);
        const cacheKey = this.decisionCacheKey(input);
        this.writeDecisionCache(cacheKey, decision, input.ttlMs);
      }));
      return;
    }

    const grouped = new Map<string, RevTurbineBootstrapDecisionInput>();
    for (const input of inputs) {
      const placement = this.placements.get(input.placementId);
      if (!placement || !input.userId) continue;
      const key = this.stableStringify({
        userId: input.userId,
        contextMode: input.contextMode ?? 'auto',
        overrides: input.overrides ?? {},
        traits: input.traits ?? {},
        ttlMs: input.ttlMs ?? null,
      });
      const existing = grouped.get(key);
      if (existing) {
        existing.placementIds.push(input.placementId);
        continue;
      }
      grouped.set(key, {
        userId: input.userId,
        contextMode: input.contextMode,
        overrides: input.overrides,
        traits: input.traits,
        ttlMs: input.ttlMs,
        placementIds: [input.placementId],
      });
    }

    for (const group of grouped.values()) {
      if (group.placementIds.length <= 1) {
        const single = inputs.find((item) => item.placementId === group.placementIds[0] && item.userId === group.userId);
        if (single) {
          await this.getPlacementDecision(single);
        }
        continue;
      }

      const rid = requestId();
      try {
        const response = await fetch(this.endpointFor('bootstrapContext', '/api/sdk/bootstrap-context'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
            'x-tenant-id': this.tenantId,
            'x-request-id': rid,
          },
          body: JSON.stringify({
            request_id: rid,
            tenant_id: this.tenantId,
            user_id: group.userId,
            context_mode: group.contextMode ?? 'auto',
            overrides: group.overrides
              ? {
                segment_id: group.overrides.segmentId,
                plan_id: group.overrides.planId,
                usage: group.overrides.usage?.map((item) => ({
                  entitlement_id: item.entitlementId,
                  meter_id: item.meterId,
                  used: item.used,
                })),
              }
              : undefined,
            traits: group.traits,
            placements: group.placementIds.map((placementId) => ({ placement_id: placementId })),
          }),
        });

        if (!response.ok) {
          throw new Error(`bootstrap-context failed: ${response.status}`);
        }

        const payload = await response.json();
        const items = isRecord(payload) && Array.isArray(payload.decisions) ? payload.decisions : [];
        for (const item of items) {
          if (!isRecord(item)) continue;
          const placementId = typeof item.placement_id === 'string' ? item.placement_id : '';
          const result = isRecord(item.result) ? item.result : null;
          const placement = this.placements.get(placementId);
          if (!placement || !result) continue;
          const decision = this.normalizeDecisionFromResponse(placementId, rid, placement.name, result);
          const cacheKey = this.decisionCacheKey({
            placementId,
            userId: group.userId,
            contextMode: group.contextMode,
            overrides: group.overrides,
            traits: group.traits,
          });
          this.writeDecisionCache(cacheKey, decision, group.ttlMs);
          this.localDecisionsByPlacementId.set(placementId, decision);
        }
        this.persistLocalRuntimeState();
      } catch {
        const fallbackInputs = inputs.filter((item) => group.placementIds.includes(item.placementId) && item.userId === group.userId);
        await Promise.allSettled(fallbackInputs.map((item) => this.getPlacementDecision(item)));
      }
    }
  }

  private updateInteractionState(input: RevTurbineTreatmentInteractionInput): void {
    const key = this.interactionStateKey({
      placementId: input.placementId,
      userId: input.userId,
      treatmentId: input.treatmentId,
    });
    const now = Date.now();
    const metadata = input.metadata ?? {};
    const existing = this.interactionState.get(key) ?? { updatedAt: new Date(now).toISOString() };
    const next: InteractionState = {
      ...existing,
      lastInteractionType: input.interactionType,
      updatedAt: input.interactionAt ?? new Date(now).toISOString(),
    };

    if (input.interactionType === 'dismiss') {
      const cooldownMs = Number(metadata.cooldown_ms);
      next.suppressedUntil = now + (Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : this.defaultDismissCooldownMs);
    }

    if (input.interactionType === 'remind_me_later') {
      const remindAfterSeconds = Number(metadata.remind_after_seconds);
      next.suppressedUntil = now + (Number.isFinite(remindAfterSeconds) && remindAfterSeconds > 0
        ? remindAfterSeconds * 1000
        : this.defaultRemindLaterMs);
    }

    if (input.interactionType === 'cta_clicked' || input.interactionType === 'cta_completed') {
      next.suppressedUntil = now + 5 * 60 * 1000;
    }

    if (input.interactionType === 'suppress') {
      // Time-based suppression — honour metadata.suppress_duration_ms or default to dismiss cooldown.
      const suppressMs = Number(metadata.suppress_duration_ms);
      next.suppressedUntil = now + (Number.isFinite(suppressMs) && suppressMs > 0
        ? suppressMs
        : this.defaultDismissCooldownMs);
    }

    this.interactionState.set(key, next);
    this.persistInteractionState();
  }

  private async flushInteractionQueue(): Promise<void> {
    if (this.interactionQueue.length === 0) return;
    const pending = [...this.interactionQueue];
    this.interactionQueue.length = 0;

    if (this.isLocalOnlyMode()) {
      this.persistLocalRuntimeState();
      return;
    }

    const transitionPayload = pending.map((item) => ({
      user_id: item.userId,
      placement_id: item.placementId,
      treatment_id: item.treatmentId,
      interaction_type: item.interactionType,
      interaction_at: item.interactionAt,
      // Presentation context → placement_presentations (plan 114 TASK-2).
      surface_slot_id: item.surfaceSlotId,
      surface_template_id: item.surfaceTemplateId,
      payload_id: item.payloadId,
      metadata: item.metadata ?? {},
      tenant_id: this.tenantId,
    }));

    try {
      const response = await fetch(this.endpointFor('touchpointTransition', TOUCHPOINT_TRANSITION_PATH), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'x-tenant-id': this.tenantId,
          'x-request-id': requestId(),
        },
        body: JSON.stringify(transitionPayload.length === 1 ? transitionPayload[0] : transitionPayload),
      });

      if (!response.ok) {
        const fallbackResponse = await fetch(this.endpointFor('legacyInteractions', LEGACY_INTERACTIONS_PATH), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
            'x-tenant-id': this.tenantId,
            'x-request-id': requestId(),
          },
          body: JSON.stringify(pending.length === 1 ? pending[0] : pending),
        });

        if (!fallbackResponse.ok) {
          this.interactionQueue.unshift(...pending);
        }
      }
    } catch {
      this.interactionQueue.unshift(...pending);
    }
  }

  async trackTreatmentInteraction(input: RevTurbineTreatmentInteractionInput): Promise<void> {
    const normalized: RevTurbineTreatmentInteractionInput = {
      ...input,
      interactionAt: input.interactionAt ?? new Date().toISOString(),
    };

    this.updateInteractionState(normalized);
    this.interactionQueue.push(normalized);
    void this.flushInteractionQueue();

    // Record interactions into the impression history.
    // Dismissed and clicked placements are permanently retired.
    // Suppressed placements are hidden for a configurable duration.
    const placementId = normalized.placementId;
    const treatmentId = normalized.treatmentId;
    const meta = normalized.metadata ?? {};

    if (normalized.interactionType === 'dismiss') {
      void this.impressionHistory.recordDismissal(placementId, treatmentId);
    } else if (
      normalized.interactionType === 'cta_clicked' ||
      normalized.interactionType === 'cta_completed'
    ) {
      void this.impressionHistory.recordClickThru(placementId, treatmentId);
    } else if (normalized.interactionType === 'suppress') {
      const durationMs = Number(meta.suppress_duration_ms);
      void this.impressionHistory.recordSuppression(
        placementId,
        treatmentId,
        undefined,
        meta,
        Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined,
      );
    }

    await this.emitSemantic('placement_interaction', {
      user_id: normalized.userId,
      placement_id: normalized.placementId,
      treatment_id: normalized.treatmentId ?? null,
      interaction_type: normalized.interactionType,
      interaction_at: normalized.interactionAt ?? null,
      metadata: (normalized.metadata ?? {}) as Record<string, JsonValue>,
    }, { immediate: false });
  }

  async getPlacementContent(placementId: string, request?: JsonObject): Promise<RevTurbinePlacementContent> {
    const placement = this.placements.get(placementId);
    const rid = requestId();

    if (this.isDisabledByProviderFailure()) {
      const disabledDecision = this.disabledDecisionForPlacement(placementId, placement?.name);
      return {
        placementId,
        requestId: rid,
        decisionSource: 'fallback',
        content: disabledDecision.content,
      };
    }

    if (this.isLocalOnlyMode()) {
      const byPlacement = this.localPlacementsByLookupKey.get(
        this.localPlacementLookupKey({ placementHandle: placementId }),
      );
      return {
        placementId,
        requestId: rid,
        decisionSource: byPlacement ? 'remote' : 'fallback',
        content: decisionContent(
          typeof byPlacement?.content?.title === 'string'
            ? String(byPlacement.content.title)
            : `${placement?.name ?? placementId} treatment`,
          typeof byPlacement?.content?.body === 'string'
            ? String(byPlacement.content.body)
            : 'Local runtime placement content.',
          typeof byPlacement?.content?.cta === 'string'
            ? String(byPlacement.content.cta)
            : 'Continue',
        ),
      };
    }

    if (!placement) {
      return {
        placementId,
        requestId: rid,
        decisionSource: 'fallback',
        content: decisionContent(
          'Placement not found',
          'Register the placement before requesting content.',
          'Register placement',
        ),
      };
    }

    const payload = {
      request_id: rid,
      tenant_id: this.tenantId,
      placement_id: placementId,
      context: {
        user: this.userContext,
        page: this.pageContext,
        placement,
      },
      request: request || {},
    };

    try {
      const response = await fetch(this.endpointFor('decide', '/api/sdk/decide'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'x-tenant-id': this.tenantId,
          'x-request-id': rid,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`decision request failed: ${response.status}`);
      }

      const data = (await response.json()) as {
        recommendation?: {
          message?: string;
          action?: string;
          title?: string;
        };
      };

      return {
        placementId,
        requestId: rid,
        decisionSource: 'remote',
        content: decisionContent(
          data.recommendation?.title || `${placement.name} recommendation`,
          data.recommendation?.message || 'Treatment selected by RevTurbine decisioning.',
          data.recommendation?.action || 'View details',
        ),
      };
    } catch {
      return {
        placementId,
        requestId: rid,
        decisionSource: 'fallback',
        content: decisionContent(
          `${placement.name} treatment`,
          'Fallback treatment active while decision endpoint is unavailable.',
          'Continue',
        ),
      };
    }
  }

  private normalizePlacementOutput(data: unknown): PlacementOutput | null { // sdk-ok: boundary-parse
    const result = coreNormalizePlacementOutput(data, requestId);
    if (result && isRecord(data) && typeof data.decision_id !== 'string') {
      void this.capture(SDK_WARNING_EVENT_TYPE, {
        reason: 'placement response missing decision_id; generated synthetic',
        output_id: result.output_id,
        synthetic_decision_id: result.decision_id,
      });
    }
    return result;
  }

  private normalizeEntitlementResult(data: unknown): EntitlementResult { // sdk-ok: boundary-parse
    return coreNormalizeEntitlementResult(data, requestId);
  }

  private validateTrialStatusShape(data: unknown): RevTurbineTrialContext { // sdk-ok: boundary-parse
    return validateTrialStatusShape(data) as RevTurbineTrialContext;
  }

  async getPlacement(config: RevTurbinePlacementRequestConfig): Promise<PlacementOutput | null>;
  async getPlacement(
    config: RevTurbinePlacementRequestConfig,
  ): Promise<PlacementOutput | null> {

    if (this.isDisabledByProviderFailure()) {
      return this.disabledPlacementOutputForConfig(config);
    }

    const slotId = config.slotId;
    const surfaceType = config.surfaceType;

    // Runtime check is required: the SDK is exposed as window.RevTurbine for plain JS callers
    // who bypass TypeScript's compile-time guarantees. The spec requires the SDK reject unknown values.
    if (surfaceType && !VALID_SURFACE_TYPES.has(surfaceType)) {
      void this.capture(SDK_WARNING_EVENT_TYPE, {
        reason: `getPlacement called with unknown surfaceType: ${String(surfaceType)}`,
        slot_id: slotId ?? null,
      });
      return null;
    }

    const rid = requestId();

    if (this.isLocalOnlyMode()) {
      const resolver = this.localRuntime?.resolvers?.getPlacement;
      if (resolver) {
        const resolved = await resolver(config);
        if (!resolved) return null;
        const capDecision = this.applyPlacementCapsIfNeeded(resolved);
        return capDecision.allowed ? resolved : null;
      }
      const local = this.localPlacementForConfig(config);
      if (!local) return null;
      const capDecision = this.applyPlacementCapsIfNeeded(local);
      return capDecision.allowed ? local : null;
    }

    try {
      const response = await fetch(this.endpointFor('getPlacement', '/api/sdk/get-placement'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'x-tenant-id': this.tenantId,
          'x-request-id': rid,
        },
        body: JSON.stringify({
          request_id: rid,
          tenant_id: this.tenantId,
          slot_id: slotId,
          surface_type: surfaceType,
          entitlement_handle: config.entitlementHandle,
          plan_handle: config.planHandle,
          placement_handle: config.placementHandle,
          user_id: this.userContext.id,
          usage: this.usageBalances,
          context: {
            user: this.userContext,
            page: this.pageContext,
          },
        }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      const normalized = this.normalizePlacementOutput(data);
      if (!normalized) return null;
      const capDecision = this.applyPlacementCapsIfNeeded(normalized);
      if (!capDecision.allowed) return null;
      this.localPlacementsByLookupKey.set(this.localPlacementLookupKey(config), normalized);
      this.persistLocalRuntimeState();
      return normalized;
    } catch {
      return null;
    }
  }

  async checkEntitlement(handle: string, context?: RevTurbineEntitlementContext): Promise<EntitlementResult> {
    if (this.isDisabledByProviderFailure()) {
      return { status: 'allowed', allowed: true, reason: this.sdkDisabledReason ?? 'sdk_disabled_provider_failure' };
    }

    const effectiveUsage = context?.used !== undefined
      ? { used: context.used }
      : context?.balance !== undefined
        ? { balance: context.balance }
        : (this.usageBalances[handle] !== undefined ? { used: this.usageBalances[handle] } : undefined);
    const rid = requestId();

    if (this.isLocalOnlyMode()) {
      const resolver = this.localRuntime?.resolvers?.checkEntitlement;
      if (resolver) {
        const result = await resolver(handle, context);
        this.localEntitlementsByHandle.set(handle, result);
        this.persistLocalRuntimeState();
        return result;
      }

      const derived = this.deriveLocalEntitlementFromConfiguredRules(handle, context);
      if (derived) {
        this.localEntitlementsByHandle.set(handle, derived);
        this.persistLocalRuntimeState();
        return derived;
      }

      const existing = this.localEntitlementsByHandle.get(handle);
      if (existing) return existing;
      return { status: 'allowed', allowed: true, reason: 'local_runtime_default_allow' };
    }

    try {
      const response = await fetch(this.endpointFor('checkEntitlement', '/api/sdk/check-entitlement'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'x-tenant-id': this.tenantId,
          'x-request-id': rid,
        },
        body: JSON.stringify({
          request_id: rid,
          tenant_id: this.tenantId,
          handle,
          user_id: this.userContext.id,
          usage: effectiveUsage,
          required_tier: context?.requiredTier,
          context: {
            user: this.userContext,
          },
        }),
      });
      // Fail-open: when RT is unavailable the spec requires baseline UX to continue unaffected.
      // Non-ok responses include an explicit reason so callers can distinguish "RT said no" vs "RT unreachable".
      if (!response.ok) return { status: 'allowed', allowed: true, reason: 'entitlement_service_unavailable' };
      const data = await response.json();
      const normalized = this.normalizeEntitlementResult(data);
      this.localEntitlementsByHandle.set(handle, normalized);
      this.persistLocalRuntimeState();
      return normalized;
    } catch {
      // Network/parse failures also fail open so a RT outage never blocks user actions.
      return { status: 'allowed', allowed: true, reason: 'entitlement_check_error' };
    }
  }

  updateUsage(balances: UsageBalances): void {
    const previousContext = this.userContext;
    this.usageBalances = { ...this.usageBalances, ...balances };
    this.recalculateDerivedUsageTraits();
    this.markSegmentsDirtyFromContextChange(previousContext, this.userContext);
    this.persistLocalRuntimeState();
    void this.evaluateUserSegmentsAndUsage({}, true);
  }

  /**
   * Build the full persistence-ready {@link UserContext} from the current
   * SDK state. Includes `tenant_id` and `user_id` required for API storage.
   */
  getUserContext(): UserContext {
    const userId = this.userContext.id || this.anonymousId;
    const now = new Date().toISOString();
    return {
      id: userId,
      tenant_id: this.tenantId,
      user_id: userId,
      created_at: now,
      updated_at: now,
      account_id: this.userContext.account_id,
      email: this.userContext.email,
      plan: this.userContext.plan,
      usage: this.userContext.usage ?? {},
      entitlements: this.userContext.entitlements ?? {},
      custom: Object.fromEntries(
        Object.entries(this.userContext.custom ?? {}).filter(
          ([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null,
        ),
      ) as Record<string, string | number | boolean | null>,
      personalization: Object.fromEntries(
        Object.entries(this.userContext.personalization ?? {}).filter(
          ([, v]) => typeof v === 'string' || typeof v === 'number',
        ),
      ) as Record<string, string | number>,
      // Server-computed cache stamp (plan 74); the SDK does not compute it
      // locally, so the persisted snapshot carries null until the control
      // plane populates it.
      derived_computed_at: null,
    };
  }

  /**
   * Fetch the resolved user context from the decision API.
   * Returns the user's matched segments, traits, plan, and usage — used
   * to determine which placement payloads are eligible for display.
   */
  async fetchUserContext(userId: string): Promise<UserTargetingContext> {
    const rid = requestId();

    if (this.isLocalOnlyMode()) {
      const resolver = this.localRuntime?.resolvers?.fetchUserContext;
      if (resolver) {
        const context = await resolver(userId);
        this.localUserContextsByUserId.set(userId, context);
        this.persistLocalRuntimeState();
        return context;
      }
      const existing = this.localUserContextsByUserId.get(userId);
      if (existing) return existing;
      return { userId, segmentIds: [], traits: {}, plan: undefined, usage: this.usageBalances };
    }

    try {
      const response = await fetch(this.endpointFor('userContext', '/api/sdk/user-context'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'x-tenant-id': this.tenantId,
          'x-request-id': rid,
        },
        body: JSON.stringify({
          request_id: rid,
          tenant_id: this.tenantId,
          user_id: userId,
          context: {
            user: this.userContext,
            page: this.pageContext,
          },
        }),
      });

      if (!response.ok) {
        return { userId, segmentIds: [], traits: {} };
      }

      const data = await response.json() as JsonObject;
      const normalized = {
        userId,
        segmentIds: Array.isArray(data.segment_ids)
          ? (data.segment_ids as unknown[]).filter((id): id is string => typeof id === 'string') // sdk-ok: boundary-parse
          : [],
        traits: isRecord(data.traits) ? data.traits : {},
        plan: typeof data.plan === 'string' ? data.plan : undefined,
        usage: isRecord(data.usage) ? Object.fromEntries(
          Object.entries(data.usage).filter(([, v]) => typeof v === 'number'),
        ) as Record<string, number> : undefined,
      };
      this.localUserContextsByUserId.set(userId, normalized);
      this.persistLocalRuntimeState();
      return normalized;
    } catch {
      return { userId, segmentIds: [], traits: {} };
    }
  }

  /**
   * Record that a placement was rendered to the user. Plan 43 TASK-9.
   *
   * Writes an `impressed` record to the SDK's `ImpressionHistory`,
   * which persists to `localStorage` via `StorageImpressionStore`
   * (or in-memory storage in non-browser environments). The
   * impression contributes to:
   *
   *   - **Frequency caps (`cap.v1`)** — once-per-period limits
   *     count this impression against the user's quota for the
   *     placement.
   *   - **Trial milestone supersession analytics** — for trial_progress
   *     ladders, the supersession diagnostic uses delivery state
   *     to distinguish "replaced an undelivered placement" (counts
   *     in `superseded_placement_ids`) from "lower threshold was
   *     already shown" (NOT counted — spec §3.5 "supersession only
   *     applies to undelivered placements").
   *   - **Generic milestone supersession (`content.milestone_order`)**
   *     — the order-based variant in `applyContentMilestoneSupersession`.
   *
   * Call this from consumer code when the placement is actually
   * shown to the user (e.g., from a React component's `useEffect`
   * on mount, or after the rendering call returns). The SDK does
   * NOT auto-record impressions — surfaces are rendered by consumer
   * code, so only the consumer knows when a placement was actually
   * presented (vs. fetched but not displayed).
   *
   * Safe to call multiple times for the same placement — duplicates
   * append additional impression records (used by frequency caps to
   * count delivery events).
   *
   * @param placementId - The placement's stable rule_id (e.g.
   *   `'pl_trial_progress_70'`). Match `decision.output.rule_id`
   *   from `getPlacementDecision`.
   * @param payloadId - Optional payload variant id, for
   *   variant-level analytics.
   * @param surfaceTemplateId - Optional surface template id, for
   *   per-surface cap accounting.
   * @param metadata - Optional metadata persisted with the record.
   *
   * @example
   * ```ts
   * const decision = await sdk.getPlacementDecision({ placementId: 'slot_trial_modal' });
   * if (decision.visible && decision.output?.rule_id) {
   *   renderBanner(decision.output);
   *   await sdk.recordImpression(decision.output.rule_id, decision.output.output_id);
   * }
   * ```
   */
  async recordImpression(
    placementId: string,
    payloadId?: string,
    surfaceTemplateId?: string,
    metadata?: RevTurbineImpressionMetadata,
  ): Promise<void> {
    await this.impressionHistory.recordImpression(
      placementId,
      payloadId,
      surfaceTemplateId,
      metadata,
    );
  }

  /**
   * Record a placement dismissal — the user explicitly closed it.
   * The placement is permanently retired for this user; subsequent
   * `getPlacementDecision` calls return `visible: false`.
   *
   * @param placementId - The placement's stable rule_id.
   * @param payloadId - Optional payload variant id.
   * @param surfaceTemplateId - Optional surface template id.
   * @param metadata - Optional metadata persisted with the record.
   */
  async recordDismissal(
    placementId: string,
    payloadId?: string,
    surfaceTemplateId?: string,
    metadata?: RevTurbineImpressionMetadata,
  ): Promise<void> {
    await this.impressionHistory.recordDismissal(
      placementId,
      payloadId,
      surfaceTemplateId,
      metadata,
    );
  }

  /**
   * Record a placement click-through — the user engaged with the CTA.
   * The placement is permanently retired for this user.
   *
   * @param placementId - The placement's stable rule_id.
   * @param payloadId - Optional payload variant id.
   * @param surfaceTemplateId - Optional surface template id.
   * @param metadata - Optional metadata persisted with the record.
   */
  async recordClickThru(
    placementId: string,
    payloadId?: string,
    surfaceTemplateId?: string,
    metadata?: RevTurbineImpressionMetadata,
  ): Promise<void> {
    await this.impressionHistory.recordClickThru(
      placementId,
      payloadId,
      surfaceTemplateId,
      metadata,
    );
  }

  async getTrialStatus(): Promise<RevTurbineTrialContext> {
    const rid = requestId();

    if (this.isLocalOnlyMode()) {
      const resolver = this.localRuntime?.resolvers?.getTrialStatus;
      if (resolver) {
        const status = await resolver();
        this.localTrialStatus = status;
        await this.evaluateTrialLifecycleTriggers(status);
        this.persistLocalRuntimeState();
        return status;
      }
      await this.evaluateTrialLifecycleTriggers(this.localTrialStatus);
      return this.localTrialStatus;
    }

    try {
      const response = await fetch(this.endpointFor('trialStatus', '/api/sdk/trial-status'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          'x-tenant-id': this.tenantId,
          'x-request-id': rid,
        },
        body: JSON.stringify({
          request_id: rid,
          tenant_id: this.tenantId,
          user_id: this.userContext.id,
        }),
      });
      if (!response.ok) return { in_trial: false };
      const data = await response.json();
      const validated = this.validateTrialStatusShape(data);
      this.localTrialStatus = validated;
      await this.evaluateTrialLifecycleTriggers(validated);
      this.persistLocalRuntimeState();
      return validated;
    } catch {
      return { in_trial: false };
    }
  }

  /**
   * Returns the RevTurbineConfig snapshot loaded at initialization, if any.
   * Available only in `local_only` mode when `exportedConfig` was provided.
   */
  getExportedConfig(): RevTurbineConfig | undefined {
    return this.getConfiguredExportedConfig();
  }

  /**
   * Validate that each configured UI path action has a resolver implementation.
   *
  * By default this validates `localRuntime.exportedConfig.content_ui_paths` (when present)
   * against:
   * - `uiPathResolvers` passed at SDK init
   * - optional `resolvers` passed to this method
   * - CTA handlers from domain providers (`domain: 'cta'`), unless disabled
   */
  async validateUiPathResolvers(
    options: RevTurbineUiPathResolverValidationOptions = {},
  ): Promise<RevTurbineUiPathResolverValidationReport> {
    await this.refreshExportedConfigSnapshot();
    const exportedConfig = this.getConfiguredExportedConfig();
    const sourceUiPaths = Array.isArray(options.uiPaths)
      ? options.uiPaths
      : (isRecord(exportedConfig) && Array.isArray(exportedConfig.content_ui_paths)
        ? exportedConfig.content_ui_paths
        : []);

    const includeProviderHandlers = options.includeProviderHandlers ?? true;
    const optionResolvers = sanitizeUiPathResolverMap(
      options.resolvers,
      'validateUiPathResolvers(options.resolvers)',
    );
    const mergedResolvers: Record<string, unknown> = { // sdk-ok: type-definition
      ...this.uiPathResolvers,
      ...optionResolvers,
    };

    if (includeProviderHandlers && this.providerRegistry.has('cta')) {
      try {
        const ctx = await this.providerRegistry.resolveAll();
        if (isRecord(ctx.cta) && isRecord(ctx.cta.handlers)) {
          Object.assign(mergedResolvers, ctx.cta.handlers);
        }
      } catch {
        // Validation should remain best-effort and non-throwing.
      }
    }

    const issues: RevTurbineUiPathResolverValidationIssue[] = [];
    let resolvedUiPaths = 0;

    for (const raw of sourceUiPaths) {
      const uiPath: JsonObject = isRecord(raw) ? raw : {};
      const actionType = typeof uiPath.action_type === 'string'
        ? uiPath.action_type.trim()
        : '';

      if (!actionType) {
        issues.push({
          actionType: 'unknown',
          reason: 'missing_action_type',
          ...(typeof uiPath.id === 'string' ? { uiPathId: uiPath.id } : {}),
          ...(typeof uiPath.name === 'string' ? { name: uiPath.name } : {}),
        });
        continue;
      }

      if (typeof mergedResolvers[actionType] === 'function') {
        resolvedUiPaths += 1;
        continue;
      }

      issues.push({
        actionType,
        reason: 'missing_resolver',
        ...(typeof uiPath.id === 'string' ? { uiPathId: uiPath.id } : {}),
        ...(typeof uiPath.name === 'string' ? { name: uiPath.name } : {}),
      });
    }

    const report = {
      valid: issues.length === 0,
      totalUiPaths: sourceUiPaths.length,
      resolvedUiPaths,
      issues,
    };

    if (!report.valid && options.throwOnMissing) {
      const missingActionTypes = report.issues
        .filter((issue) => issue.reason === 'missing_resolver')
        .map((issue) => issue.actionType);
      const missingActionTypeMessage = missingActionTypes.length > 0
        ? ` Missing resolver(s) for action_type: ${Array.from(new Set(missingActionTypes)).join(', ')}.`
        : '';
      throw new Error(
        `[RevTurbine] UI path resolver validation failed with ${report.issues.length} issue(s).${missingActionTypeMessage}`,
      );
    }

    return report;
  }

  private assertUiPathResolverCoverageOrThrow(): void {
    const exportedConfig = this.getConfiguredExportedConfig();
    const uiPaths = isRecord(exportedConfig) && Array.isArray(exportedConfig.content_ui_paths)
      ? exportedConfig.content_ui_paths
      : [];

    if (uiPaths.length === 0) {
      return;
    }

    const missingActionTypes: string[] = [];
    let missingActionTypeCount = 0;

    for (const raw of uiPaths) {
      const uiPath: JsonObject = isRecord(raw) ? raw : {};
      const rawActionType = uiPath['action_type'];
      const actionType = typeof rawActionType === 'string'
        ? rawActionType.trim()
        : '';

      if (!actionType) {
        missingActionTypeCount += 1;
        continue;
      }

      if (typeof this.uiPathResolvers[actionType] !== 'function') {
        missingActionTypes.push(actionType);
      }
    }

    if (missingActionTypeCount === 0 && missingActionTypes.length === 0) {
      return;
    }

    const dedupedMissingActionTypes = Array.from(new Set(missingActionTypes));
    const details: string[] = [];
    if (dedupedMissingActionTypes.length > 0) {
      details.push(`missing resolvers for action_type: ${dedupedMissingActionTypes.join(', ')}`);
    }
    if (missingActionTypeCount > 0) {
      details.push(`content_ui_paths with missing action_type: ${missingActionTypeCount}`);
    }

    throw new Error(`[RevTurbine] SDK initialization failed: ${details.join('; ')}.`);
  }

  async dismiss(outputId: string): Promise<void> {
    await this.emitSemantic('placement_dismissed', {
      output_id: outputId,
      user_id: this.userContext.id ?? null,
      dismissed_at: new Date().toISOString(),
    }, { immediate: false });
  }

  async snooze(outputId: string, seconds = 3600): Promise<void> {
    await this.emitSemantic('placement_snoozed', {
      output_id: outputId,
      user_id: this.userContext.id ?? null,
      snoozed_at: new Date().toISOString(),
      remind_after_seconds: seconds,
    }, { immediate: false });
  }

  async convert(outputId: string): Promise<void> {
    await this.emitSemantic('placement_converted', {
      output_id: outputId,
      user_id: this.userContext.id ?? null,
      converted_at: new Date().toISOString(),
    }, { immediate: false });
  }

  /**
   * Emit a canonical trigger event recognised by the decision engine.
   *
   * Convenience wrapper over {@link emitSemantic} that constrains the event
   * name to {@link RevTurbineTriggerEvent} and attaches standard context
   * (user_id, plan, timestamp) automatically.
   *
   * @example
   * ```ts
   * await sdk.emitTrigger('usage_limit_approaching', { usage_percent: 85, threshold: 80 });
   * await sdk.emitTrigger('trial_expiring', { days_remaining: 2 });
   * await sdk.emitTrigger('feature_gated', { feature: 'advanced_automation' });
   * ```
   */
  async emitTrigger(
    trigger: RevTurbineTriggerEvent,
    payload?: RevTurbineTriggerPayload,
    options?: RevTurbineEventOptions,
  ): Promise<void> {
    await this.emitSemantic(trigger, {
      ...payload,
      user_id: this.userContext.id ?? null,
      plan_handle: this.userContext.personalization?.plan_name ?? null,
      triggered_at: new Date().toISOString(),
      source: 'sdk',
    }, options);
  }

  async trackEvent(name: string, data?: SdkEventProperties): Promise<void> {
    await this.capture(name, data ?? {});
  }

  identify(userId: string, contextOrTraits?: UserContextInput | SdkTraits): void {
    const previousContext = this.userContext;
    // Detect UserContextInput by the presence of its canonical fields.
    // Legacy callers pass a plain traits object without these keys; they remain fully backward-compatible.
    const isUserContextInput = contextOrTraits != null &&
      typeof contextOrTraits === 'object' &&
      !Array.isArray(contextOrTraits) &&
      (
        'account_id' in contextOrTraits ||
        'email' in contextOrTraits ||
        'plan' in contextOrTraits ||
        'usage' in contextOrTraits ||
        'entitlements' in contextOrTraits ||
        'custom' in contextOrTraits
      );

    if (isUserContextInput) {
      const ctx = contextOrTraits as UserContextInput;
      if (ctx.usage) {
        this.usageBalances = { ...this.usageBalances, ...usageAmountsFromEntries(ctx.usage) };
      }
      this.userContext = this.mergeUserContext({
        id: userId,
        account_id: ctx.account_id,
        email: ctx.email,
        plan: ctx.plan,
        usage: ctx.usage,
        entitlements: ctx.entitlements as Record<string, boolean> | undefined,
        custom: ctx.custom,
        personalization: ctx.personalization,
      });
    } else {
      // Legacy: plain traits object → map into custom
      this.userContext = this.mergeUserContext({
        id: userId,
        custom: contextOrTraits as SdkTraits | undefined,
        usage: {},
      });
    }
    this.recalculateDerivedUsageTraits();
    this.markSegmentsDirtyFromContextChange(previousContext, this.userContext);
    this.decisionCache.clear();
    this.persistDecisionCache();
    this.persistLocalRuntimeState();
    // Switch impression history to the new user and re-hydrate retired cache.
    this.impressionHistory.setUserId(userId);
    void this.impressionHistory.hydrate();
    // In the legacy path the traits object IS the custom map (plan 114 TASK-4).
    this.emitObservedContextFields(
      isUserContextInput ? (contextOrTraits as UserContextInput).custom : (contextOrTraits as SdkTraits | undefined),
    );
  }

  resetIdentity(): void {
    this.clearAllUserState({ reinfer: true });
  }

  /**
   * Hard-reset the user context to a blank slate — removes EVERY user-context
   * value (`id`, `plan`, `email`, `account_id`, `custom`, `usage`,
   * `entitlements`, `personalization`) plus usage balances, and clears the
   * decision cache, interaction state, and impression history.
   *
   * Unlike {@link resetIdentity} (a sign-out that re-infers anonymous context
   * when the `inferUser` policy is on), this performs **no** inference, so the
   * resulting context is guaranteed empty. Mostly for demo / fixture flows that
   * reset cleanly between scenarios.
   *
   * @example
   * // Between demo personas:
   * rt.resetUserContext();
   * rt.identify('demo_pro', { plan: { id: 'pro', name: 'Pro' } });
   */
  resetUserContext(): void {
    this.clearAllUserState({ reinfer: false });
  }

  /**
   * Shared teardown for {@link resetIdentity} / {@link resetUserContext}:
   * blanks the user context and usage balances, recomputes derived traits, and
   * clears the decision cache, interaction state, and impression history.
   * `reinfer` controls whether anonymous context is re-inferred (sign-out) or
   * the context is left fully empty (hard reset).
   */
  private clearAllUserState({ reinfer }: { reinfer: boolean }): void {
    const previousContext = this.userContext;
    this.userContext = {
      usage: {},
      ...(reinfer && this.policy.inferUser ? inferUserContext() : {}),
      id: undefined,
      custom: {},
      entitlements: {},
      personalization: {},
    };
    this.usageBalances = {};
    this.recalculateDerivedUsageTraits();
    this.markSegmentsDirtyFromContextChange(previousContext, this.userContext);
    this.decisionCache.clear();
    this.interactionState.clear();
    this.persistDecisionCache();
    this.persistInteractionState();
    this.persistLocalRuntimeState();
    // Reset impression history to anonymous user.
    this.impressionHistory.setUserId(this.anonymousId);
    void this.impressionHistory.hydrate();
  }

  // ── Advertised hero-API aliases (plan 84) ──────────────────────────────────
  // Thin, additive aliases for the friendly verb surface in the SDK
  // developer-experience spec (§3 table / §5 happy path). They delegate to the
  // canonical methods above; the canonical names remain fully supported.

  /**
   * Check whether the user can do something — the advertised alias of
   * {@link checkEntitlement}. Returns the rich {@link EntitlementResult}
   * (`allowed`, `status`, `reason`, limits, `enforcement`). For billing-critical
   * entitlements, confirm `enforcement === 'server_required'` on your backend.
   *
   * @example
   * const access = await rt.can('generate_image');
   * if (!access.allowed) showUpgrade();
   */
  can(handle: string, context?: RevTurbineEntitlementContext): Promise<EntitlementResult> {
    return this.checkEntitlement(handle, context);
  }

  /**
   * Gate an action behind an entitlement — the advertised `gate(action, fn)` verb.
   * Checks the entitlement for `action`; if allowed, runs `fn` and returns its
   * result; otherwise does NOT run `fn` and returns the entitlement so the caller
   * can surface a paywall (e.g. render an `<RTSlot>`). See {@link RevTurbineGateResult}.
   *
   * @example
   * const gated = await rt.gate('export_pdf', () => exportPdf());
   * if (!gated.ran) openPaywall(gated.entitlement);
   */
  async gate<T>(
    action: string,
    fn: () => T | Promise<T>,
    context?: RevTurbineEntitlementContext,
  ): Promise<RevTurbineGateResult<T>> {
    const entitlement = await this.checkEntitlement(action, context);
    if (entitlement.allowed) {
      const result = await fn();
      return { ran: true, result, entitlement };
    }
    return { ran: false, entitlement };
  }

  /**
   * Track an event — the advertised alias of {@link trackEvent}. Powers
   * analytics, frequency caps, attribution, and experiments.
   *
   * @example
   * rt.track('ai_generation_completed', { credits: 3 });
   */
  track(name: string, data?: SdkEventProperties): Promise<void> {
    return this.trackEvent(name, data);
  }

  /**
   * Patch customer-reported usage — the advertised `update({ usage })` verb,
   * delegating to {@link updateUsage}. For identity or full user-context changes
   * use {@link identify} / {@link setUserContext}.
   *
   * @example
   * rt.update({ usage: { generations: 25 } });
   */
  update(patch: RevTurbineUpdateInput): void {
    if (patch.usage) this.updateUsage(patch.usage);
  }

  /**
   * Clear the current user — the advertised alias of {@link resetIdentity}
   * (e.g. on sign-out).
   */
  reset(): void {
    this.resetIdentity();
  }

  onRouteChange(change: { path: string; title?: string; tags?: string[] }): void {
    this.setPageContext({
      url: `${isBrowser() ? window.location.origin : ''}${change.path}`,
      title: change.title,
      tags: change.tags,
    });

    void this.capture('page_view', {
      source: 'router_auto_track',
      path: change.path,
    });
  }
}

/**
 * Initialize the RevTurbine SDK.
 *
 * This is the primary entry point for browser integration.
 * Also available as `window.RevTurbine.init()` for non-module environments.
 *
 * @param options - SDK initialization options
 * @returns A configured SDK instance
 *
 * @example
 * ```ts
 * import { initRevTurbine } from '@revt-eng/sdk';
 *
 * const sdk = initRevTurbine({
 *   tenantId: 'tenant_abc',
 *   apiKey: 'rt_live_xxx',
 *   endpoint: 'https://api.revturbine.io',
 *   mode: 'snippet',
 * });
 * ```
 */
export function initRevTurbine(options: RevTurbineInitInputOptions): RevTurbineCustomerSdk {
  const normalizedOptions = normalizeInitOptions(options);
  const sdk = new RevTurbineCustomerSdk(normalizedOptions);

  if (!normalizedOptions.provider) {
    return sdk;
  }

  const resolveProvider = (
    candidate: RevTurbineSdkProvider | RevTurbineProviderFactory,
    chainIndex: number,
  ): RevTurbineSdkProvider | null => {
    try {
      return typeof candidate === 'function'
        ? candidate(normalizedOptions)
        : candidate;
    } catch (error) {
      console.warn(`[RevTurbine] Provider factory failed at chain index ${chainIndex}.`, error);
      return null;
    }
  };

  const providerChain = [
    resolveProvider(normalizedOptions.provider, 0),
    ...(normalizedOptions.providerFallbacks ?? []).map((candidate, index) => resolveProvider(candidate, index + 1)),
  ].filter((candidate): candidate is RevTurbineSdkProvider => candidate !== null);

  if (providerChain.length === 0) {
    sdk.disableForProviderFailure('provider_factory_chain_failed');
    return sdk;
  }

  const executeProviderChain = async <T>(
    methodName: 'getPlacement' | 'checkEntitlement' | 'persistPlacementTypes',
    args: unknown[], // sdk-ok: boundary-parse
    originalCall: () => Promise<T>,
  ): Promise<T> => {
    const attemptedProviders: number[] = [];

    for (let index = 0; index < providerChain.length; index += 1) {
      const candidate = providerChain[index];
      const method = candidate[methodName];
      if (!method) {
        continue;
      }

      attemptedProviders.push(index);
      try {
        return await (method as (...values: unknown[]) => Promise<T>)(...args); // sdk-ok: boundary-parse
      } catch (error) {
        const nextFallback = providerChain.slice(index + 1).some((next) => typeof next[methodName] === 'function');
        if (index === 0 && nextFallback) {
          console.warn(`[RevTurbine] Primary provider ${methodName} failed; trying configured fallbacks.`, error);
        } else {
          console.warn(`[RevTurbine] Provider ${methodName} failed at chain index ${index}.`, error);
        }
      }
    }

    if (attemptedProviders.length === 0) {
      return originalCall();
    }

    sdk.disableForProviderFailure(`provider_${methodName}_chain_failed`);
    return originalCall();
  };

  const originalGetPlacement = sdk.getPlacement.bind(sdk);
  const originalCheckEntitlement = sdk.checkEntitlement.bind(sdk);
  const originalPersistPlacementTypes = sdk.persistPlacementTypes.bind(sdk);
  const originalIdentify = sdk.identify.bind(sdk);

  sdk.getPlacement = async (config: RevTurbinePlacementRequestConfig) => (
    executeProviderChain('getPlacement', [config], () => originalGetPlacement(config))
  );

  sdk.checkEntitlement = async (handle: string, context?: RevTurbineEntitlementContext) => (
    executeProviderChain('checkEntitlement', [handle, context], () => originalCheckEntitlement(handle, context))
  );

  sdk.persistPlacementTypes = async (types: RevTurbinePlacementTypeEntity[]) => (
    executeProviderChain('persistPlacementTypes', [types], () => originalPersistPlacementTypes(types))
  );

  sdk.identify = (userId: string, contextOrTraits?: UserContextInput | SdkTraits) => {
    let attempted = 0;
    for (let index = 0; index < providerChain.length; index += 1) {
      const candidate = providerChain[index];
      if (!candidate.identify) {
        continue;
      }
      attempted += 1;
      try {
        candidate.identify(userId, contextOrTraits);
        return;
      } catch (error) {
        const nextFallback = providerChain.slice(index + 1).some((next) => typeof next.identify === 'function');
        if (index === 0 && nextFallback) {
          console.warn('[RevTurbine] Primary provider identify failed; trying configured fallbacks.', error);
        } else {
          console.warn(`[RevTurbine] Provider identify failed at chain index ${index}.`, error);
        }
      }
    }

    if (attempted > 0) {
      sdk.disableForProviderFailure('provider_identify_chain_failed');
      originalIdentify(userId, contextOrTraits);
      return;
    }

    originalIdentify(userId, contextOrTraits);
  };

  return sdk;
}

const LOCAL_ONLY_INIT_DEFAULTS: Pick<RevTurbineInitOptions, 'tenantId' | 'apiKey' | 'endpoint' | 'mode'> = {
  tenantId: 'local',
  apiKey: 'local-only',
  endpoint: 'https://api.revturbine.local',
  mode: 'react',
};

function hasValue(input: unknown): input is string { // sdk-ok: boundary-parse
  return typeof input === 'string' && input.trim().length > 0;
}

/**
 * Normalizes initialization options so local-only mode can be bootstrapped from
 * `localRuntime.exportedConfig` without requiring transport credentials.
 */
function normalizeInitOptions(options: RevTurbineInitInputOptions): RevTurbineInitWithProviderOptions {
  const hasExportedConfig = options.localRuntime?.exportedConfig !== undefined;
  if (!hasExportedConfig) {
    return options as RevTurbineInitWithProviderOptions;
  }

  return {
    ...options,
    tenantId: hasValue(options.tenantId) ? options.tenantId : LOCAL_ONLY_INIT_DEFAULTS.tenantId,
    apiKey: hasValue(options.apiKey) ? options.apiKey : LOCAL_ONLY_INIT_DEFAULTS.apiKey,
    endpoint: hasValue(options.endpoint) ? options.endpoint : LOCAL_ONLY_INIT_DEFAULTS.endpoint,
    mode: options.mode ?? LOCAL_ONLY_INIT_DEFAULTS.mode,
    runtimeMode: options.runtimeMode ?? 'local_only',
  };
}

function normalizePlacementTypeEntity(value: unknown): RevTurbinePlacementTypeEntity | null { // sdk-ok: boundary-parse
  if (!isRecord(value)) return null;

  const toCompactString = (input: unknown, maxLen: number): string => ( // sdk-ok: boundary-parse
    String(input ?? '').trim().slice(0, maxLen)
  );

  const id = toCompactString(value.id, 256);
  const label = toCompactString(value.label, 256);
  const description = toCompactString(value.description, 1024);
  const surfaceTypeRaw = toCompactString(value.surfaceType, 64);

  if (!id || !label || !description || !VALID_SURFACE_TYPES.has(surfaceTypeRaw as RevTurbineSurfaceType)) {
    return null;
  }

  const rawPriority = Number(value.priority);
  const priority = Number.isFinite(rawPriority) ? Math.max(0, Math.floor(rawPriority)) : 0;

  return {
    id,
    label,
    description,
    surfaceType: surfaceTypeRaw as RevTurbineSurfaceType,
    priority,
  };
}

declare global {
  interface Window {
    RevTurbine?: {
      init: typeof initRevTurbine;
    };
  }
}

if (typeof window !== 'undefined') {
  window.RevTurbine = {
    init: initRevTurbine,
  };
}
