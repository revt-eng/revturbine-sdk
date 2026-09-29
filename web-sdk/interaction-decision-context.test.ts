/**
 * Plan 282 TASK-9 — `decision_id`, `segment_handles` and `segment_ids` on the
 * interaction wire.
 *
 * TASK-8 declared `decision_id` on `TreatmentInteractionInputSchema` so a
 * presentation row joins the clickstream and the Checkout metadata bag on one
 * id. Kent's segment ruling (2026-09-29) splits segments into TWO optional
 * fields: `segment_handles`, the effective HANDLE set scaffold's
 * `evaluateSegments` built plus any hosted-resolved slugs — the analytics join
 * key; and `segment_ids`, the minted ids a hosted context supplied — telemetry
 * only, omitted entirely in local mode. This pins the SDK half: given, they
 * reach the wire; not given and no decision in scope, the row is byte-for-byte
 * what a pre-282 caller sent; for an output this SDK decided, the index fills
 * them from the decision itself and never mixes the two.
 *
 * `segment_handles` joins the wire contract with scaffold BL-0461; until that
 * publish is pinned here, the one contract-side assertion on it is red.
 *
 * Plan: docs/dev-lifecycle/inprogress/282-control-center-real-data-attribution-proof.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacementOutput } from '@revt-eng/core';
import { RevTurbineConfigSchema } from '@revt-eng/schema';
import { TreatmentInteractionInputSchema } from '@revt-eng/schema/zod';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import { PlacementController } from './controllers';

interface CapturedPost {
  url: string;
  body: Record<string, unknown>;
}

const INTERACTIONS_PATH = '/api/events/interactions';
const SLOT = 'slot_upgrade';
const OUTPUT_ID = 'payload_upgrade';
const USER = 'user_1';
/** Handles a hosted context resolved (its `segmentSlugs`). */
const HOSTED_HANDLES = ['power_users', 'beta_cohort'];
/** The minted id a hosted context supplied (its `segmentIds`) — telemetry, never a join key. */
const MINTED_ID = '01HZX9MINTEDSEGMENT';

let posts: CapturedPost[] = [];

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    let body: unknown = null;
    try {
      body = JSON.parse(String(init?.body ?? 'null'));
    } catch {
      body = null;
    }
    posts.push({ url: String(input), body: (body ?? {}) as Record<string, unknown> });
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  }));
}

/** The one interaction body a single-item flush puts on the wire. */
const sentInteraction = (): Record<string, unknown> => {
  const sent = posts.filter((p) => p.url.includes(INTERACTIONS_PATH));
  expect(sent).toHaveLength(1);
  return sent[0].body;
};

/** Let the fire-and-forget flush settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const BASE_OPTIONS = {
  tenantId: 'tenant_282',
  apiKey: 'sk_test',
  publicKey: 'pub_test',
  environmentId: 'staging',
  endpoint: 'https://edge.example.com',
  mode: 'snippet',
  contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
} satisfies Partial<RevTurbineInitOptions>;

/** A headless SDK with no decision in scope — the pre-282 caller's shape. */
function headlessSdk(): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({ ...BASE_OPTIONS, user: { id: USER } });
}

function upgradeOutput(): PlacementOutput {
  return {
    output_id: OUTPUT_ID,
    rule_id: 'rule_upgrade',
    decision_id: 'dec_upgrade',
    config_version: 'v1',
    category: 'upsell',
    surface: { type: 'banner', template: 'banner_placement', slot_id: SLOT },
    content: { header: 'Upgrade to Pro', cta_label: 'See plans' },
    cta_path: { type: 'navigate_to_plans', plan_handle: 'pro' },
    present_upsell: true,
  };
}

/** The local resolver every deciding fixture uses: `upgradeOutput()` for `SLOT`. */
function resolvers(output: PlacementOutput): NonNullable<RevTurbineInitOptions['localRuntime']>['resolvers'] {
  return {
    getPlacementDecision: async (input: { placementId: string }) => ({
      placementId: input.placementId,
      requestId: 'rid_282',
      visible: true,
      decisionSource: 'local' as const,
      reasonCodes: [],
      content: output.content,
      output,
    }),
  };
}

function seedSlot(sdk: RevTurbineCustomerSdk): RevTurbineCustomerSdk {
  // Seed the registry with the literal slot id so `getPlacementDecision`
  // addresses it, as `convert-reloads-user-context.test.ts` does.
  (sdk as unknown as { placements: Map<string, unknown> }).placements
    .set(SLOT, { id: SLOT, name: SLOT, route: '/' });
  return sdk;
}

