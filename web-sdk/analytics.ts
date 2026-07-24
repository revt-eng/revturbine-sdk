/**
 * Analytics adapter — bridges RevTurbine SDK events to third-party analytics
 * platforms (Heap, Segment, Amplitude, Mixpanel, PostHog, custom, etc.).
 *
 * Implements the {@link EventConsumerProvider} domain provider interface so it
 * plugs into the SDK's `domainProviders` array at init time.
 *
 * @example
 * ```ts
 * import { createAnalyticsProvider } from '@revturbine/sdk';
 *
 * const analytics = createAnalyticsProvider({
 *   handler: (eventName, properties) => {
 *     window.analytics.track(eventName, properties);
 *   },
 * });
 *
 * initRevTurbine({ domainProviders: [analytics], ... });
 * ```
 *
 * @module
 */

import type {
  EventConsumer,
  EventConsumerProvider,
  EventConsumerProviderState,
  RevTurbineEventEnvelope,
} from '@revt-eng/core';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * Flat properties object passed to the analytics handler after
 * transforming a raw {@link RevTurbineEventEnvelope}.
 */
export type AnalyticsEventProperties = Record<string, unknown>; // sdk-ok: type-definition

/**
 * Callback invoked for every SDK event.
 *
 * @param eventName - Normalised event name (e.g. `'placement_interaction'`).
 * @param properties - Flat key-value properties derived from the event envelope.
 */
export type AnalyticsEventHandler = (
  eventName: string,
  properties: AnalyticsEventProperties,
) => void;

/**
 * Optional transformer applied before the handler.
 * Return `null` to drop the event silently.
 */
export type AnalyticsEventTransformer = (
  eventName: string,
  properties: AnalyticsEventProperties,
) => { eventName: string; properties: AnalyticsEventProperties } | null;

/** Configuration for {@link createAnalyticsProvider}. */
export interface AnalyticsProviderOptions {
  /**
   * Callback that pushes one event to the analytics platform.
   * Called once per SDK event after optional transformation.
   */
  handler: AnalyticsEventHandler;

  /**
   * Optional transform applied before the handler.
   * Use this to rename events, enrich properties, or drop events
   * you don't care about.
   *
   * Return `null` to suppress the event.
   */
  transform?: AnalyticsEventTransformer;

  /**
   * When provided, only events whose `type` matches one of these
   * strings are forwarded. All others are silently dropped.
   *
   * @example ['placement_interaction', 'placement_dismissed']
   */
  filter?: string[];

  /**
   * Human-readable consumer name shown in diagnostics.
   * @default 'analytics'
   */
  name?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface EventEnvelopeLike {
  type: string;
  tenant_id: string;
  user_id: string | null;
  anonymous_id: string;
  session_id: string;
  url: string;
  path: string;
  page_title: string;
  event_time: string;
  properties: Record<string, unknown>; // sdk-ok: type-definition
  identity: { traits: Record<string, unknown> }; // sdk-ok: type-definition
}

/**
 * Envelope-owned keys in the flattened bag. A customer property using one of
 * these names is relocated rather than allowed to overwrite system context.
 */
const CANONICAL_KEYS = new Set([
  'tenant_id',
  'user_id',
  'anonymous_id',
  'session_id',
  'url',
  'path',
  'page_title',
  'event_time',
]);

/**
 * Flatten an envelope into a simple properties bag.
 *
 * Canonical envelope fields win over customer properties. Flattening used to
 * spread `env.properties` last, so an event carrying a property literally named
 * `tenant_id` or `user_id` replaced the system value on its way to PostHog —
 * silently corrupting identity in the destination while RevTurbine's own
 * pipeline (which nests the property bag instead of spreading it) stayed
 * correct. The displaced customer value is preserved under an `rt_prop_`
 * prefix so nothing is lost.
 */
function flattenEnvelope(env: EventEnvelopeLike): AnalyticsEventProperties {
  const properties: AnalyticsEventProperties = {};
  for (const [key, value] of Object.entries(env.properties)) {
    properties[CANONICAL_KEYS.has(key) ? `rt_prop_${key}` : key] = value;
  }

  return {
    ...properties,
    tenant_id: env.tenant_id,
    user_id: env.user_id,
    anonymous_id: env.anonymous_id,
    session_id: env.session_id,
    url: env.url,
    path: env.path,
    page_title: env.page_title,
    event_time: env.event_time,
  };
}

/* ------------------------------------------------------------------ */
/*  AnalyticsConsumer (internal EventConsumer implementation)           */
/* ------------------------------------------------------------------ */

class AnalyticsConsumer implements EventConsumer {
  readonly name: string;
  private readonly handler: AnalyticsEventHandler;
  private readonly transform?: AnalyticsEventTransformer;
  private readonly filterSet?: Set<string>;

