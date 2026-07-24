/**
 * Plan 144 TASK-10 — decision + Playbook provenance on the wire.
 *
 * Asserts the lifted `TrackEvent` columns (REQ-8) minted in `sendEvents`:
 *   - `origin` — classified from the event name: a customer `track()` is
 *     `explicit`; the SDK's own placement / gate / slot / engagement lifecycle
 *     and `impression` are `automatic`; the `sdk_validation_warning` diagnostic
 *     is `derived`.
 *   - `decision_id` — lifted from the event's payload (top-level wins, else the
 *     nested `payload` bag), correlating every event caused by one decision.
 *   - `playbook_version` — the version of the exported config that produced the
 *     current experience, resolved once per batch; `null` when no config is
 *     configured.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions, RevTurbineConfig } from './customer-side';

type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[];

function okResponse(): Response {
  return {
    ok: true,
    status: 202,
    json: async () => ({ accepted: 1 }),
    text: async () => '',
  } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(okResponse());
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeConfig(changeSetId: string): RevTurbineConfig {
  return {
    // `version` is the immutable Playbook FORMAT version (validated against the
    // format constant); the config *release* id — what `playbook_version` on the
    // wire should carry — is `change_set_id`.
    version: '1.0.0',
    change_set_id: changeSetId,
    exported_at: '2026-01-01T00:00:00Z',
    plans: [{ id: 'plan_free', unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 }],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

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

/** Every wire `TrackEvent` across all `/api/track` POSTs, flattened. */
function wireEvents(): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.url.endsWith('/api/track'))
    .flatMap((c) => JSON.parse(String(c.init.body)).events as Array<Record<string, unknown>>);
}

/** The single wire row for `name` (fails if absent). */
function wireEvent(name: string): Record<string, unknown> {
  const ev = wireEvents().find((e) => e.event_name === name);
  expect(ev, `expected a wire row for ${name}`).toBeDefined();
  return ev!;
}

describe('plan 144 TASK-10 — provenance columns on the wire', () => {
  describe('origin classification', () => {
    it("classifies a customer track() as 'explicit'", async () => {
      const sdk = makeSdk();
      await sdk.capture('feature_used', {}, { immediate: true });
      expect(wireEvent('feature_used').origin).toBe('explicit');
    });

    it("classifies the placement lifecycle as 'automatic'", async () => {
      const sdk = makeSdk();
      await sdk.capture('placement_exposed', { payload: { placement_id: 'pl_1' } }, { immediate: true });
      expect(wireEvent('placement_exposed').origin).toBe('automatic');
    });

    it("classifies a gate event as 'automatic'", async () => {
      const sdk = makeSdk();
      await sdk.capture('gate_denied', {}, { immediate: true });
      expect(wireEvent('gate_denied').origin).toBe('automatic');
    });

    it("classifies impression as 'automatic'", async () => {
      const sdk = makeSdk();
      await sdk.capture('impression', {}, { immediate: true });
      expect(wireEvent('impression').origin).toBe('automatic');
    });
  });

  describe('decision_id lifting', () => {
    it('lifts decision_id from the nested payload bag alongside placement_id', async () => {
      const sdk = makeSdk();
      await sdk.capture(
        'placement_exposed',
        { payload: { decision_id: 'dec_1', placement_id: 'pl_1' } },
        { immediate: true },
      );
      const ev = wireEvent('placement_exposed');
      expect(ev.decision_id).toBe('dec_1');
      expect(ev.placement_id).toBe('pl_1');
    });

    it('lifts a top-level decision_id', async () => {
      const sdk = makeSdk();
      await sdk.capture('placement_exposed', { decision_id: 'dec_top' }, { immediate: true });
      expect(wireEvent('placement_exposed').decision_id).toBe('dec_top');
    });

    it('leaves decision_id null when the event carries none', async () => {
      const sdk = makeSdk();
      await sdk.capture('feature_used', {}, { immediate: true });
      expect(wireEvent('feature_used').decision_id).toBeNull();
    });
  });

  describe('playbook_version lifting', () => {
    it('stamps the configured exported-config release version on every row', async () => {
      const sdk = makeSdk({ localRuntime: { exportedConfig: makeConfig('pv_7_3_1') } });
      await sdk.capture('feature_used', {}, { immediate: true });
      expect(wireEvent('feature_used').playbook_version).toBe('pv_7_3_1');
    });

    it('leaves playbook_version null when no exported config is configured', async () => {
      const sdk = makeSdk();
      await sdk.capture('feature_used', {}, { immediate: true });
      expect(wireEvent('feature_used').playbook_version).toBeNull();
    });
  });
});
