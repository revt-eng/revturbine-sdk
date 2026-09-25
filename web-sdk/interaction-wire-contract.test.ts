/**
 * Interaction wire-contract parity (plan 232 REQ-2 / AC-2).
 *
 * `flushInteractionQueue` sends a bare object when one interaction is queued
 * and an ARRAY when two or more are. Nothing bound that body to a declared
 * shape, so when the route was written against the single-object schema, every
 * multi-item flush 422'd — and the SDK retried against a route that does not
 * exist, then dropped the batch at page unload. Presentations, clicks and
 * conversions were lost for any customer with an active page.
 *
 * This is the standing net for that drift class: it drives the REAL SDK, takes
 * the body it actually put on the wire, and parses it against the canonical
 * scaffold schema the route now uses. If either side changes shape
 * independently again, this fails instead of production going quiet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TrackEventSchema,
  TreatmentInteractionBatchSchema,
  TreatmentInteractionInputSchema,
  TreatmentInteractionRequestSchema,
} from '@revt-eng/schema/zod';
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
let interactionsRespondOk = true;

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
    const ok = url.includes(INTERACTIONS_PATH) ? interactionsRespondOk : true;
    return new Response(JSON.stringify({ accepted: 1 }), { status: ok ? 202 : 500 });
  }));
}

function sdk(): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
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

/** Let the fire-and-forget flush settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  posts = [];
  interactionsRespondOk = true;
  stubFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the body flushInteractionQueue puts on the wire', () => {
  it('a single queued interaction parses as the bare shape', async () => {
    const client = sdk();
    await client.trackTreatmentInteraction(interaction());
    await settle();

    const sent = interactionPosts();
    expect(sent).toHaveLength(1);
    expect(Array.isArray(sent[0].body)).toBe(false);
    expect(TreatmentInteractionInputSchema.safeParse(sent[0].body).success).toBe(true);
    expect(TreatmentInteractionRequestSchema.safeParse(sent[0].body).success).toBe(true);
  });

  it('a re-queued batch parses as the ARRAY shape', async () => {
    // How production actually reaches the array: a flush fails and re-queues,
    // another interaction arrives, and the next flush carries both. This is
    // the shape that was 422'ing, and the failure that produced it is the same
    // one that then discarded the batch.
    const client = sdk();
    interactionsRespondOk = false;
    await client.trackTreatmentInteraction(interaction());
    await settle();

    interactionsRespondOk = true;
    posts = [];
    await client.trackTreatmentInteraction(interaction({ userId: 'user_2', interactionType: 'cta_clicked' }));
    await settle();

    const sent = interactionPosts();
    expect(sent).toHaveLength(1);
    expect(Array.isArray(sent[0].body), 'the re-queued flush should carry both interactions').toBe(true);
    expect((sent[0].body as unknown[]).length).toBe(2);
    expect(TreatmentInteractionBatchSchema.safeParse(sent[0].body).success).toBe(true);
    expect(TreatmentInteractionRequestSchema.safeParse(sent[0].body).success).toBe(true);
  });

  it('every field the SDK sends is one the contract declares', async () => {
    // A field the schema strips is a field the route never sees — the silent
    // half of drift, where the request succeeds and the data is incomplete.
    const client = sdk();
    await client.trackTreatmentInteraction(interaction({ experimentId: 'exp_1', variantKey: 'B' }));
    await settle();

    const body = interactionPosts()[0].body as Record<string, unknown>;
    const parsed = TreatmentInteractionInputSchema.parse(body) as Record<string, unknown>;
    for (const [key, value] of Object.entries(body)) {
      // `tenant_id` is accepted-and-ignored by the route by design (the tenant
      // comes from the verified credential), so it may be stripped.
      if (key === 'tenant_id' || value === undefined) continue;
      expect(parsed, `the contract drops ${key}, so the route never sees it`).toHaveProperty(key);
    }
  });

  it('carries the experiment attribution the analytics pipes filter on', async () => {
    const client = sdk();
    await client.trackTreatmentInteraction(interaction({ experimentId: 'exp_1', variantKey: 'B' }));
    await settle();
    expect(interactionPosts()[0].body).toMatchObject({ experiment_id: 'exp_1', variant_key: 'B' });
  });
});

/**
 * Account identity on the interaction wire (plan 232 REQ-4 / BL-0011).
 *
 * `placement_presentations.account_id` is a JOIN KEY — `monetization_funnel`
 * matches it against account ids from `events_clickstream` / `events_billing`,
 * and every experiment summary pipe reads it when `analysis_unit='account'`.
 * The SDK never put the field on the wire, so the ingest route's
 * `account_id ?? user_id` fallback stamped a BARE USER id into that column: the
 * funnel joined only by coincidence, and an account-grain experiment readout
 * silently returned the user-grain n while looking valid. Per Kent's D-13 the
 * SDK now sends the same derivation LABELLED — `user-fallback:<user_id>` — so
 * the two cases are distinguishable at read time.
 */