  constructor(options: AnalyticsProviderOptions) {
    this.name = options.name ?? 'analytics';
    this.handler = options.handler;
    this.transform = options.transform;
    this.filterSet = options.filter ? new Set(options.filter) : undefined;
  }

  consume(events: EventEnvelopeLike[]): void {
    for (const event of events) {
      if (this.filterSet && !this.filterSet.has(event.type)) continue;

      let eventName = event.type;
      let props = flattenEnvelope(event);

      if (this.transform) {
        const result = this.transform(eventName, props);
        if (result === null) continue;
        eventName = result.eventName;
        props = result.properties;
      }

      try {
        this.handler(eventName, props);
      } catch {
        // Never let a third-party analytics error crash the SDK.
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create an analytics domain provider that forwards SDK events
 * (impressions, interactions, triggers, page views, etc.) to a
 * third-party analytics platform.
 *
 * The returned provider should be passed in the `domainProviders`
 * array when calling `initRevTurbine()`.
 *
 * @example Segment
 * ```ts
 * const analytics = createAnalyticsProvider({
 *   handler: (eventName, properties) => {
 *     window.analytics.track(eventName, properties);
 *   },
 * });
 * ```
 *
 * @example Heap (filtered to interactions only)
 * ```ts
 * const analytics = createAnalyticsProvider({
 *   handler: (eventName, properties) => {
 *     heap.track(eventName, properties);
 *   },
 *   filter: ['placement_interaction', 'placement_dismissed', 'placement_converted'],
 * });
 * ```
 *
 * @example Custom transform
 * ```ts
 * const analytics = createAnalyticsProvider({
 *   handler: (name, props) => posthog.capture(name, props),
 *   transform: (name, props) => ({
 *     eventName: `revturbine.${name}`,
 *     properties: { ...props, source: 'revturbine-sdk' },
 *   }),
 * });
 * ```
 */
export function createAnalyticsProvider(
  options: AnalyticsProviderOptions,
): EventConsumerProvider {
  const consumer = new AnalyticsConsumer(options);

  return {
    domain: 'events',
    resolve: () => ({ consumers: [consumer] }),
  };
}

/* ------------------------------------------------------------------ */
/*  PostHog resolver (plan 112)                                        */
/* ------------------------------------------------------------------ */

/**
 * Minimal shape of a PostHog client — satisfied by both `posthog-js`
 * (browser) and `posthog-node` (server). `capture` is always used; the identity
 * lifecycle methods are optional and only called by {@link createPostHogIntegration}
 * when the matching sync flag is on. This is a structural interface — no PostHog
 * package is imported or bundled (the client is injected).
 */
export interface PostHogLike {
  capture(event: string, properties?: Record<string, unknown>): void; // sdk-ok: type-definition
  /** Optional — mirrors a RevTurbine identify when `syncIdentity` is on. */
  identify?(distinctId: string, properties?: Record<string, unknown>): void; // sdk-ok: type-definition
  /** Optional — mirrors an account group when `syncAccountGroup` is on. */
  group?(groupType: string, groupKey: string, properties?: Record<string, unknown>): void; // sdk-ok: type-definition
  /** Optional — called when the identity is cleared (logout) under `syncIdentity`. */
  reset?(): void;
}

/** Configuration for {@link createPostHogAnalyticsProvider}. */
export interface PostHogAnalyticsProviderOptions {
  /** The PostHog client instance (`posthog-js` or `posthog-node`). */
  posthog: PostHogLike;

  /**
   * When provided, only events whose `type` matches one of these strings are
   * forwarded to PostHog. Use e.g. the control-plane event types to forward
   * only semantic control-plane events. All others are silently dropped.
   */
  filter?: string[];

  /** Optional transform applied before capture (rename / enrich / drop). */
  transform?: AnalyticsEventTransformer;

  /**
   * Human-readable consumer name shown in diagnostics.
   * @default 'posthog'
   */
  name?: string;
}

/**
 * Create an analytics resolver that forwards SDK events to PostHog (plan 112).
 *
 * A thin PostHog-typed convenience over {@link createAnalyticsProvider}: each
 * SDK event becomes `posthog.capture(eventName, properties)`. Pass the result
 * in the `domainProviders` array at init so the same semantic events feed both
 * the first-party ingest pipeline and PostHog.
 *
 * Like {@link createAnalyticsProvider}, a throw from `posthog.capture` is
 * swallowed — a PostHog failure never crashes the SDK event pipeline.
 *
 * @example
 * ```ts
 * import posthog from 'posthog-js';
 * import { createPostHogAnalyticsProvider, initRevTurbine } from '@revturbine/sdk';
 *
 * const analytics = createPostHogAnalyticsProvider({ posthog });
 * initRevTurbine({ domainProviders: [analytics], ... });
 * ```
 */
export function createPostHogAnalyticsProvider(
  options: PostHogAnalyticsProviderOptions,
): EventConsumerProvider {
  const { posthog, filter, transform, name } = options;
  return createAnalyticsProvider({
    name: name ?? 'posthog',
    filter,
    transform,
    handler: (eventName, properties) => {
      posthog.capture(eventName, properties);
    },
  });
}

/** Configuration for {@link createPostHogIntegration}. */
export interface PostHogIntegrationOptions extends PostHogAnalyticsProviderOptions {
  /**
   * Mirror RevTurbine identify / logout to `posthog.identify` / `posthog.reset`.
   * The distinct id is RevTurbine's already-redacted (hashed) user id — never a
   * raw email. Default `false`.
   */
  syncIdentity?: boolean;
  /**
   * Mirror the `account_id` trait to a PostHog group (`group('account', id)`)
   * when it changes. Default `false`.
   */
  syncAccountGroup?: boolean;
  /**
   * Mirror `page_view` events to a native PostHog `$pageview`. Default `false`.
   */
  mirrorNavigation?: boolean;
}

/**
 * Create a PostHog integration with an optional identity lifecycle (plan 144
 * TASK-17 / REQ-26).
 *
 * A superset of {@link createPostHogAnalyticsProvider}: every event is still
 * `posthog.capture(name, properties)` with the **same `filter` / `transform`
 * semantics** (REQ-27), and — when the matching flag is on — RevTurbine's
 * identify/logout, account grouping, and navigation are mirrored to PostHog's
 * native `identify` / `reset` / `group` / `$pageview`. All sync flags default
 * `false`, so by default this behaves exactly like the capture-only provider.
 *
 * No PostHog package is imported or bundled — the client is injected — so this
 * code is tree-shakable and only pulled in when you import it (AC-20). A throw
 * from any PostHog call is swallowed and never blocks RevTurbine ingest (AC-17).
 *
 * `createPostHogAnalyticsProvider` remains exported for existing integrations.
 */
export function createPostHogIntegration(options: PostHogIntegrationOptions): EventConsumerProvider {
  const {
    posthog,
    filter,
    transform,
    name,
    syncIdentity = false,
    syncAccountGroup = false,
    mirrorNavigation = false,
  } = options;
  const displayName = name ?? 'posthog';
  const base = createPostHogAnalyticsProvider({ posthog, filter, transform, name: displayName });

  let lastUserId: string | null = null;
  let lastGroup: string | null = null;

  const mirrorLifecycle = (event: RevTurbineEventEnvelope): void => {
    try {
      if (syncIdentity) {
        const userId = event.user_id;
        if (userId && userId !== lastUserId) {
          posthog.identify?.(userId, event.identity.traits);
          lastUserId = userId;
        } else if (!userId && lastUserId !== null) {
          posthog.reset?.();
          lastUserId = null;
        }
      }
      if (syncAccountGroup) {
        const accountId = event.identity.traits.account_id;
        if (typeof accountId === 'string' && accountId && accountId !== lastGroup) {
          posthog.group?.('account', accountId);
          lastGroup = accountId;
        }
      }
      if (mirrorNavigation && event.type === 'page_view') {
        posthog.capture('$pageview', { $current_url: event.url });
      }
    } catch {
      // Best-effort — a PostHog lifecycle error never breaks the event pipeline.
    }
  };

  return {
    domain: 'events',
    async resolve(): Promise<EventConsumerProviderState> {
      const baseState = await base.resolve();
      const baseConsumers = baseState?.consumers ?? [];
      const consumer: EventConsumer = {
        name: displayName,
        consume(events) {
          for (const event of events) mirrorLifecycle(event);
          for (const baseConsumer of baseConsumers) baseConsumer.consume(events);
        },
      };
      return { consumers: [consumer] };
    },
  };
}
