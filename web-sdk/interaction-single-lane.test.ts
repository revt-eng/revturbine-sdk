/**
 * @vitest-environment jsdom
 *
 * EP-1692 / ST-1695 — one reporting lane for placement interactions, and a
 * connected startup seed that keeps its hosted defaults.
 *
 * Since SDK 0.15.0 an interaction (impression, dismiss, CTA click, ...) is
 * reported ONLY as a `placement_interaction` clickstream event in the
 * `/api/track` batch. The separate `/api/events/interactions` POST lane is gone,
 * so the interaction inherits the clickstream gates: telemetry consent other
 * than `granted`, and `analytics: false`, send nothing. Behaviour never depends
 * on reporting: Playbook delivery, dismissal cooldowns, suppression and caps keep
 * working from local state.
 *
 * AC-1  consent `denied` / `analytics: false` -> zero ingest requests, while the
 *       dismissal cooldown and a session cap are enforced on the next decision.
 * AC-2  consent granted -> exactly one `placement_interaction` per interaction
 *       carrying the full record, and no request to `/api/events/interactions`.
 * AC-3  `setTelemetryConsent` at runtime stops and resumes reporting.
 * AC-8  `publicKey` + connected `runtimeMode` + a Playbook seed, with no
 *       `tenantId` / `endpoint`, uses the hosted defaults and learns the tenant
 *       from the key.
 *
 * Spec: docs/specs/sdk/telemetry.md §9.1 / §16.1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HOSTED_ENDPOINT,
  RevTurbineCustomerSdk,
  RuntimeMode,
  initRevTurbine,
} from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

const ENDPOINT = 'https://edge.example.com';
const USER = 'user_1';
const PUBLIC_KEY = 'rtk_public_key';
const TRACK_PATH = '/api/track';
const INTERACTIONS_PATH = '/api/events/interactions';

interface Call {
  url: string;
  headers: Headers;
  body: unknown;
}

let calls: Call[] = [];
/** Status the stubbed control plane answers `/api/sdk/config` with. */
let configStatus = 404;
/** The Playbook the stubbed control plane delivers (when `configStatus` is 200). */
let delivered: unknown = null;
/** When set, `/api/sdk/config` waits for it before answering. */
let configGate: Promise<void> | null = null;

function stubNetwork(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = null;
    try {
      body = JSON.parse(String(init?.body ?? 'null'));
    } catch {
      body = null;
    }
    calls.push({ url, headers: new Headers(init?.headers), body });
    if (url.includes('/api/sdk/bootstrap')) {
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}), text: async () => '' } as unknown as Response;
    }
    if (url.includes('/api/sdk/config')) {
      if (configGate) await configGate;
      if (configStatus !== 200) {
        return { ok: false, status: configStatus, headers: new Headers(), json: async () => ({}), text: async () => '' } as unknown as Response;
      }
      const text = JSON.stringify(delivered);
      return { ok: true, status: 200, headers: new Headers(), json: async () => delivered, text: async () => text } as unknown as Response;
    }
    return { ok: true, status: 202, headers: new Headers(), json: async () => ({ accepted: 1 }), text: async () => '' } as unknown as Response;
  }));
}