describe('the account identity the analytics joins key on', () => {
  const EMAIL_ACCOUNT = 'billing@acme.example';

  it('sends the identified account, distinct from the user id', async () => {
    const client = sdk();
    client.identify('user_1', { account_id: 'acct_acme' });
    await client.trackTreatmentInteraction(interaction());
    await settle();

    const body = interactionPosts()[0].body as Record<string, unknown>;
    expect(body.account_id).toBe('acct_acme');
    expect(body.account_id).not.toBe(body.user_id);
    // And the contract must actually carry it — a field zod strips is a field
    // the route never sees.
    const parsed = TreatmentInteractionInputSchema.parse(body) as Record<string, unknown>;
    expect(parsed.account_id).toBe('acct_acme');
  });

  it('sends the PREFIXED user fallback when no account was identified — never a bare user_id', async () => {
    // Kent's D-13: keep the user-id fallback, but label it. A bare user id in
    // an account column is indistinguishable from a real account, which is the
    // whole of BL-0117; `user-fallback:<user_id>` is countable, joinable, and
    // obviously fabricated.
    const client = sdk();
    client.identify('user_1');
    await client.trackTreatmentInteraction(interaction());
    await settle();

    const body = interactionPosts()[0].body as Record<string, unknown>;
    expect(body.account_id).toBe(fallbackAccountId('user_1'));
    expect(body.account_id).toBe(`${FALLBACK_ACCOUNT_ID_PREFIX}user_1`);
    expect(isFallbackAccountId(body.account_id as string)).toBe(true);
    // The thing this whole change exists to prevent: a BARE user id.
    expect(body.account_id).not.toBe(body.user_id);
    // And the contract must carry it — a field zod strips is a field the route
    // never sees.
    expect(
      (TreatmentInteractionInputSchema.parse(body) as Record<string, unknown>).account_id,
    ).toBe(fallbackAccountId('user_1'));
  });

  it('classifies an identified account as NOT a fallback', async () => {
    const client = sdk();
    client.identify('user_1', { account_id: 'acct_acme' });
    await client.trackTreatmentInteraction(interaction());
    await settle();

    const body = interactionPosts()[0].body as Record<string, unknown>;
    expect(isFallbackAccountId(body.account_id as string)).toBe(false);
  });

  it('redacts an email-shaped account id the same way /api/track does', async () => {
    // Identity keys are hashed, not sentinelled, and the contract is
    // byte-identical across lanes. Hash on one lane only and
    // `monetization_funnel` joins a hash against a raw email — i.e. nothing.
    const client = sdk();
    client.identify('user_1', { account_id: EMAIL_ACCOUNT });
    await client.trackTreatmentInteraction(interaction());
    await settle();

    const body = interactionPosts()[0].body as Record<string, unknown>;
    expect(body.account_id).not.toBe(EMAIL_ACCOUNT);
    expect(body.account_id).toBe(redactIdentityField(EMAIL_ACCOUNT).value);

    // Same value the clickstream lane puts in `events_clickstream.account_id`.
    await client.flushEvents();
    await settle();
    const tracked = posts.filter((p) => p.url.includes(TRACK_PATH));
    const events = tracked.flatMap((p) => {
      const b = p.body as { events?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
      return Array.isArray(b) ? b : (b.events ?? []);
    });
    const withAccount = events.filter((e) => typeof e.account_id === 'string');
    expect(withAccount.length, 'the clickstream lane should have flushed at least one event').toBeGreaterThan(0);
    for (const event of withAccount) {
      expect(event.account_id, 'the two lanes must be byte-identical or the funnel joins nothing')
        .toBe(body.account_id);
    }
  });

  it('stamps the account that was acting when the interaction happened', async () => {
    // A queued batch can outlive an `identify()` that swapped the acting
    // account. Resolving at flush time would re-attribute the earlier
    // interaction to whichever account happened to be current.
    const client = sdk();
    client.identify('user_1', { account_id: 'acct_first' });
    interactionsRespondOk = false;
    await client.trackTreatmentInteraction(interaction());
    await settle();

    client.identify('user_1', { account_id: 'acct_second' });
    interactionsRespondOk = true;
    posts = [];
    await client.trackTreatmentInteraction(interaction({ interactionType: 'cta_clicked' }));
    await settle();

    const batch = interactionPosts()[0].body as Array<Record<string, unknown>>;
    expect(batch).toHaveLength(2);
    expect(batch[0].account_id).toBe('acct_first');
    expect(batch[1].account_id).toBe('acct_second');
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
  const trackedEvents = (): Array<Record<string, unknown>> =>
    posts
      .filter((p) => p.url.includes(TRACK_PATH))
      .flatMap((p) => {
        const b = p.body as { events?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
        return Array.isArray(b) ? b : (b.events ?? []);
      });

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

describe('a failed flush surfaces instead of retrying a route that does not exist', () => {
  it('never POSTs the legacy fallback path', async () => {
    interactionsRespondOk = false;
    const client = sdk();
    await client.trackTreatmentInteraction(interaction());
    await settle();

    expect(posts.some((p) => p.url.includes(LEGACY_PATH))).toBe(false);
  });

  it('counts the failure, and the batch still recovers on the next flush', async () => {
    interactionsRespondOk = false;
    const client = sdk();
    await client.trackTreatmentInteraction(interaction());
    await settle();

    expect(client.getTelemetryCounters().failed).toBeGreaterThan(0);

    interactionsRespondOk = true;
    posts = [];
    await client.trackTreatmentInteraction(interaction({ userId: 'user_2' }));
    await settle();
    expect(interactionPosts()).toHaveLength(1);
  });

  it('counts a successful flush as sent', async () => {
    const client = sdk();
    await client.trackTreatmentInteraction(interaction());
    await settle();
    expect(client.getTelemetryCounters().sent).toBeGreaterThan(0);
  });
});
