/**
 * Interaction wire-contract parity (plan 232 REQ-2 / AC-2; EP-1692).
 *
 * Before 0.15.0 the SDK reported each interaction twice: a typed row POSTed to
 * a separate interactions route, and a `placement_interaction` clickstream
 * event. Nothing bound the POST body to a declared shape, so when the route
 * was written against the single-object schema every multi-item flush 422'd
 * and presentations, clicks and conversions were lost.
 *
 * The POST lane is gone: the interaction is ONE `placement_interaction` event
 * in the `/api/track` batch, carrying the full record. This is the standing net
 * for that drift class: it drives the REAL SDK, takes the event it actually put
 * on the wire, and parses it against the canonical scaffold schemas
 * (`TrackEvent` for the wire row, the `placement_interaction` payload contract
 * for the record). If either side changes shape independently again, this
 * fails instead of production going quiet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateEventPayload } from '@revt-eng/schema';
import { TrackEventSchema } from '@revt-eng/schema/zod';
import { RevTurbineCustomerSdk } from './customer-side';
import {
  FALLBACK_ACCOUNT_ID_PREFIX,
  fallbackAccountId,
  isFallbackAccountId,
} from './account-identity';
import { redactIdentityField } from './pii-redact';

interface CapturedPost {
  url: string;
  body: unknown;
}

let posts: CapturedPost[] = [];
let trackRespondOk = true;

const INTERACTIONS_PATH = '/api/events/interactions';
const LEGACY_PATH = '/api/placements/interactions';
const TRACK_PATH = '/api/track';

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = null;
    try {
      body = JSON.parse(String(init?.body ?? 'null'));
    } catch {
      body = String(init?.body ?? '');
    }
    posts.push({ url, body });
    const ok = url.includes(TRACK_PATH) ? trackRespondOk : true;
    return new Response(JSON.stringify({ accepted: 1 }), { status: ok ? 202 : 400 });
  }));
}

function sdk(): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    user: { id: 'u_test' },
    tenantId: 'tenant_abc',
    apiKey: 'sk_secret_key',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
  });
}

const interaction = (over: Record<string, unknown> = {}) => ({
  userId: 'user_1',
  placementId: 'pl_upgrade',
  interactionType: 'impression' as const,
  surfaceSlotId: 'dashboard_promo',
  surfaceTemplateId: 'banner_v1',
  payloadId: 'payload_9',
  ...over,
});

const interactionPosts = () => posts.filter((p) => p.url.includes(INTERACTIONS_PATH));

/** Every row across all POSTed `/api/track` batches. */
const trackedEvents = (): Array<Record<string, unknown>> =>
  posts
    .filter((p) => p.url.includes(TRACK_PATH))
    .flatMap((p) => {
      const b = p.body as { events?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
      return Array.isArray(b) ? b : (b.events ?? []);
    });

/** The `placement_interaction` wire rows, each with its payload (the record). */
const interactionEvents = (): Array<{ wire: Record<string, unknown>; payload: Record<string, unknown> }> =>
  trackedEvents()
    .filter((e) => e.event_name === 'placement_interaction')
    .map((wire) => ({
      wire,
      payload: (JSON.parse(String(wire.properties)) as { payload: Record<string, unknown> }).payload,
    }));

/** Flush the clickstream batch, then return the single interaction event. */
async function sentInteraction(client: RevTurbineCustomerSdk) {
  await client.flushEvents();
  const events = interactionEvents();
  expect(events, 'exactly one placement_interaction event per interaction').toHaveLength(1);
  return events[0];
}

/** Let any fire-and-forget work settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  posts = [];
  trackRespondOk = true;
  stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the placement_interaction event the SDK puts on the /api/track wire', () => {
  it('a single interaction is one event whose row and record the contracts accept', async () => {
    const client = sdk();
    await client.trackTreatmentInteraction(interaction());

    const { wire, payload } = await sentInteraction(client);
    expect(TrackEventSchema.safeParse(wire).success).toBe(true);
    const verdict = validateEventPayload('placement_interaction', payload);
    expect(verdict.ok, verdict.ok ? '' : String(verdict.detail)).toBe(true);
    expect(interactionPosts(), 'no second lane').toHaveLength(0);
  });

  it('two interactions are two events in ONE batch, each accepted by the contract', async () => {
    // The old POST lane sent a bare object for one interaction and an ARRAY for
    // two; the array shape is what 422'd. Both are now plain rows of the same
    // `/api/track` body.
    const client = sdk();
    await client.trackTreatmentInteraction(interaction());
    await client.trackTreatmentInteraction(interaction({ userId: 'user_2', interactionType: 'cta_clicked' }));
    await client.flushEvents();

    const events = interactionEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.payload.interaction_type)).toEqual(['impression', 'cta_clicked']);
    for (const { wire, payload } of events) {
      expect(TrackEventSchema.safeParse(wire).success).toBe(true);
      expect(validateEventPayload('placement_interaction', payload).ok).toBe(true);
    }
  });

  it('every field the SDK sends is one the contract keeps', async () => {
    // A field the schema strips is a field ingest never sees — the silent half
    // of drift, where the request succeeds and the data is incomplete.
    const client = sdk();
    await client.trackTreatmentInteraction(interaction({
      experimentId: 'exp_1',
      variantKey: 'B',
      ruleHandle: 'rule_1',
      decisionId: 'dec_1',
      segmentHandles: ['seg_a'],
      messageBlockHandle: 'block_1',
    }));

    const { payload } = await sentInteraction(client);
    const verdict = validateEventPayload('placement_interaction', payload);
    expect(verdict.ok).toBe(true);
    const parsed = verdict.ok ? verdict.payload : {};
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined) continue;
      expect(parsed, `the contract drops ${key}, so ingest never sees it`).toHaveProperty(key);
    }
  });

  it('carries the full record the presentation row needs', async () => {
    const client = sdk();
    client.identify('user_1', { account_id: 'acct_acme' });
    await client.trackTreatmentInteraction(interaction({
      treatmentId: 'treat_1',
      experimentId: 'exp_1',
      variantKey: 'B',
      ruleHandle: 'rule_1',
      decisionId: 'dec_1',
      segmentHandles: ['seg_a'],
      messageBlockHandle: 'block_1',
      metadata: { cooldown_ms: 5 },
      interactionAt: '2026-11-10T10:00:00.000Z',
    }));

    const { payload, wire } = await sentInteraction(client);
    expect(payload).toEqual({
      user_id: 'user_1',
      account_id: 'acct_acme',
      placement_id: 'pl_upgrade',
      treatment_id: 'treat_1',
      interaction_type: 'impression',
      interaction_at: '2026-11-10T10:00:00.000Z',
      surface_slot_id: 'dashboard_promo',
      surface_template_id: 'banner_v1',
      payload_id: 'payload_9',
      message_block_handle: 'block_1',
      experiment_id: 'exp_1',
      variant_key: 'B',
      rule_handle: 'rule_1',
      decision_id: 'dec_1',
      segment_handles: ['seg_a'],
      metadata: { cooldown_ms: 5 },
    });
    // These lift to the named wire columns analytics groups by.
    expect(wire).toMatchObject({
      account_id: 'acct_acme',
      placement_id: 'pl_upgrade',
      surface_slot_id: 'dashboard_promo',
      payload_id: 'payload_9',
      experiment_id: 'exp_1',
      variant_key: 'B',
      decision_id: 'dec_1',
    });
  });

  it('carries the experiment attribution the analytics pipes filter on', async () => {
    const client = sdk();
    await client.trackTreatmentInteraction(interaction({ experimentId: 'exp_1', variantKey: 'B' }));
    const { payload, wire } = await sentInteraction(client);
    expect(payload).toMatchObject({ experiment_id: 'exp_1', variant_key: 'B' });
    expect(wire).toMatchObject({ experiment_id: 'exp_1', variant_key: 'B' });
  });
});

/**
 * Account identity on the interaction event (plan 232 REQ-4 / BL-0011).
 *
 * `placement_presentations.account_id` is a JOIN KEY — `monetization_funnel`
 * matches it against account ids from `events_clickstream` / `events_billing`,
 * and every experiment summary pipe reads it when `analysis_unit='account'`.
 * A bare USER id in that column made the funnel join only by coincidence, and
 * an account-grain experiment readout silently returned the user-grain n while
 * looking valid. Per Kent's D-13 the SDK sends the same derivation LABELLED —
 * `user-fallback:<user_id>` — so the two cases are distinguishable at read
 * time. The event carries the account in its payload AND in the wire
 * `account_id` column.
 */
describe('the account identity the analytics joins key on', () => {
  const EMAIL_ACCOUNT = 'billing@acme.example';

  it('sends the identified account, distinct from the user id', async () => {
    const client = sdk();
    client.identify('user_1', { account_id: 'acct_acme' });
    await client.trackTreatmentInteraction(interaction());

    const { payload, wire } = await sentInteraction(client);
    expect(payload.account_id).toBe('acct_acme');
    expect(payload.account_id).not.toBe(payload.user_id);
    // And the contract must actually carry it — a field zod strips is a field
    // ingest never sees.
    const verdict = validateEventPayload('placement_interaction', payload);
    expect(verdict.ok && verdict.payload.account_id).toBe('acct_acme');
    expect(wire.account_id).toBe('acct_acme');
  });

  it('sends the PREFIXED user fallback when no account was identified — never a bare user_id', async () => {
    // Kent's D-13: keep the user-id fallback, but label it. A bare user id in
    // an account column is indistinguishable from a real account, which is the
    // whole of BL-0117; `user-fallback:<user_id>` is countable, joinable, and
    // obviously fabricated.
    const client = sdk();
    client.identify('user_1');
    await client.trackTreatmentInteraction(interaction());

    const { payload, wire } = await sentInteraction(client);
    expect(payload.account_id).toBe(fallbackAccountId('user_1'));
    expect(payload.account_id).toBe(`${FALLBACK_ACCOUNT_ID_PREFIX}user_1`);
    expect(isFallbackAccountId(payload.account_id as string)).toBe(true);
    // The thing this whole change exists to prevent: a BARE user id.
    expect(payload.account_id).not.toBe(payload.user_id);
    // And the contract must carry it — a field zod strips is a field ingest
    // never sees.
    const verdict = validateEventPayload('placement_interaction', payload);
    expect(verdict.ok && verdict.payload.account_id).toBe(fallbackAccountId('user_1'));
    expect(wire.account_id).toBe(fallbackAccountId('user_1'));
  });

  it('classifies an identified account as NOT a fallback', async () => {
    const client = sdk();
    client.identify('user_1', { account_id: 'acct_acme' });
    await client.trackTreatmentInteraction(interaction());

    const { payload } = await sentInteraction(client);
    expect(isFallbackAccountId(payload.account_id as string)).toBe(false);
  });

  it('redacts an email-shaped account id the same way every other clickstream row does', async () => {
    // Identity keys are hashed, not sentinelled, and the contract is
    // byte-identical across rows. Hash on one only and `monetization_funnel`
    // joins a hash against a raw email — i.e. nothing.
    const client = sdk();
    client.identify('user_1', { account_id: EMAIL_ACCOUNT });
    await client.trackTreatmentInteraction(interaction());

    const { payload, wire } = await sentInteraction(client);
    expect(payload.account_id).not.toBe(EMAIL_ACCOUNT);
    expect(payload.account_id).toBe(redactIdentityField(EMAIL_ACCOUNT).value);
    expect(wire.account_id).toBe(payload.account_id);

    // Same value every other clickstream row puts in `events_clickstream.account_id`.
    const withAccount = trackedEvents().filter((e) => typeof e.account_id === 'string');
    expect(withAccount.length, 'the clickstream should have flushed at least one event').toBeGreaterThan(0);
    for (const event of withAccount) {
      expect(event.account_id, 'the rows must be byte-identical or the funnel joins nothing')
        .toBe(payload.account_id);
    }
  });

  it('stamps the account that was acting when the interaction happened', async () => {
    // A queued event can outlive an `identify()` that swapped the acting
    // account. Resolving at send time would re-attribute the earlier
    // interaction to whichever account happened to be current — in the payload
    // AND in the wire `account_id` column.
    const client = sdk();
    client.identify('user_1', { account_id: 'acct_first' });
    await client.trackTreatmentInteraction(interaction());

    client.identify('user_1', { account_id: 'acct_second' });
    await client.trackTreatmentInteraction(interaction({ interactionType: 'cta_clicked' }));
    await client.flushEvents();

    const events = interactionEvents();
    expect(events).toHaveLength(2);
    expect(events[0].payload.account_id).toBe('acct_first');
    expect(events[1].payload.account_id).toBe('acct_second');
    expect(events[0].wire.account_id).toBe('acct_first');
    expect(events[1].wire.account_id).toBe('acct_second');
  });
});

/**
 * Account identity on the CLICKSTREAM wire (BL-0117; scaffold #375).
 *
 * `TrackEvent.account_id` used to be required, and the SDK satisfied it with
 * `userContext.account_id || userId`. Every app that identified no account
 * therefore sent its USER id as the account id, and `monetization_funnel`
 * built its account map out of those rows — a user-grain n dressed up as an
 * account-grain one. Scaffold #375 made the field optional, so absence is valid
 * on the wire — but Kent ruled (D-13, 2026-09-25) that the browser SDK KEEPS the
 * user-id fallback and PREFIXES it: `user-fallback:<user_id>`. The row stays
 * countable and joinable, and a fabricated key is unmistakably fabricated, so
 * the warehouse can keep it out of account denominators.
 *
 * These drive the real SDK and read the body it actually put on the wire,
 * parsed against the canonical scaffold schema, so the two sides cannot drift
 * apart again silently.
 */
describe('the account identity on the /api/track wire', () => {
  it('sends the PREFIXED user fallback for an identified user with no account', async () => {
    const client = sdk();
    client.identify('user_1');
    await client.capture('feature_used', {}, { immediate: true });
    await settle();

    const events = trackedEvents();
    expect(events.length, 'expected at least one clickstream event on the wire').toBeGreaterThan(0);
    for (const event of events) {
      // The fabricated key is labelled: `user-fallback:<user_id>`, never the
      // bare user id, never '' and never null.
      expect(event.account_id).toBe(fallbackAccountId('user_1'));
      expect(isFallbackAccountId(event.account_id as string)).toBe(true);
      expect(event.account_id).not.toBe(event.user_id);
      // And the canonical contract must accept it — a prefixed id is just an
      // id, so the route does not 422 on an un-accounted app.
      expect(TrackEventSchema.safeParse(event).success).toBe(true);
      expect((TrackEventSchema.parse(event) as Record<string, unknown>).account_id)
        .toBe(fallbackAccountId('user_1'));
    }
  });

  it('survives /api/track serialization — the prefix reaches the wire bytes intact', async () => {
    // The guards in monetization_funnel / cohort_rollup match the literal
    // prefix in the SERIALIZED body, so a JSON round-trip that mangled the
    // colon or re-encoded the marker would silently stop excluding fabricated
    // keys from account denominators.
    const client = sdk();
    client.identify('user_1');
    await client.capture('feature_used', {}, { immediate: true });
    await settle();

    const raw = posts.filter((p) => p.url.includes(TRACK_PATH)).map((p) => JSON.stringify(p.body));
    expect(raw.length).toBeGreaterThan(0);
    for (const bytes of raw) {
      expect(bytes).toContain('"account_id":"user-fallback:user_1"');
    }
  });

  it('derives the fallback from the anonymous id when no user was identified', async () => {
    // There is always an identity to derive from: an un-identified visitor
    // still has the anonymous id the same row carries in `user_id`, so the
    // fallback stays joinable rather than becoming absence.
    const client = sdk();
    await client.capture('feature_used', {}, { immediate: true });
    await settle();

    const events = trackedEvents();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(isFallbackAccountId(event.account_id as string)).toBe(true);
      expect(event.account_id).toBe(fallbackAccountId(event.user_id as string));
      expect(TrackEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('sends the identified account byte-identically to the identity supplied', async () => {
    const client = sdk();
    client.identify('user_1', { account_id: 'acct_acme' });
    await client.capture('feature_used', {}, { immediate: true });
    await settle();

    const events = trackedEvents();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.account_id).toBe('acct_acme');
      expect(event.account_id).not.toBe(event.user_id);
      expect(TrackEventSchema.safeParse(event).success).toBe(true);
      // A field zod strips is a field the route never sees.
      expect((TrackEventSchema.parse(event) as Record<string, unknown>).account_id).toBe('acct_acme');
    }
  });

  it('treats a blank account id as no account at all', async () => {
    // `''` is not a valid account id on the wire (the schema still rejects an
    // empty string) and it is not an account either — so it falls through to
    // the labelled fallback rather than being sent as a blank account.
    const client = sdk();
    client.identify('user_1', { account_id: '   ' });
    await client.capture('feature_used', {}, { immediate: true });
    await settle();

    for (const event of trackedEvents()) {
      expect(event.account_id).toBe(fallbackAccountId('user_1'));
      expect(isFallbackAccountId(event.account_id as string)).toBe(true);
      expect(TrackEventSchema.safeParse(event).success).toBe(true);
    }
  });
});

describe('there is one lane, and a failed send surfaces instead of retrying a route that does not exist', () => {
  it('never POSTs either retired interaction path', async () => {
    const client = sdk();
    await client.trackTreatmentInteraction(interaction());
    await client.trackTreatmentInteraction(interaction({ interactionType: 'dismiss' }));
    await client.flushEvents();
    await settle();

    expect(posts.some((p) => p.url.includes(LEGACY_PATH))).toBe(false);
    expect(interactionPosts()).toHaveLength(0);
  });

  it('counts a refused /api/track batch as failed and throws nothing into the app', async () => {
    trackRespondOk = false;
    const client = sdk();
    await client.trackTreatmentInteraction(interaction());
    await client.flushEvents();

    expect(client.getTelemetryCounters().failed).toBeGreaterThan(0);
    expect(interactionPosts()).toHaveLength(0);
  });

  it('counts a successful flush as sent', async () => {
    const client = sdk();
    await client.trackTreatmentInteraction(interaction());
    await client.flushEvents();
    expect(client.getTelemetryCounters().sent).toBeGreaterThan(0);
  });
});