beforeEach(() => {
  // Interaction state and caps persist in browser storage; start every test clean.
  localStorage.clear();
  sessionStorage.clear();
  calls = [];
  configStatus = 404;
  delivered = null;
  configGate = null;
  stubNetwork();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Calls that carry behaviour to RevTurbine ingest: the clickstream and the retired interactions route. */
const ingestCalls = (): Call[] =>
  calls.filter((c) => c.url.includes(TRACK_PATH) || c.url.includes(INTERACTIONS_PATH));

const trackedRows = (): Array<Record<string, unknown>> =>
  calls
    .filter((c) => c.url.endsWith(TRACK_PATH))
    .flatMap((c) => (c.body as { events?: Array<Record<string, unknown>> }).events ?? []);

/** Every `placement_interaction` wire row with its payload (the record). */
const interactionEvents = (): Array<{ wire: Record<string, unknown>; payload: Record<string, unknown> }> =>
  trackedRows()
    .filter((row) => row.event_name === 'placement_interaction')
    .map((wire) => ({
      wire,
      payload: (JSON.parse(String(wire.properties)) as { payload: Record<string, unknown> }).payload,
    }));

// ── Fixture: a connected SDK whose Playbook is a startup seed ────────────────

const nudge = (id: string, order: number, header: string) => ({
  id,
  name: id,
  category: 'other_conversion',
  order,
  trigger: {},
  payloads: [{
    id: `${id}_p0`,
    target: { plan_ids: [], segment_chips: [] },
    surfaces: [{ template_id: 'banner_placement', fields: { header, body: '' }, ctas: [] }],
    caps: {},
  }],
});

function seedPlaybook(capRules: unknown[] = []) {
  return {
    artifact_type: 'playbook',
    format_version: '1.0.0',
    playbook_handle: 'default',
    playbook_version_id: 'pbv_seed',
    tenant_id: 'tenant_lane',
    environment_id: 'production',
    plans: [],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    placements: [nudge('pl_a', 0, 'A')],
    placement_settings: [{
      handle: 'default',
      global_frequency_cap: { capRules, sessionCooldownMinutes: 0, testMode: 'off' },
    }],
  };
}

/**
 * A hosted (`revturbine_server`) SDK whose delivery is refused (404), so the
 * seed decides: the hosted lane is live (ingest would be reachable) but the
 * Playbook is local, which is what lets the test read cooldowns and caps.
 */
async function connectedSdk(
  over: Partial<RevTurbineInitOptions> = {},
  capRules: unknown[] = [],
  slotMetadata: Record<string, string> = {},
): Promise<{ sdk: RevTurbineCustomerSdk; placementId: string }> {
  const sdk = new RevTurbineCustomerSdk({
    user: { id: USER },
    tenantId: 'tenant_lane',
    publicKey: PUBLIC_KEY,
    environmentId: 'production',
    endpoint: ENDPOINT,
    mode: 'snippet',
    runtimeMode: 'revturbine_server',
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: seedPlaybook(capRules) as never },
    ...over,
  });
  const placementId = await sdk.registerSurfaceSlot({
    id: 'slot_home',
    name: 'slot_home',
    surfaceTemplateIds: ['banner_placement'],
    metadata: slotMetadata,
  });
  return { sdk, placementId };
}

const interaction = (placementId: string, interactionType: 'impression' | 'dismiss' | 'cta_clicked') => ({
  userId: USER,
  placementId,
  treatmentId: 'pl_a_p0',
  interactionType,
  surfaceSlotId: 'slot_home',
  surfaceTemplateId: 'banner_placement',
  payloadId: 'pl_a_p0',
});

/** An impression, a dismissal and a CTA click: the three interactions every gate must cover. */
async function reportAll(sdk: RevTurbineCustomerSdk, placementId: string): Promise<void> {
  await sdk.trackTreatmentInteraction(interaction(placementId, 'impression'));
  await sdk.trackTreatmentInteraction(interaction(placementId, 'dismiss'));
  await sdk.trackTreatmentInteraction(interaction(placementId, 'cta_clicked'));
  await sdk.flushEvents();
}

// ── AC-1 ─────────────────────────────────────────────────────────────────────

describe.each([
  ['telemetry.consent: denied', { telemetry: { consent: 'denied' } } satisfies Partial<RevTurbineInitOptions>],
  ['telemetry.consent: pending', { telemetry: { consent: 'pending' } } satisfies Partial<RevTurbineInitOptions>],
  ['analytics: false', { analytics: false } satisfies Partial<RevTurbineInitOptions>],
])('AC-1: connected mode with %s', (_label, over) => {
  it('sends nothing to any ingest path for an impression, a dismissal and a CTA click', async () => {
    const { sdk, placementId } = await connectedSdk(over);

    await reportAll(sdk, placementId);

    expect(ingestCalls()).toHaveLength(0);
    expect(interactionEvents()).toHaveLength(0);
  });

  it('still enforces the dismissal cooldown on the next decision', async () => {
    const { sdk, placementId } = await connectedSdk(over);
    const before = await sdk.getPlacementDecision({ placementId, userId: USER });
    expect(before.visible).toBe(true);

    await reportAll(sdk, placementId);

    const after = await sdk.getPlacementDecision({ placementId, userId: USER });
    expect(after.visible).toBe(false);
    expect(ingestCalls()).toHaveLength(0);
  });

  it('still enforces a session cap on the next decision', async () => {
    const { sdk, placementId } = await connectedSdk(over, [
      { id: 'cap_banner', group: [{ kind: 'template', id: 'banner-placement' }], cap: { count: 1, period: 'session' } },
    ]);
    expect((await sdk.getPlacementDecision({ placementId, userId: USER })).visible).toBe(true);
    await sdk.trackTreatmentInteraction(interaction(placementId, 'impression'));
    await sdk.flushEvents();

    const second = await sdk.getPlacementDecision({ placementId, userId: USER });
    expect(second.visible).toBe(false);
    expect(second.reasonCodes).toContain('suppressed_by_presentation_cap');
    expect(ingestCalls()).toHaveLength(0);
  });

  it('does not change what Playbook delivery requests', async () => {
    const { sdk } = await connectedSdk(over);
    await sdk.flushEvents();

    // Delivery is a Playbook read, not behaviour reporting: it is unaffected.
    expect(calls.some((c) => c.url.includes('/api/sdk/'))).toBe(true);
    expect(ingestCalls()).toHaveLength(0);
  });
});

// ── AC-2 ─────────────────────────────────────────────────────────────────────

describe('AC-2: consent granted reports each interaction once, on /api/track', () => {
  it('sends exactly one placement_interaction per interaction, with the full record, and no interactions request', async () => {
    // A slot requested through a gate, so the exposure stamp is present.
    const { sdk, placementId } = await connectedSdk(
      {},
      [],
      { surface_slot_category: 'gated', entitlement_handle: 'export_pdf' },
    );
    sdk.identify(USER, { account_id: 'acct_lane' });

    await sdk.trackTreatmentInteraction({
      ...interaction(placementId, 'impression'),
      messageBlockHandle: 'block_1',
      experimentId: 'exp_1',
      variantKey: 'B',
      ruleHandle: 'rule_1',
      decisionId: 'dec_1',
      segmentHandles: ['seg_a'],
      segmentIds: ['01SEGMENTID'],
      metadata: { source: 'test' },
      interactionAt: '2026-11-10T10:00:00.000Z',
    });
    await sdk.trackTreatmentInteraction(interaction(placementId, 'dismiss'));
    await sdk.trackTreatmentInteraction(interaction(placementId, 'cta_clicked'));
    await sdk.flushEvents();

    expect(calls.some((c) => c.url.includes(INTERACTIONS_PATH))).toBe(false);
    const events = interactionEvents();
    expect(events.map((e) => e.payload.interaction_type)).toEqual(['impression', 'dismiss', 'cta_clicked']);

    const [impression] = events;
    expect(impression.payload).toEqual({
      user_id: USER,
      account_id: 'acct_lane',
      placement_id: placementId,
      treatment_id: 'pl_a_p0',
      interaction_type: 'impression',
      interaction_at: '2026-11-10T10:00:00.000Z',
      surface_slot_id: 'slot_home',
      surface_template_id: 'banner_placement',
      payload_id: 'pl_a_p0',
      message_block_handle: 'block_1',
      experiment_id: 'exp_1',
      variant_key: 'B',
      rule_handle: 'rule_1',
      // The exposure stamp: the slot was requested through a gate.
      trigger_source: 'gate',
      entitlement_handle: 'export_pdf',
      playbook_version: 'pbv_seed',
      decision_id: 'dec_1',
      segment_handles: ['seg_a'],
      segment_ids: ['01SEGMENTID'],
      metadata: { source: 'test' },
    });
    // The columns the clickstream lifts to the wire.
    expect(impression.wire).toMatchObject({
      account_id: 'acct_lane',
      placement_id: placementId,
      surface_slot_id: 'slot_home',
      payload_id: 'pl_a_p0',
      experiment_id: 'exp_1',
      variant_key: 'B',
      decision_id: 'dec_1',
      playbook_version: 'pbv_seed',
    });
  });

  it('keeps every optional key absent, never null or empty, when nothing supplied it', async () => {
    const { sdk, placementId } = await connectedSdk();
    await sdk.trackTreatmentInteraction({ userId: USER, placementId, interactionType: 'impression' });
    await sdk.flushEvents();

    const [only] = interactionEvents();
    for (const key of [
      'surface_slot_id', 'surface_template_id', 'payload_id', 'message_block_handle', 'experiment_id',
      'variant_key', 'rule_handle', 'decision_id', 'segment_handles', 'segment_ids',
    ]) {
      expect(only.payload, key).not.toHaveProperty(key);
    }
  });

  it('reporting does not replace the behaviour half: the dismissal still suppresses', async () => {
    const { sdk, placementId } = await connectedSdk();
    await reportAll(sdk, placementId);

    expect((await sdk.getPlacementDecision({ placementId, userId: USER })).visible).toBe(false);
    expect(interactionEvents()).toHaveLength(3);
  });
});

// ── AC-3 ─────────────────────────────────────────────────────────────────────

describe('AC-3: setTelemetryConsent changes reporting from the next interaction', () => {
  it('denied stops reporting without re-initialising, and granted resumes it', async () => {
    const { sdk, placementId } = await connectedSdk();

    await sdk.trackTreatmentInteraction(interaction(placementId, 'impression'));
    await sdk.flushEvents();
    expect(interactionEvents().map((e) => e.payload.interaction_type)).toEqual(['impression']);

    sdk.setTelemetryConsent('denied');
    await sdk.trackTreatmentInteraction(interaction(placementId, 'dismiss'));
    await sdk.flushEvents();
    expect(interactionEvents().map((e) => e.payload.interaction_type)).toEqual(['impression']);
    // Behaviour is unaffected: the dismissal that was NOT reported suppresses.
    expect((await sdk.getPlacementDecision({ placementId, userId: USER })).visible).toBe(false);

    sdk.setTelemetryConsent('granted');
    await sdk.trackTreatmentInteraction(interaction(placementId, 'cta_clicked'));
    await sdk.flushEvents();
    expect(interactionEvents().map((e) => e.payload.interaction_type)).toEqual(['impression', 'cta_clicked']);
    expect(calls.some((c) => c.url.includes(INTERACTIONS_PATH))).toBe(false);
  });
});

// ── AC-8 ─────────────────────────────────────────────────────────────────────

describe('AC-8: a connected startup seed keeps the hosted defaults in a browser', () => {
  const HOSTED_TENANT = 'tenant_hosted';

  const hostedPlaybook = {
    ...seedPlaybook(),
    tenant_id: HOSTED_TENANT,
    playbook_version_id: 'pbv_hosted',
    // The hosted payload is versioned; an unversioned one is refused.
    bundle_schema_version: 16,
    placements: [nudge('pl_a', 0, 'Delivered')],
  };

  /** Same tenant and slot, different content, so the two Playbooks are told apart by what they show. */
  const seed = { ...hostedPlaybook, playbook_version_id: 'pbv_seed', placements: [nudge('pl_a', 0, 'Seed')] };

  /** The header the slot shows now. */
  async function shownHeader(sdk: RevTurbineCustomerSdk): Promise<unknown> {
    const placementId = await sdk.registerSurfaceSlot({
      id: 'slot_home',
      name: 'slot_home',
      surfaceTemplateIds: ['banner_placement'],
    });
    const decision = await sdk.getPlacementDecision({ placementId, userId: USER });
    return decision.content.header;
  }

  /** The ONLY connection options: the public key and the seed. No `tenantId`, no `endpoint`. */
  function keyOnlyInit(): RevTurbineCustomerSdk {
    return initRevTurbine({
      publicKey: PUBLIC_KEY,
      runtimeMode: RuntimeMode.Server,
      anonymousTelemetry: false,
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      user: { id: USER, plan_handle: 'pro' },
      localRuntime: { playbook: seed as never },
    });
  }

  const deliveryCalls = (): Call[] => calls.filter((c) => /\/api\/sdk\/(bootstrap|config)/.test(c.url));

  it('requests delivery from the hosted default endpoint with the public key, and learns the tenant from the key', async () => {
    delivered = hostedPlaybook;
    configStatus = 200;
    const sdk = keyOnlyInit();

    await vi.waitFor(() => expect(deliveryCalls().length).toBeGreaterThan(0));
    for (const call of deliveryCalls()) {
      expect(call.url.startsWith(DEFAULT_HOSTED_ENDPOINT), call.url).toBe(true);
      expect(call.url).not.toContain('revturbine.local');
      expect(call.headers.get('authorization')).toBe(`Bearer ${PUBLIC_KEY}`);
      // No tenant was configured, so none is claimed: the key names the tenant.
      expect(call.headers.get('x-tenant-id')).toBeNull();
    }
    await vi.waitFor(() => expect(Reflect.get(sdk, 'tenantId')).toBe(HOSTED_TENANT));
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toMatch(/does not match the key's tenant/);
    sdk.dispose();
  });

  it('the seed answers before delivery, and the delivered Playbook replaces it', async () => {
    delivered = hostedPlaybook;
    configStatus = 200;
    let release: () => void = () => undefined;
    configGate = new Promise<void>((resolve) => { release = resolve; });
    const sdk = keyOnlyInit();

    // Delivery is requested and still unanswered: the seed decides.
    await vi.waitFor(() => expect(deliveryCalls().length).toBeGreaterThan(0));
    expect(deliveryCalls().every((c) => c.url.startsWith(DEFAULT_HOSTED_ENDPOINT))).toBe(true);
    expect(Reflect.get(sdk, 'playbookLoadInFlight')).not.toBeNull();
    expect(await shownHeader(sdk)).toBe('Seed');

    release();
    await vi.waitFor(() => expect(Reflect.get(sdk, 'playbookLoadInFlight')).toBeNull());
    expect(sdk.getPlaybookLoadFailure()).toBeUndefined();
    expect(Reflect.get(sdk, 'getConfiguredPlaybook').call(sdk)?.playbook_version_id).toBe('pbv_hosted');
    expect(await shownHeader(sdk)).toBe('Delivered');
    sdk.dispose();
  });

  it('keeps the seed and reports a readable load failure when delivery is refused', async () => {
    configStatus = 403;
    const sdk = keyOnlyInit();

    await vi.waitFor(() => expect(sdk.getPlaybookLoadFailure()).toBeDefined());
    expect(sdk.getPlaybookLoadFailure()).toBeTruthy();
    expect(deliveryCalls().every((c) => c.url.startsWith(DEFAULT_HOSTED_ENDPOINT))).toBe(true);
    // The seed still decides.
    expect(await shownHeader(sdk)).toBe('Seed');
    expect(Reflect.get(sdk, 'getConfiguredPlaybook').call(sdk)?.playbook_version_id).toBe('pbv_seed');
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toMatch(/does not match the key's tenant/);
    sdk.dispose();
  });

  it('a Playbook with no runtimeMode still defaults to local_only and requests nothing', async () => {
    const sdk = initRevTurbine({
      user: { id: USER },
      anonymousTelemetry: false,
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      localRuntime: { playbook: seed as never },
    });

    expect(await shownHeader(sdk)).toBe('Seed');
    expect(calls).toHaveLength(0);
    sdk.dispose();
  });
});
