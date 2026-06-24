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
