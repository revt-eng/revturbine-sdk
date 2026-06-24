/**
 * @revt-eng/sdk-core — isomorphic SDK core.
 *
 * Runtime-agnostic evaluation engine, provider system, and data adapters.
 * Works on edge, server (Node.js / Next.js), and client (browser).
 *
 * Usage:
 * ```ts
 * import {
 *   DecisionEngine,
 *   DomainProviderRegistry,
 *   InteractionTracker,
 *   CapEnforcer,
 *   createStaticProviders,
 *   InMemoryStorage,
 * } from '@revt-eng/sdk-core';
 * ```
 */

// ---- Core types ----
export type {
  PersonalizationContext,
  ResolvedContent,
  PlacementOutput,
  EntitlementResult,
  RevTurbineDecisionContent,
  RevTurbineContextMode,
  RevTurbineMeterUsageOverride,
  RevTurbinePlacementDecisionOverrides,
  RevTurbinePlacementDecisionInput,
  RevTurbinePlacementDecision,
  RevTurbinePlacementRecord,
  RevTurbineEntitlementContext,
  RevTurbineSurfaceType,
  UserTargetingContext,
  RevTurbineEventEnvelope,
  PlacementUiPath,
  RevTurbineThemeInput,
} from './types';

// ---- Environment ----
export { isServer, isBrowser } from './env';

// ---- Provider system ----
export { DomainProviderRegistry } from './providers/registry';
export type {
  DomainProviderName,
  DomainProvider,
  AnyDomainProvider,
  ResolvedProviderContext,
  ResolvedDomainType,
  TraitsNamespace,
  PlanProvider,
  PlanProviderState,
  EntitlementProvider,
  EntitlementProviderState,
  EntitlementUsageEntry,
  EntitlementGrant,
  EntitlementGrantSet,
  EntitlementAllocation,
  SegmentProvider,
  SegmentProviderState,
  ContentProvider,
  ContentProviderState,
  MessageBlockSnapshot,
  PlacementPayloadSnapshot,
  RuleProvider,
  RuleProviderState,
  EntitlementRuleSnapshot,
  PlanRuleSnapshot,
  TraitsProvider,
  TraitsProviderState,
  TrialStatusTraits,
  TrialStatusProvider,
  UsageTraits,
  UsageTraitsProvider,
  ThemeProvider,
  ThemeProviderState,
  EventConsumer,
  EventConsumerProvider,
  EventConsumerProviderState,
  CtaHandler,
  CtaHandlerMap,
  CtaHandlerProvider,
  CtaHandlerProviderState,
} from './providers/types';

// ---- Evaluation engine ----
export { DecisionEngine } from './evaluation/engine';
export type { DecisionEngineConfig } from './evaluation/engine';
export type {
  DecisionEngineOptions,
  EntitlementCheckResult,
  EvaluationContext,
} from './evaluation/types';

// ---- Segment evaluation ----
export { evaluateSegments } from './evaluation/segments';
export type { Trait, ExportedConfigSegmentsItem, ExportedConfigSegmentsItemPredicatesItem } from './evaluation/segments';

// ---- Rules evaluation ----
export {
  evaluateEntitlementRules,
  evaluatePlanRules,
  findMatchingEntitlementRule,
} from './evaluation/rules';
export type { RuleEvaluationContext, EntitlementRuleEvaluation } from './evaluation/rules';

// ---- Entitlement grant resolution ----
export {
  resolveEffectiveEntitlements,
  resolveEffectiveUsage,
} from './resolution/entitlement-resolution';
export type { ResolveEntitlementOptions } from './resolution/entitlement-resolution';

// ---- State management ----
export { InteractionTracker } from './state/interaction-tracker';
export type { InteractionTrackerOptions } from './state/interaction-tracker';
export { CapEnforcer } from './state/cap-enforcer';
export type { CapEnforcerOptions } from './state/cap-enforcer';
export { InMemoryStorage } from './state/storage';
export type { RevTurbineStorage } from './state/storage';
export type {
  RevTurbineTreatmentInteractionType,
  RevTurbineTreatmentInteractionInput,
  InteractionState,
  CapPeriod,
  PlacementCapRule,
  PlacementCapPolicy,
  PresentationCapState,
  SuppressionResult,
  CapEnforcementResult,
} from './state/types';

// ---- Impression history ----
export { ImpressionHistory } from './state/impression-history';
export type { ImpressionHistoryOptions } from './state/impression-history';
export {
  InMemoryImpressionStore,
  StorageImpressionStore,
} from './state/impression-history-stores';
export type {
  ImpressionHistoryStore,
  ImpressionRecord,
  ImpressionOutcome,
  ImpressionQuery,
} from './state/impression-history-types';
export { TERMINAL_OUTCOMES } from './state/impression-history-types';
export { DEFAULT_SUPPRESSION_MS } from './state/impression-history-types';

// ---- Resolution ----
export { createStaticPlacementResolver } from './resolution/local-resolver';
export type {
  LocalPlacementDataset,
  LocalPlacementEntry,
  LocalPlacementPayload,
  LocalPlacementSurface,
  StaticPlacementResolverOptions,
} from './resolution/local-resolver';
export { derivePlacementPersonalizationTokens } from './resolution/token-derivation';
export {
  resolveTokens,
  resolveContent,
  resolvePayloadForUser,
  resolvePayloadForUserWithProvider,
  applyValueMaps,
  createStaticPlacementContentLookupProvider,
} from './resolution/payload-resolution';
export type {
  ResolvedPayload,
  PlacementContentLookupProvider,
} from './resolution/payload-resolution';

// ---- Adapters ----
export { createStaticProviders } from './adapters/static';
export type { StaticAdapterOptions } from './adapters/static';
export { createHydrationProviders } from './adapters/hydration';
export type { HydrationAdapterOptions } from './adapters/hydration';
export type { AdapterBaseOptions, CreateProvidersResult } from './adapters/types';

// ---- Pure helpers ----
export {
  isRecord,
  ensureArray,
  firstStringValue,
  parseNumberish,
  normalizedRoute,
  sanitizeSlug,
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
} from './helpers';
export type { JsonValue, JsonObject, LocalLookupParts, TrialContext as HelperTrialContext } from './helpers';

// ---- Crypto abstraction ----
export { base64UrlFromBytes, fallbackHashBase64Url, FallbackCryptoProvider } from './crypto';
export type { CryptoProvider } from './crypto';

// ---- Lifecycle pure functions ----
export * from './lifecycle';
