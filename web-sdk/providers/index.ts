// Domain providers — typed data providers for SDK decision inputs
export type {
  DomainProviderName,
  DomainProvider,
  AnyDomainProvider,
  ResolvedProviderContext,
  ResolvedDomainType,
  // Trait namespace
  TraitsNamespace,
  // Plan
  PlanProvider,
  PlanProviderState,
  // Entitlements
  EntitlementProvider,
  EntitlementProviderState,
  EntitlementUsageEntry,
  // Segments
  SegmentProvider,
  SegmentProviderState,
  // Experiments
  ExperimentProvider,
  ExperimentProviderState,
  // Content
  ContentProvider,
  ContentProviderState,
  MessageBlockSnapshot,
  PlacementPayloadSnapshot,
  // Rules
  RuleProvider,
  RuleProviderState,
  EntitlementRuleSnapshot,
  PlanRuleSnapshot,
  // Traits (base + typed built-ins)
  TraitsProvider,
  TraitsProviderState,
  TrialStatusTraits,
  TrialStatusProvider,
  UsageTraits,
  UsageTraitsProvider,
  // Theme
  ThemeProvider,
  ThemeProviderState,
  // Event consumer
  EventConsumer,
  EventConsumerProvider,
  EventConsumerProviderState,
  // CTA handler
  CtaHandler,
  CtaHandlerMap,
  CtaHandlerProvider,
  CtaHandlerProviderState,
} from './types';

export { DomainProviderRegistry } from './registry';

// Server-user-context provider (`traits:server`) — plan 165 TASK-4. Auto-wired by
// the SDK from the `/api/sdk/client-context` fetch; surfaces server-authoritative
// trial/billing signals into the evaluation traits bag.
export {
  ServerUserContextProvider,
  SERVER_TRAITS_DOMAIN,
} from './server-user-context-provider';
export type { ServerUserContextSnapshot } from './server-user-context-provider';

// The one built-in ExperimentProvider (plan 183 REQ-3b) — opt-in, deterministic,
// and off unless explicitly registered. A customer's own experimentation tool
// registers its own adapter instead; that path is first-class, not a fallback.
export {
  createBasicExperimentProvider,
  bucketSubject,
} from './basic-experiment-provider';
export type {
  BasicBucketerOptions,
  BasicBucketerExperiment,
} from './basic-experiment-provider';
