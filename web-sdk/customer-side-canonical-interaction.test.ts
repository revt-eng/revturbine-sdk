/**
 * Plan 144 TASK-10 / Q-3 — `placement_interaction` is the ONE canonical
 * placement event, discriminated by `interaction_type`. The standalone
 * `placement_dismissed` / `placement_snoozed` / `placement_converted` events had
 * no consumer anywhere, so `dismiss` / `snooze` / `convert` now route through the
 * canonical event and the standalone names are retired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];

function okResponse(): Response {
  return { ok: true, status: 202, json: async () => ({ accepted: 1 }), text: async () => '' } as unknown as Response;
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_abc',
    apiKey: 'sk',
    publicKey: 'pub',
    environmentId: 'production',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

/** Every `/api/track` row across all POSTed batches. */
function trackedRows(): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.url.endsWith('/api/track'))
    .flatMap((c) => (JSON.parse(String(c.init.body)) as { events: Array<Record<string, unknown>> }).events);
}

/**
 * The semantic payload a row carries. The wire mapping nests an envelope's
 * properties under `properties.payload`, and `emitSemantic` passes its fields
 * to `capture` unwrapped, so the authored fields land at
 * `properties.payload.*` — the same place a customer's own `capture()` fields
 * land, and the canonical carrier this SDK documents.
 */
function semanticBag(row: Record<string, unknown>): Record<string, unknown> {
  const props = JSON.parse(String(row.properties)) as { payload?: Record<string, unknown> };
  return props.payload ?? {};
}

