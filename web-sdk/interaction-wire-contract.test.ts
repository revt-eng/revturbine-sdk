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
  TreatmentInteractionBatchSchema,
  TreatmentInteractionInputSchema,
  TreatmentInteractionRequestSchema,
} from '@revt-eng/schema/zod';
import { RevTurbineCustomerSdk } from './customer-side';

interface CapturedPost {
  url: string;
  body: unknown;
}

let posts: CapturedPost[] = [];
let interactionsRespondOk = true;

const INTERACTIONS_PATH = '/api/events/interactions';
const LEGACY_PATH = '/api/placements/interactions';

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
