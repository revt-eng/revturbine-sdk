/**
 * Plan 112 TASK-2b — analytics resolvers (AC-5).
 *
 * The SDK forwards events to third-party analytics via `EventConsumerProvider`
 * adapters. These tests pin the PostHog convenience resolver: it captures each
 * event into a PostHog-like client, honors the filter, and never lets a PostHog
 * failure crash the SDK event pipeline.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPostHogAnalyticsProvider, type PostHogLike } from './analytics';

/** A single SDK event envelope, minimally shaped for the consumer. */
function envelope(type: string, properties: Record<string, unknown> = {}) {
  return {
    type,
    tenant_id: 'tn_revturbine',
    user_id: 'operator_42',
    anonymous_id: 'anon_1',
    session_id: 'sess_1',
    url: 'https://app.revturbine.com',
    path: '/monetization',
    page_title: 'Monetization',
    event_time: '2026-07-01T00:00:00.000Z',
    properties,
    identity: { traits: {} },
  };
}

/** Resolve the provider's single consumer for direct `consume()` calls. */
function consumerOf(provider: ReturnType<typeof createPostHogAnalyticsProvider>) {
  const resolved = provider.resolve() as { consumers: Array<{ consume(events: unknown[]): void }> };
  return resolved.consumers[0];
}

describe('createPostHogAnalyticsProvider', () => {
  it('forwards each event to posthog.capture with flattened properties', () => {
    const capture = vi.fn();
    const posthog: PostHogLike = { capture };
    const provider = createPostHogAnalyticsProvider({ posthog });

    consumerOf(provider).consume([envelope('changeset_deployed', { control_plane_source: 'workflow', change_set_id: 'cs_9' })]);

    expect(capture).toHaveBeenCalledTimes(1);
    const [eventName, props] = capture.mock.calls[0];
    expect(eventName).toBe('changeset_deployed');
    // The analytics consumer flattens envelope + properties to top level.
    expect(props).toMatchObject({
      user_id: 'operator_42',
      control_plane_source: 'workflow',
      change_set_id: 'cs_9',
    });
  });

  it('honors the filter — only allow-listed event types reach PostHog', () => {
    const capture = vi.fn();
    const provider = createPostHogAnalyticsProvider({
      posthog: { capture },
      filter: ['changeset_deployed'],
    });

    consumerOf(provider).consume([
      envelope('changeset_deployed'),
      envelope('placement_impression'),
    ]);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0]).toBe('changeset_deployed');
  });

  it('swallows a throwing posthog.capture — never crashes the pipeline', () => {
    const posthog: PostHogLike = {
      capture: () => {
        throw new Error('posthog exploded');
      },
    };
    const provider = createPostHogAnalyticsProvider({ posthog });

    expect(() => consumerOf(provider).consume([envelope('web_signed_in')])).not.toThrow();
  });

  it('names the consumer "posthog" by default', () => {
    const provider = createPostHogAnalyticsProvider({ posthog: { capture: vi.fn() } });
    expect(consumerOf(provider).consume).toBeTypeOf('function');
    expect(provider.domain).toBe('events');
  });
});