describe('canonical placement_interaction (Q-3)', () => {
  it('dismiss emits placement_interaction with interaction_type "dismiss"', async () => {
    const sdk = makeSdk();
    await sdk.dismiss('out_1');
    await sdk.flushEvents();

    const rows = trackedRows();
    const ev = rows.find((r) => r.event_name === 'placement_interaction');
    expect(ev, 'expected a placement_interaction row').toBeDefined();
    expect(ev!.payload_id).toBe('out_1'); // lifted column
    expect(semanticBag(ev!).interaction_type).toBe('dismiss');
  });

  it('snooze maps to interaction_type "remind_me_later"', async () => {
    const sdk = makeSdk();
    await sdk.snooze('out_2', 1800);
    await sdk.flushEvents();

    const ev = trackedRows().find((r) => r.event_name === 'placement_interaction');
    const bag = semanticBag(ev!);
    expect(bag.interaction_type).toBe('remind_me_later');
    expect(bag.remind_after_seconds).toBe(1800);
  });

  it('convert maps to interaction_type "cta_completed"', async () => {
    const sdk = makeSdk();
    await sdk.convert('out_3');
    await sdk.flushEvents();

    const ev = trackedRows().find((r) => r.event_name === 'placement_interaction');
    expect(semanticBag(ev!).interaction_type).toBe('cta_completed');
  });

  it('never emits the retired placement_dismissed / _snoozed / _converted names', async () => {
    const sdk = makeSdk();
    await sdk.dismiss('out_1');
    await sdk.snooze('out_2');
    await sdk.convert('out_3');
    await sdk.flushEvents();

    const names = trackedRows().map((r) => r.event_name);
    expect(names).not.toContain('placement_dismissed');
    expect(names).not.toContain('placement_snoozed');
    expect(names).not.toContain('placement_converted');
    // All three collapsed onto the one canonical event.
    expect(names.filter((n) => n === 'placement_interaction')).toHaveLength(3);
  });

  // A semantic event's fields must sit exactly one level under `payload`, the
  // same depth a customer's own capture() fields sit at. `emitSemantic` used to
  // add a `{semantic, payload}` wrapper of its own, which the wire mapping then
  // nested again — burying every platform event's fields one level deeper than
  // the canonical carrier. Readers that followed the documented shape found
  // nothing, so gate and placement telemetry was emitted correctly and read as
  // empty. Nothing anywhere consumed the `semantic` marker that cost that level.
  it('nests semantic fields at properties.payload, never payload.payload', async () => {
    const sdk = makeSdk();
    await sdk.dismiss('out_1');
    await sdk.flushEvents();

    const ev = trackedRows().find((r) => r.event_name === 'placement_interaction');
    const props = JSON.parse(String(ev!.properties)) as Record<string, unknown>;
    const bag = props.payload as Record<string, unknown>;

    expect(bag.interaction_type).toBe('dismiss');
    expect(bag.payload, 'semantic fields must not be double-wrapped').toBeUndefined();
    expect(bag.semantic, 'the unread `semantic` marker must not come back').toBeUndefined();
  });

  // BL-0182, the follow-up BL-0062 left behind. #389/#527 stamped
  // `rule_handle` through `placementLifecycleBase`, which reached exposure and
  // outcome. `placement_interaction` does not share that base, so the CLICK
  // between them carried no rule key — and the click is what CTR is computed
  // over. The funnel could be sliced by rule at both ends and not in the middle.
  describe('rule_handle on the interaction (BL-0182)', () => {
    it('stamps the winning rule when the caller supplies one', async () => {
      const sdk = makeSdk();
      await sdk.trackTreatmentInteraction({
        userId: 'user_1',
        placementId: 'usage_70_banner',
        interactionType: 'cta_clicked',
        ruleHandle: 'usage_70pct',
      });
      await sdk.flushEvents();

      const ev = trackedRows().find((r) => r.event_name === 'placement_interaction');
      expect(semanticBag(ev!).rule_handle).toBe('usage_70pct');
    });

    it('omits the key entirely when no decision was in scope', async () => {
      // ABSENT, not null. `null` on the wire means "a rule was selected and
      // none matched"; a bare caller with no decision is a different fact, and
      // conflating them is what would poison the slice's coverage numbers.
      const sdk = makeSdk();
      await sdk.trackTreatmentInteraction({
        userId: 'user_1',
        placementId: 'usage_70_banner',
        interactionType: 'cta_clicked',
      });
      await sdk.flushEvents();

      const ev = trackedRows().find((r) => r.event_name === 'placement_interaction');
      expect('rule_handle' in semanticBag(ev!)).toBe(false);
    });

    it('carries it on the treatment-interaction wire record when known (BL-0200)', async () => {
      // It used to be asserted ABSENT here. `placement_presentations` is
      // column-shaped and a rule key would have needed a datasource migration,
      // so BL-0182 put the rule on the clickstream alone and #530 pinned that
      // omission. `placement_exposure_attribution.rule_handle` exists now (web
      // ledger 015) and the contract declares the field, so the base exposure
      // row records the rule the exposure was DECIDED by instead of waiting for
      // the attribution worker to reconstruct one when a conversion lands.
      const sdk = makeSdk();
      await sdk.trackTreatmentInteraction({
        userId: 'user_1',
        placementId: 'usage_70_banner',
        interactionType: 'cta_clicked',
        ruleHandle: 'usage_70pct',
      });
      await sdk.flushEvents();

      const interactionPosts = calls.filter((c) => c.url.includes('/api/events/interactions'));
      expect(interactionPosts.length).toBeGreaterThan(0);
      for (const call of interactionPosts) {
        const body = JSON.parse(String(call.init.body ?? 'null'));
        const records = Array.isArray(body) ? body : [body];
        for (const record of records) {
          expect(record.rule_handle).toBe('usage_70pct');
        }
      }
    });

    it('omits it from the wire record when no decision was in scope (BL-0200)', async () => {
      // Absent, not null. The contract accepts an explicit `null` for "a rule
      // was selected and none matched"; the SDK cannot tell that apart from
      // "no decision in scope" — `PlacementOutput.rule_id` is simply missing in
      // both — so it asserts neither.
      const sdk = makeSdk();
      await sdk.trackTreatmentInteraction({
        userId: 'user_1',
        placementId: 'usage_70_banner',
        interactionType: 'cta_clicked',
      });
      await sdk.flushEvents();

      const interactionPosts = calls.filter((c) => c.url.includes('/api/events/interactions'));
      expect(interactionPosts.length).toBeGreaterThan(0);
      for (const call of interactionPosts) {
        const body = JSON.parse(String(call.init.body ?? 'null'));
        const records = Array.isArray(body) ? body : [body];
        for (const record of records) {
          expect('rule_handle' in record).toBe(false);
        }
      }
    });
  });
});
