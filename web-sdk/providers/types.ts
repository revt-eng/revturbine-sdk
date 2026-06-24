/**
 * Domain provider types — re-exported from @revt-eng/core.
 *
 * This file maintains backward compatibility for web-sdk consumers.
 * All canonical type definitions live in core/providers/types.ts.
 */

export type {
  TraitsNamespace,
  DomainProviderName,
  DomainProvider,
  PlanProviderState,
  PlanProvider,
  EntitlementUsageEntry,
  EntitlementProviderState,
  EntitlementProvider,
  SegmentProviderState,
  SegmentProvider,
  MessageBlockSnapshot,
  PlacementPayloadSnapshot,
  ContentProviderState,
  ContentProvider,
  EntitlementRuleSnapshot,
  PlanRuleSnapshot,
  RuleProviderState,
  RuleProvider,
  TraitsProviderState,
  TraitsProvider,
  TrialStatusTraits,
  TrialStatusProvider,
  UsageTraits,
  UsageTraitsProvider,
  ThemeProviderState,
  ThemeProvider,
  EventConsumer,
  EventConsumerProviderState,
  EventConsumerProvider,
  CtaHandler,
  CtaHandlerMap,
  CtaHandlerProviderState,
  CtaHandlerProvider,
  ResolvedProviderContext,
  AnyDomainProvider,
  ResolvedDomainType,
} from '@revt-eng/core';
