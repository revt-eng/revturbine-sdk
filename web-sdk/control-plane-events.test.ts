/**
 * Plan 112 TASK-2 — control-plane semantic event surface.
 *
 * Covers the pure taxonomy helpers (source classification + event builder) and
 * the SDK's typed `trackControlPlaneEvent` emit path: that it forwards through
 * the same `/api/track` ingest as `capture`, carries the operator/account
 * identity from the active user context (plan 112 REQ-4 / AC-4), and stamps the
 * canonical source classification.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { ControlPlaneEventType } from '@revt-eng/schema';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import {
  CONTROL_PLANE_EVENT_SOURCE,
  CONTROL_PLANE_SOURCE_KEY,
  buildControlPlaneEvent,
} from './control-plane-events';

describe('CONTROL_PLANE_EVENT_SOURCE', () => {
  it('classifies auth + CLI as system and lifecycle/config/entity as workflow', () => {
    for (const t of ['web_signed_in', 'cli_signed_up', 'cli_command_executed'] as const) {
      expect(CONTROL_PLANE_EVENT_SOURCE[t]).toBe('system');
    }
    for (const t of ['changeset_deployed', 'config_imported', 'entity_created'] as const) {
      expect(CONTROL_PLANE_EVENT_SOURCE[t]).toBe('workflow');
    }
  });

  it('classifies every value as exactly system or workflow', () => {
    for (const source of Object.values(CONTROL_PLANE_EVENT_SOURCE)) {
      expect(['system', 'workflow']).toContain(source);
    }
  });
});

describe('buildControlPlaneEvent', () => {
  it('stamps the source classification and merges the payload', () => {
    const built = buildControlPlaneEvent('entity_created', { resource: 'plans', resource_id: 'plan_1' });
    expect(built.eventName).toBe('entity_created');
    expect(built.properties[CONTROL_PLANE_SOURCE_KEY]).toBe('workflow');
    expect(built.properties).toMatchObject({ resource: 'plans', resource_id: 'plan_1' });
  });

  it('defaults to an empty payload', () => {
    const built = buildControlPlaneEvent('web_signed_in');
    expect(built.properties).toEqual({ [CONTROL_PLANE_SOURCE_KEY]: 'system' });
  });
});

// ── SDK emit path (AC-4: carries user context; forwards to /api/track) ───────

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];

function okResponse(): Response {
  return { ok: true, status: 202, json: async () => ({ accepted: 1 }), text: async () => '' } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(okResponse());
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_abc',
    apiKey: 'sk_secret_key',
    ingestPublicKey: 'pub_ingest_key',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

function trackBody(): { events: Array<Record<string, unknown>> } {
  const hit = calls.find((c) => c.url.endsWith('/api/track'));
  expect(hit, 'expected a POST to /api/track').toBeDefined();
  return JSON.parse(String(hit!.init.body));
}

describe('RevTurbineCustomerSdk.trackControlPlaneEvent', () => {
  it('emits the event_type as event_name through /api/track', async () => {
    const sdk = makeSdk();
    await sdk.trackControlPlaneEvent('changeset_deployed', { change_set_id: 'cs_9' }, { immediate: true });

    const ev = trackBody().events.find((e) => e.event_name === 'changeset_deployed');
    expect(ev).toBeDefined();
    // The /api/track envelope nests the emit properties under `payload`.
    const props = JSON.parse(String(ev!.properties)) as { payload: Record<string, unknown> };
    expect(props.payload[CONTROL_PLANE_SOURCE_KEY]).toBe('workflow');
    expect(props.payload.change_set_id).toBe('cs_9');
  });

  it('carries the operator (user_id) and acting tenant (account_id) from the user context (AC-4)', async () => {
    const sdk = makeSdk();
    sdk.setUserContext({ id: 'operator_42', account_id: 'tn_acme' });
    await sdk.trackControlPlaneEvent('web_signed_in', {}, { immediate: true });

    const ev = trackBody().events.find((e) => e.event_name === 'web_signed_in')!;
    expect(ev).toBeDefined();
    expect(ev.user_id).toBe('operator_42');
    expect(ev.account_id).toBe('tn_acme');
  });

  it('does not throw when /api/track fails (fire-and-forget)', async () => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));
    const sdk = makeSdk();
    await expect(
      sdk.trackControlPlaneEvent('config_exported', {}, { immediate: true }),
    ).resolves.toBeUndefined();
  });

  it('only accepts canonical event types at the type level', () => {
    // @ts-expect-error — 'not_a_real_event' is not a ControlPlaneEventType.
    const bad: ControlPlaneEventType = 'not_a_real_event';
    void bad;
  });
});
