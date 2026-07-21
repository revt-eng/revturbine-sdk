/**
 * @module @revt-eng/web-sdk/headless
 *
 * Pure TypeScript SDK — no React dependency.
 *
 * Provides the same core SDK class, types, API client, placement
 * resolution, and storage as the full React package, but without
 * any React components, hooks, or context providers.
 *
 * Use this when:
 * - Building with a non-React framework (Vue, Svelte, Angular, vanilla JS)
 * - Running on the server (Node.js, edge functions)
 * - Writing CLI tools or scripts that need SDK types
 * - Creating a custom UI layer on top of the SDK core
 *
 * ## Quick Start
 *
 * ```ts
 * import { initRevTurbine } from '@revt-eng/web-sdk/headless';
 *
 * const sdk = initRevTurbine({
 *   tenantId: 'tenant_abc',
 *   apiKey: 'rt_live_xxx',
 *   endpoint: 'https://api.revturbine.io',
 * });
 *
 * sdk.identify('user_123', { plan: 'pro' });
 * const decision = sdk.getPlacementDecision({ placementId: 'upsell_banner' });
 * const entitled = sdk.checkEntitlement('feature_x');
 * ```
 */

// ── Schema types (canonical, from @revt-eng/schema) ─────────────────────────
export * from './generated';

// ── Portable config dual-read boundary ─────────────────────────────────────
export {
  normalizeConfigArtifactOrThrow,
} from './config-artifact';
export type {
  ConfigArtifact,
  LegacyConfigTargetDefaults,
} from './config-artifact';

// ── Core SDK class + init + config builders ─────────────────────────────────
export * from './customer-side';
// Branding resolution (plan 118 TASK-20). Named re-exports so the @internal
// test-reset helper stays out of the public surface.
export { DEFAULT_BRANDING, resolveBranding } from './branding';
export type { BrandingSource, BrandingResolutionInput, ResolvedBranding } from './branding';

// ── Trial-status helpers (plan 43 — re-exported from @revt-eng/core) ────────
//
// Customers integrating in static mode (or wiring server-side trial
// state into the SDK) use these to translate a persisted
// `TrialInstance` into the runtime `UserTrialStatus` shape the SDK
// consumes via the `getTrialStatus` resolver or the `trialStatus`
// init field. Example:
//
//   import {
//     deriveLocalTrialStatusFromInstance,
//     findActiveTrialInstance,
//   } from '@revt-eng/sdk/headless';
//
//   const active = findActiveTrialInstance(myInstances, new Date().toISOString());
//   const status = active && deriveLocalTrialStatusFromInstance({
//     instance: active,
//     rule: myMatchingRule,
//     nowIso: new Date().toISOString(),
//     basePlanHandle: myUserBasePlan,
//   });
//   sdk.setTrialStatus(status);
//
// `deriveReverseTrialGrants` produces the inputs scaffold's
// `EntitlementCheckInput` consumes — the SDK calls it internally
// when deriving entitlements during a reverse trial, but customers
// can use it directly when composing custom decision flows.
// Imported from the main `@revt-eng/core` barrel (not the `/trials`
// subpath) because v0.1.44's package.json exports field doesn't yet
// expose `./trials` — the helpers ARE bundled via the main index.
// When scaffold ships the subpath, this import can move to
// `@revt-eng/core/trials` for tree-shaking benefit.
export {
  deriveLocalTrialStatusFromInstance,
  findActiveTrialInstance,
  findLatestStartedTrialInstance,
  deriveReverseTrialGrants,
  evaluateTrialStatus,
} from '@revt-eng/core';
export type {
  DeriveTrialStatusInput,
  EvaluateTrialStatusInput,
  EvaluateTrialStatusResult,
} from '@revt-eng/core';

// Resolve ambiguous re-exports — prefer SDK-local definitions over schema
export type {
  EntitlementStatus,
  FeatureGateTriggerPayload,
  PaymentTriggerPayload,
  TrialTriggerPayload,
  UsageTriggerPayload,
} from './customer-side';

// ── Headless controllers (framework-agnostic orchestration) ─────────────────
export {
  PlacementController,
  EntitlementGate,
  SdkSession,
  initRevTurbine,
} from './controllers';
export type {
  ChangeListener,
  PlacementControllerOptions,
  PlacementControllerState,
  EntitlementGateOptions,
  EntitlementGateState,
  SdkSessionOptions,
} from './controllers';

// ── API client ──────────────────────────────────────────────────────────────
export {
  createRevTurbineApiClient,
  ApiError as RevTurbineApiError,
} from './api-client';
export type {
  RevTurbineApiClient,
  RevTurbineApiClientConfig,
  paths as RevTurbineApiPaths,
} from './api-client';

// ── Environment detection ───────────────────────────────────────────────────
export { isServer, isBrowser } from './env';

