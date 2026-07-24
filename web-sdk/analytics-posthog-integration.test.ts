/**
 * Plan 144 TASK-17 — `createPostHogIntegration` (REQ-26, REQ-27, AC-17, AC-20).
 * A superset of the capture-only provider: same filter/transform semantics, plus
 * an opt-in identity/group/reset/navigation lifecycle (all flags default false).
 * The PostHog client is injected — no PostHog package is imported (AC-20).
 */
import { describe, expect, it, vi } from 'vitest';
import { createPostHogIntegration, type PostHogLike } from './analytics';
import type { RevTurbineEventEnvelope, EventConsumer } from '@revt-eng/core';

function mockPostHog() {
  return { capture: vi.fn(), identify: vi.fn(), group: vi.fn(), reset: vi.fn() } satisfies PostHogLike;
}

function env(over: Partial<RevTurbineEventEnvelope> = {}): RevTurbineEventEnvelope {
  const identity = { tenant_id: 't', user_id: null, anonymous_id: 'anon', traits: {}, ...over.identity };
  return {
    tenant_id: 't',
    type: 'feature_used',
    level: 'INFO',
    message: '',
    url: 'https://app.example.com/pricing',
    path: '/pricing',
    page_title: '',
    event_time: '2026-01-01T00:00:00.000Z',
    anonymous_id: 'anon',
    user_id: null,
    session_id: 's',
    tags: [],
    properties: {},
    ...over,
    identity,
  };
}

async function consumerFor(options: Parameters<typeof createPostHogIntegration>[0]): Promise<EventConsumer> {
  const state = await createPostHogIntegration(options).resolve();
  return state.consumers[0];
}

describe('createPostHogIntegration', () => {
  it('captures every event and, by default, touches NO lifecycle method', async () => {
    const posthog = mockPostHog();
    const consumer = await consumerFor({ posthog });
    consumer.consume([env({ type: 'feature_used', user_id: 'u1' })]);

    expect(posthog.capture).toHaveBeenCalledWith('feature_used', expect.any(Object));
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.group).not.toHaveBeenCalled();
    expect(posthog.reset).not.toHaveBeenCalled();
  });

  it('syncIdentity mirrors identify on a new user and reset on logout', async () => {
    const posthog = mockPostHog();
    const consumer = await consumerFor({ posthog, syncIdentity: true });

    consumer.consume([env({ user_id: 'u_hashed', identity: { tenant_id: 't', user_id: 'u_hashed', anonymous_id: 'anon', traits: { plan: 'pro' } } })]);
    expect(posthog.identify).toHaveBeenCalledWith('u_hashed', { plan: 'pro' });

    consumer.consume([env({ user_id: 'u_hashed' })]); // same user → no repeat
    expect(posthog.identify).toHaveBeenCalledTimes(1);

    consumer.consume([env({ user_id: null })]); // logout → reset
    expect(posthog.reset).toHaveBeenCalledTimes(1);
  });

  it('syncAccountGroup mirrors the account_id trait to a PostHog group', async () => {
    const posthog = mockPostHog();
    const consumer = await consumerFor({ posthog, syncAccountGroup: true });
    consumer.consume([env({ identity: { tenant_id: 't', user_id: 'u', anonymous_id: 'anon', traits: { account_id: 'acct_9' } } })]);
    expect(posthog.group).toHaveBeenCalledWith('account', 'acct_9');
  });

  it('mirrorNavigation emits a native $pageview for page_view events', async () => {
    const posthog = mockPostHog();
    const consumer = await consumerFor({ posthog, mirrorNavigation: true });
    consumer.consume([env({ type: 'page_view', url: 'https://app.example.com/x' })]);
    expect(posthog.capture).toHaveBeenCalledWith('$pageview', { $current_url: 'https://app.example.com/x' });
  });

  it('preserves filter and transform semantics (REQ-27)', async () => {
    const posthog = mockPostHog();
    const filtered = await consumerFor({ posthog, filter: ['feature_used'] });
    filtered.consume([env({ type: 'other_event' })]);
    expect(posthog.capture).not.toHaveBeenCalled();

    posthog.capture.mockClear();
    const transformed = await consumerFor({
      posthog,
      transform: (name, props) => ({ eventName: `rt_${name}`, properties: props }),
    });
    transformed.consume([env({ type: 'feature_used' })]);
    expect(posthog.capture).toHaveBeenCalledWith('rt_feature_used', expect.any(Object));
  });

  it('never lets a throwing PostHog call block the pipeline (AC-17)', async () => {
    const posthog: PostHogLike = {
      capture: () => {
        throw new Error('posthog down');
      },
      identify: () => {
        throw new Error('posthog down');
      },
    };
    const consumer = await consumerFor({ posthog, syncIdentity: true });
    expect(() => consumer.consume([env({ user_id: 'u1' })])).not.toThrow();
  });

  it('works with a minimal client that has no lifecycle methods (injected, not bundled)', async () => {
    const posthog: PostHogLike = { capture: vi.fn() };
    const consumer = await consumerFor({ posthog, syncIdentity: true, syncAccountGroup: true });
    // No identify/group/reset on the client → guarded calls are no-ops, capture still runs.
    expect(() =>
      consumer.consume([env({ user_id: 'u1', identity: { tenant_id: 't', user_id: 'u1', anonymous_id: 'a', traits: { account_id: 'x' } } })]),
    ).not.toThrow();
    expect(posthog.capture).toHaveBeenCalled();
  });
});