/**
 * A hosted-resolved fixture: a segments provider supplies minted ids AND their
 * slugs, the way a hosted context does. Not `local_only` — that mode never
 * flushes the interaction lane, and the wire body is what these tests assert.
 */
function hostedSdk(): RevTurbineCustomerSdk {
  return seedSlot(new RevTurbineCustomerSdk({
    ...BASE_OPTIONS,
    user: { id: USER, plan_handle: 'free' },
    domainProviders: [{
      domain: 'segments',
      resolve: () => ({ segmentIds: [MINTED_ID], segmentSlugs: HOSTED_HANDLES }),
    }],
    localRuntime: { resolvers: resolvers(upgradeOutput()) },
  }));
}

/** The SDK's own effective handle set at the last resolution — the oracle the row must equal. */
function effectiveHandles(sdk: RevTurbineCustomerSdk): readonly string[] {
  return (sdk as unknown as { lastEffectiveSegmentHandles: readonly string[] }).lastEffectiveSegmentHandles;
}

const interaction = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  placementId: SLOT,
  interactionType: 'cta_clicked' as const,
  surfaceSlotId: SLOT,
  surfaceTemplateId: 'banner_placement',
  ...over,
});

beforeEach(() => {
  posts = [];
  stubFetch();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('given explicitly, the decision context reaches the wire', () => {
  it('sends decision_id, segment_handles and segment_ids, and the body still parses against the scaffold contract', async () => {
    await headlessSdk().trackTreatmentInteraction(interaction({
      decisionId: 'dec_1',
      segmentHandles: ['seg_a', 'seg_b'],
      segmentIds: [MINTED_ID],
    }));
    await settle();

    const body = sentInteraction();
    expect(body.decision_id).toBe('dec_1');
    expect(body.segment_handles).toEqual(['seg_a', 'seg_b']);
    expect(body.segment_ids).toEqual([MINTED_ID]);
    const parsed = TreatmentInteractionInputSchema.safeParse(body);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    // Neither declared key is stripped — the route sees what the SDK sent.
    expect(parsed.success && parsed.data).toMatchObject({ decision_id: 'dec_1', segment_ids: [MINTED_ID] });
  });

  it('the contract declares segment_handles, so the route sees the join key (scaffold BL-0461)', async () => {
    await headlessSdk().trackTreatmentInteraction(interaction({ segmentHandles: ['seg_a'] }));
    await settle();

    const parsed = TreatmentInteractionInputSchema.safeParse(sentInteraction());
    expect(parsed.success && parsed.data).toMatchObject({ segment_handles: ['seg_a'] });
  });

  it('sends segment_handles: [] as the real observation it is', async () => {
    await headlessSdk().trackTreatmentInteraction(interaction({ decisionId: 'dec_1', segmentHandles: [] }));
    await settle();

    const body = sentInteraction();
    expect(body.segment_handles).toEqual([]);
    expect(body).not.toHaveProperty('segment_ids');
    expect(TreatmentInteractionInputSchema.safeParse(body).success).toBe(true);
  });

  it('honours the plan-144 metadata.decision_id convention, and lets the explicit field win', async () => {
    const sdk = headlessSdk();
    await sdk.trackTreatmentInteraction(interaction({ metadata: { decision_id: 'dec_meta' } }));
    await settle();
    expect(sentInteraction().decision_id).toBe('dec_meta');

    posts = [];
    await sdk.trackTreatmentInteraction(interaction({ decisionId: 'dec_explicit', metadata: { decision_id: 'dec_meta' } }));
    await settle();
    expect(sentInteraction().decision_id).toBe('dec_explicit');
  });

  it('carries the explicit decision_id on the clickstream placement_interaction too', async () => {
    const sdk = headlessSdk();
    const spy = vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
    await sdk.trackTreatmentInteraction(interaction({ decisionId: 'dec_1' }));

    const [, payload] = spy.mock.calls.find(([name]) => name === 'placement_interaction') ?? [];
    expect(payload).toMatchObject({ decision_id: 'dec_1' });
  });
});

describe('not given, with no decision in scope, the row is the pre-282 row', () => {
  it('sends none of the three keys — absent, never null or empty', async () => {
    await headlessSdk().trackTreatmentInteraction(interaction());
    await settle();

    const body = sentInteraction();
    expect(body).not.toHaveProperty('decision_id');
    expect(body).not.toHaveProperty('segment_handles');
    expect(body).not.toHaveProperty('segment_ids');
    expect(TreatmentInteractionInputSchema.safeParse(body).success).toBe(true);
  });

  it('sends none for a payloadId this SDK never decided', async () => {
    await headlessSdk().trackTreatmentInteraction(interaction({ payloadId: 'out_unknown' }));
    await settle();

    const body = sentInteraction();
    expect(body).not.toHaveProperty('decision_id');
    expect(body).not.toHaveProperty('segment_handles');
    expect(body).not.toHaveProperty('segment_ids');
  });
});

describe('for an output this SDK decided, the index fills what the caller did not give', () => {
  it('a headless click naming the output carries the decision, the handle set, and — apart from it — the hosted minted ids', async () => {
    const sdk = hostedSdk();
    const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    posts = [];

    await sdk.trackTreatmentInteraction(interaction({ payloadId: String(decision.output?.output_id) }));
    await settle();

    const body = sentInteraction();
    expect(body.decision_id).toBe('dec_upgrade');
    expect(body.segment_handles).toEqual(HOSTED_HANDLES);
    expect(body.segment_ids).toEqual([MINTED_ID]);
    expect(body.segment_handles).not.toContain(MINTED_ID);
    for (const handle of HOSTED_HANDLES) expect(body.segment_ids).not.toContain(handle);
    expect(TreatmentInteractionInputSchema.safeParse(body).success).toBe(true);
  });

  it('the React controller’s click carries them the same way', async () => {
    const sdk = hostedSdk();
    const controller = new PlacementController(sdk, { surfaceSlot: { id: SLOT, name: SLOT }, userId: USER });
    (controller as unknown as { _placementId: string })._placementId = SLOT;
    await controller.load();
    posts = [];

    await controller.ctaClick('navigate_to_plans');
    await settle();

    const body = sentInteraction();
    expect(body.decision_id).toBe('dec_upgrade');
    expect(body.segment_handles).toEqual(HOSTED_HANDLES);
    expect(body.segment_ids).toEqual([MINTED_ID]);
    expect(body.payload_id).toBe(OUTPUT_ID);
    controller.dispose();
  });

  it('an output-addressed convert() carries them too', async () => {
    const sdk = hostedSdk();
    const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    posts = [];

    await sdk.convert(String(decision.output?.output_id));
    await settle();

    const body = sentInteraction();
    expect(body.interaction_type).toBe('cta_completed');
    expect(body.decision_id).toBe('dec_upgrade');
    expect(body.segment_handles).toEqual(HOSTED_HANDLES);
    expect(body.segment_ids).toEqual([MINTED_ID]);
  });

  it('an explicit value still wins over the index', async () => {
    const sdk = hostedSdk();
    const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    posts = [];

    await sdk.trackTreatmentInteraction(interaction({
      payloadId: String(decision.output?.output_id),
      segmentHandles: ['seg_override'],
      segmentIds: ['01HOVERRIDE'],
    }));
    await settle();

    const body = sentInteraction();
    expect(body.segment_handles).toEqual(['seg_override']);
    expect(body.segment_ids).toEqual(['01HOVERRIDE']);
  });
});

/**
 * Segments are HANDLES (Kent's TASK-9 ruling). The row's `segment_handles` is
 * the effective set scaffold's `evaluateSegments` (`@revt-eng/core`,
 * re-exported by `./segments`) built — `segment.handle`, plus any hosted
 * slugs — and `segment_ids` carries only what a hosted context minted. Local
 * mode therefore has no `segment_ids` key at all, and nothing here
 * re-evaluates a segment: the test supplies a Playbook and a user, the SDK
 * decides.
 */
describe('segments are handles: local mode carries the evaluated handle set and no segment_ids', () => {
  const SEGMENT_HANDLE = 'power_users';
  const ANCHOR = 'dim_anchor_0001';

  /** A Playbook whose one segment matches `custom.region = 'eu'`; the SDK evaluates it, the test never does. */
  function playbookSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
    const playbook = RevTurbineConfigSchema.parse({
      version: '1.0.0',
      exported_at: '2026-09-29T00:00:00Z',
      plans: [{ id: 'free', unique_handle: 'free', name: 'free' }],
      entitlements: [],
      entitlement_rules: [],
      content_ui_paths: [],
      surface_templates: [],
      placements: [],
      segments: [{
        handle: SEGMENT_HANDLE,
        name: 'Power users',
        dimension_id: ANCHOR,
        predicates: [{ field: 'region', operator: 'eq', value: 'eu' }],
      }],
    });
    return seedSlot(new RevTurbineCustomerSdk({
      ...BASE_OPTIONS,
      ...over,
      localRuntime: { playbook, resolvers: resolvers(upgradeOutput()) },
    }));
  }

  /** The semantic bag of a `/api/track` wire event (the SDK nests `payload.<field>`). */
  const trackPayload = (eventName: string): Record<string, unknown> | undefined => {
    const event = posts
      .filter((p) => p.url.endsWith('/api/track'))
      .flatMap((p) => (p.body as { events?: Array<{ event_name: string; properties?: string }> }).events ?? [])
      .find((e) => e.event_name === eventName);
    if (!event?.properties) return undefined;
    return (JSON.parse(event.properties) as { payload?: Record<string, unknown> }).payload;
  };

  it('(1) local mode: the row carries segment_handles with the evaluated handle and NO segment_ids key', async () => {
    const sdk = playbookSdk();
    await sdk.identify(USER, { plan_handle: 'free', custom: { region: 'eu' } });
    const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    const effective = [...effectiveHandles(sdk)];
    posts = [];

    await sdk.trackTreatmentInteraction(interaction({ payloadId: String(decision.output?.output_id) }));
    await settle();

    const body = sentInteraction();
    expect(body.segment_handles).toContain(SEGMENT_HANDLE);
    expect(body.segment_handles).toEqual(effective);
    expect(JSON.stringify(body.segment_handles)).not.toContain(ANCHOR);
    expect(body).not.toHaveProperty('segment_ids');
    expect(body.decision_id).toBe('dec_upgrade');
    expect(TreatmentInteractionInputSchema.safeParse(body).success).toBe(true);
  });

  it('in local mode the checkout_started envelope’s legacy segment_ids stamp is that same handle set', async () => {
    const sdk = playbookSdk();
    await sdk.identify(USER, { plan_handle: 'free', custom: { region: 'eu' } });
    const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    posts = [];

    await sdk.trackTreatmentInteraction(interaction({ payloadId: String(decision.output?.output_id) }));
    await sdk.flushEvents();
    await settle();

    const row = sentInteraction();
    const started = trackPayload('checkout_started');
    expect(started, 'a navigate_to_plans click emits checkout_started').toBeDefined();
    // The envelope keeps its legacy name (BL-0462 owns that rename); with no
    // hosted ids in scope its value is exactly the handle set the row carries.
    expect(started?.segment_ids).toEqual(row.segment_handles);
    expect(started?.placement_id).toBe(SLOT);
    expect(started?.decision_id).toBe('dec_upgrade');
  });

  it('a user the segment does not match carries the effective set without the handle, still no segment_ids', async () => {
    const sdk = playbookSdk();
    await sdk.identify(USER, { plan_handle: 'free', custom: { region: 'us' } });
    const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    const effective = [...effectiveHandles(sdk)];
    posts = [];

    await sdk.trackTreatmentInteraction(interaction({ payloadId: String(decision.output?.output_id) }));
    await settle();

    const body = sentInteraction();
    expect(body.segment_handles).not.toContain(SEGMENT_HANDLE);
    expect(body.segment_handles).toEqual(effective);
    expect(body).not.toHaveProperty('segment_ids');
  });

  it('(2) a hosted-resolved context adds its slugs to segment_handles and its minted ids to segment_ids only', async () => {
    const sdk = playbookSdk({
      domainProviders: [{
        domain: 'segments',
        resolve: () => ({ segmentIds: [MINTED_ID], segmentSlugs: ['hosted_vip'] }),
      }],
    });
    await sdk.identify(USER, { plan_handle: 'free', custom: { region: 'eu' } });
    const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
    posts = [];

    await sdk.trackTreatmentInteraction(interaction({ payloadId: String(decision.output?.output_id) }));
    await settle();

    const body = sentInteraction();
    expect(body.segment_handles).toContain(SEGMENT_HANDLE);
    expect(body.segment_handles).toContain('hosted_vip');
    expect(body.segment_handles).not.toContain(MINTED_ID);
    expect(body.segment_ids).toEqual([MINTED_ID]);
    expect(JSON.stringify(body)).not.toContain(ANCHOR);
  });
});