// ── Storage ─────────────────────────────────────────────────────────────────
export {
  InMemoryStorage,
  BrowserStorage,
  resolvePersistentStorage,
  resolveSessionStorage,
} from './storage';
export type { RevTurbineStorage } from './storage';

// ── Browser Runtime (browser-optimized LocalRuntime with localStorage) ──────
export { BrowserRuntime } from './browser-runtime';
export type { BrowserRuntimeOptions } from './browser-runtime';

// ── Segments ────────────────────────────────────────────────────────────────
export * from './segments';

// ── Providers (domain provider system) ──────────────────────────────────────
export * from './providers';

// ── Analytics (event consumer adapter for third-party platforms) ─────────────
export {
  createAnalyticsProvider,
  createPostHogAnalyticsProvider,
} from './analytics';
export type {
  AnalyticsProviderOptions,
  AnalyticsEventHandler,
  AnalyticsEventTransformer,
  AnalyticsEventProperties,
  PostHogLike,
  PostHogAnalyticsProviderOptions,
} from './analytics';

// ── Control-plane semantic events (plan 112 — dogfood taxonomy) ──────────────
export {
  CONTROL_PLANE_EVENT_SOURCE,
  CONTROL_PLANE_SOURCE_KEY,
  buildControlPlaneEvent,
} from './control-plane-events';
export type {
  ControlPlaneEmitInput,
} from './control-plane-events';

// ── Placement types, registry, and resolution (pure TS) ─────────────────────
export type {
  PlacementSlotType,
  PlacementSlotProps,
  PlacementContentFields,
  ResolvedContent,
  PlacementUiPath,
  PlacementUiPathActionType,
  PlacementPromotion,
  RegisterPlacementSlotTypeOptions,
  PersonalizationContext,
  PlacementPreviewConfig,
  PlacementCustomCode,
} from './placements/types';

export {
  PlacementTypeRegistry,
  getDefaultRegistry,
  resetDefaultRegistry,
  resolveContent,
  resolveTokens,
  parseUiPath,
  parsePromotion,
} from './placements/registry';

export { registerBuiltinSlotTypes } from './placements/builtin';

export {
  resolvePayloadForUser,
  resolvePayloadForUserWithProvider,
  applyValueMaps,
  createStaticPlacementContentLookupProvider,
} from './placements/payload-resolution';
export type {
  ResolvedPayload,
  PlacementContentLookupProvider,
} from './placements/payload-resolution';

export {
  createStaticPlacementResolver,
} from './placements/local-resolver';
export type {
  LocalPlacementDataset,
  LocalPlacementEntry,
  LocalPlacementPayload,
  LocalPlacementSurface,
  StaticPlacementResolverOptions,
} from './placements/local-resolver';

export {
  FIXED_BANNER_TEMPLATE_IDS,
  GENERAL_BANNER_TEMPLATE_IDS,
  GENERAL_TOAST_TEMPLATE_IDS,
  GENERAL_MODAL_TEMPLATE_IDS,
} from './placements/surface-template-defaults';

export {
  FIXED_SURFACE_TEMPLATE_IDS,
  GATED_SURFACE_TEMPLATE_IDS,
  MESSAGE_SURFACE_TEMPLATE_IDS,
} from './placements/surface-slot-constants';

// ── Theme (pure TS — types, defaults, loader) ──────────────────────────────
export type {
  RevTurbineTheme,
  RevTurbineThemeInput,
  RevTurbineThemeColors,
  RevTurbineThemeTypography,
  RevTurbineThemeShape,
  RevTurbineThemeShadows,
} from './theme/types';

export { DEFAULT_THEME, mergeTheme } from './theme/defaults';
export { loadTheme, clearPersistedTheme } from './theme/theme-loader';
export type { ThemeLoaderOptions } from './theme/theme-loader';

// ── Server SDK ──────────────────────────────────────────────────────────────
export { RevTurbineServer } from '../server-node';
export type {
  RevTurbineServerOptions,
  ServerEvaluationPayload,
  ServerEvaluationRequest,
  ServerPlacementRequest,
  ServerPlacementDecision,
  ServerEntitlementResult,
  ServerUserContext,
} from '../server-node';

// ── Isomorphic core re-exports ──────────────────────────────────────────────
export {
  DecisionEngine,
  InteractionTracker,
  CapEnforcer,
  createStaticProviders,
  createHydrationProviders,
} from '@revt-eng/core';
export {
  createApiProviders,
} from './adapters/api';
export type {
  ApiAdapterOptions,
} from './adapters/api';
export type {
  DecisionEngineOptions,
  EvaluationContext,
  AdapterBaseOptions,
  InteractionState,
  PresentationCapState,
  PlacementCapPolicy,
  PlacementCapRule,
  CapPeriod,
  SuppressionResult,
  CapEnforcementResult,
} from '@revt-eng/core';
