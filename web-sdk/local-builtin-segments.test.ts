import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineConfigSchema, type RevTurbineConfig } from '@revt-eng/schema';
import { BUILTIN_DIMENSIONS, generateBuiltinSegments } from '@revt-eng/core';
import { RevTurbineCustomerSdk, RuntimeMode } from './customer-side';
import { withLocalBuiltinSegments } from './local-builtin-segments';

// BL-0365: a local Playbook carries no built-in `rt.*` definitions, so the SDK
// synthesizes them at load from the scaffold catalogue.
//
// BL-0381 (D-46): definitions only, never values. The browser app cannot set
// `builtin_dimensions`; the values arrive only from the authenticated
// client-context delivery, so these tests deliver them through
// `fetchClientContext`, and an app-set value must fail closed.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function playbook(overrides: Record<string, unknown> = {}): RevTurbineConfig {
  return RevTurbineConfigSchema.parse({
    version: '1.0.0', exported_at: '2026-09-28T00:00:00Z',
    plans: ['free', 'pro'].map((handle) => ({ id: handle, unique_handle: handle, name: handle })),
    entitlements: [], entitlement_rules: [], content_ui_paths: [], surface_templates: [],
    segments: [],
    ...overrides,
  });
}

const CLOSED_VALUE_COUNT = BUILTIN_DIMENSIONS
  .filter((d) => d.vocabulary === 'closed')
  .reduce((n, d) => n + d.values.length, 0);

describe('withLocalBuiltinSegments', () => {
  it('generates every closed-vocabulary value of all ten dimensions from the catalogue', () => {
    const out = withLocalBuiltinSegments(playbook());
    const expected = generateBuiltinSegments({ dimensions: BUILTIN_DIMENSIONS.map((d) => d.key) }).segments;
    expect(out.segments).toEqual(expected);
    expect(out.segments).toHaveLength(CLOSED_VALUE_COUNT);
    expect(out.segments?.map((s) => s.handle)).toContain('rt.email_type.business');
    expect(out.segments?.map((s) => s.handle)).toContain('rt.region.europe');
  });

  it("generates Seat Type values from the Playbook's own seat_types[], skipping unusable handles", () => {
    const out = withLocalBuiltinSegments(playbook({
      seat_types: [
        { handle: 'editor', name: 'Editor', is_buyer: true },
        { handle: 'viewer', name: 'Viewer' },
        { handle: 'Bad Handle', name: 'Bad' },
      ],
    }));
    const seat = (out.segments ?? []).filter((s) => s.dimension_id === 'rt.seat_type');
    expect(seat).toEqual([
      { name: 'Editor', handle: 'rt.seat_type.editor', dimension_id: 'rt.seat_type',
        predicates: [{ field: 'rt_seat_type', operator: 'eq', value: 'editor' }] },
      { name: 'Viewer', handle: 'rt.seat_type.viewer', dimension_id: 'rt.seat_type',
        predicates: [{ field: 'rt_seat_type', operator: 'eq', value: 'viewer' }] },
    ]);
  });

  it('keeps tenant segments and existing generated definitions, adding only what is missing', () => {
    const [paid] = generateBuiltinSegments({ dimensions: ['subscription_state'] }).segments
      .filter((s) => s.handle === 'rt.subscription_state.paid');
    const exported = { ...paid, name: 'Paid (as exported)' };
    const tenant = { handle: 'europe', name: 'Europe', predicates: [{ field: 'region', operator: 'eq', value: 'eu' }] };
    const out = withLocalBuiltinSegments(playbook({ segments: [tenant, exported] }));
    const handles = out.segments?.map((s) => s.handle) ?? [];
    expect(out.segments?.slice(0, 2)).toEqual([expect.objectContaining(tenant), exported]);
    expect(handles.filter((h) => h === 'rt.subscription_state.paid')).toHaveLength(1);
    expect(out.segments).toHaveLength(2 + CLOSED_VALUE_COUNT - 1);
  });

  it('drops an authored rt.* segment that is not an exact generated definition (VAL-SEG-02), with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const impostor = {
      handle: 'rt.subscription_state.paid', name: 'Paid',
      dimension_id: 'rt.subscription_state',
      predicates: [{ field: 'plan_handle', operator: 'eq', value: 'pro' }],
    };
    const invented = { handle: 'rt.custom.thing', name: 'Thing', predicates: [{ field: 'x', operator: 'eq', value: 'y' }] };
    const out = withLocalBuiltinSegments(playbook({ segments: [impostor, invented] }));
    const paid = out.segments?.find((s) => s.handle === 'rt.subscription_state.paid');
    expect(paid?.predicates).toEqual([{ field: 'rt_subscription_state', operator: 'eq', value: 'paid' }]);
    expect(out.segments?.some((s) => s.handle === 'rt.custom.thing')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("'rt.subscription_state.paid', 'rt.custom.thing'");
  });

  it('returns the same object when every definition is already present', () => {
    const full = withLocalBuiltinSegments(playbook());
    expect(withLocalBuiltinSegments(full)).toBe(full);
    expect(withLocalBuiltinSegments(undefined)).toBeUndefined();
  });
});

describe('local_only Playbook naming a built-in (BL-0365, BL-0381)', () => {
  const offerPlaybook = (chips: string[]) => playbook({
    seat_types: [{ handle: 'editor', name: 'Editor' }],
    placements: [{
      id: 'offer', name: 'offer', category: 'fixed', order: 0,
      trigger: { type: 'surface_render', slot_id: 'offer_slot' },
      payloads: [{
        id: 'offer_payload', target: { plan_ids: [], segment_chips: chips },
        surfaces: [{ template_id: 'banner_placement', fields: {}, ctas: [] }],
      }],
    }],
  });

  /**
   * Explain the offer slot's decision for `user_1`. `builtinDimensions` is
   * supplied the way `source` says: `'delivered'` (the default) serves it from
   * `GET /api/sdk/client-context`, the only browser source (D-46);
   * `'app'` passes it to `update()` as a plain-JS caller would, which the SDK
   * must drop.
   */
  async function explain(
    config: RevTurbineConfig,
    builtinDimensions: Record<string, string> | undefined,
    runtimeMode: RuntimeMode = RuntimeMode.LocalOnly,
    options: { viaResolver?: boolean; custom?: Record<string, string>; source?: 'delivered' | 'app' } = {},
  ) {
    const source = options.source ?? 'delivered';
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => (
      String(url).endsWith('/api/sdk/client-context') && builtinDimensions
        ? new Response(JSON.stringify({ builtin_dimensions: builtinDimensions }))
        : new Response('{}')
    )));
    const sdk = new RevTurbineCustomerSdk({
      tenantId: 'local_builtins', apiKey: 'local-only',
      endpoint: 'https://sdk.example.test', mode: 'snippet', runtimeMode,
      previewMode: true, anonymousTelemetry: false, analytics: false,
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      ...(runtimeMode !== RuntimeMode.LocalOnly
        ? { configProvider: { getPlaybook: () => config } }
        : options.viaResolver
          ? { localRuntime: { resolvers: { resolvePlaybook: () => config } } }
          : { localRuntime: { playbook: config } }),
    });
    try {
      await sdk.identify('user_1', options.custom ? { custom: options.custom } : {});
      if (builtinDimensions && source === 'delivered') {
        await sdk.fetchClientContext('rt_client_local_builtins');
      }
      if (builtinDimensions && source === 'app') {
        // A plain-JS caller: the type no longer accepts the key (BL-0381).
        sdk.update({ builtin_dimensions: builtinDimensions } as never);
      }
      const placementId = await sdk.registerSurfaceSlot({
        id: 'offer_slot', name: 'offer', surfaceTemplateIds: ['banner_placement'],
      });
      return await sdk.explainPlacementDecision({ placementId, userId: 'user_1' });
    } finally {
      sdk.dispose();
    }
  }

  it.each([
    ['rt.subscription_state.paid', { subscription_state: 'paid' }, true],
    ['rt.subscription_state.paid', { subscription_state: 'trial' }, false],
    ['rt.email_type.business', { email_type: 'business' }, true],
    ['rt.region.europe', { region: 'us_canada' }, false],
    ['rt.seat_type.editor', { seat_type: 'editor' }, true],
    ['rt.buyer_role.buyer', { buyer_role: 'buyer' }, true],
    ['rt.subscription_state.paid', undefined, false],
  ] as const)('chip %s with delivered %j matches: %s', async (chip, dims, matches) => {
    const explanation = await explain(offerPlaybook([chip]), dims);
    expect(Boolean(explanation.decision.output)).toBe(matches);
    expect(explanation.targeting.segmentIds.includes(chip)).toBe(matches);
    expect(explanation.eligiblePayloads[0].matchesSegment).toBe(matches);
  });

  it.each([
    ['rt.subscription_state.paid', { subscription_state: 'paid' }],
    ['rt.email_type.business', { email_type: 'business' }],
    ['rt.seat_type.editor', { seat_type: 'editor' }],
    ['rt.buyer_role.buyer', { buyer_role: 'buyer' }],
  ] as const)('chip %s with app-set %j fails closed: the value is dropped (D-46)', async (chip, dims) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const explanation = await explain(offerPlaybook([chip]), dims, RuntimeMode.LocalOnly, { source: 'app' });
    expect(Boolean(explanation.decision.output)).toBe(false);
    expect(explanation.targeting.segmentIds.includes(chip)).toBe(false);
    expect(explanation.eligiblePayloads[0].matchesSegment).toBe(false);
    expect(Object.keys(explanation.targeting.traits).filter((k) => k.startsWith('rt_') && k !== 'rt_registration_state'))
      .toEqual([]);
  });

  it('ORs values within one built-in dimension', async () => {
    const explanation = await explain(
      offerPlaybook(['rt.subscription_state.trial', 'rt.subscription_state.paid']),
      { subscription_state: 'paid' },
    );
    expect(explanation.eligiblePayloads[0].matchesSegment).toBe(true);
  });

  it('matches Registration State from the identified id alone', async () => {
    const explanation = await explain(offerPlaybook(['rt.registration_state.registered']), undefined);
    expect(explanation.eligiblePayloads[0].matchesSegment).toBe(true);
  });

  it('synthesizes for a Playbook from localRuntime.resolvers too', async () => {
    const explanation = await explain(
      offerPlaybook(['rt.subscription_state.paid']),
      { subscription_state: 'paid' },
      RuntimeMode.LocalOnly,
      { viaResolver: true },
    );
    expect(Boolean(explanation.decision.output)).toBe(true);
    expect(explanation.eligiblePayloads[0].matchesSegment).toBe(true);
  });

  it('never lets a custom rt_* trait impersonate a built-in, in the decision or its explanation', async () => {
    const explanation = await explain(
      offerPlaybook(['rt.subscription_state.paid']),
      undefined,
      RuntimeMode.LocalOnly,
      { custom: { rt_subscription_state: 'paid' } },
    );
    expect(Boolean(explanation.decision.output)).toBe(false);
    expect(explanation.targeting.traits.rt_subscription_state).toBeUndefined();
    expect(explanation.eligiblePayloads[0].matchesSegment).toBe(false);
  });

  it('leaves a hosted (configProvider) Playbook as delivered', async () => {
    const explanation = await explain(
      offerPlaybook(['rt.email_type.business']),
      { email_type: 'business' },
      RuntimeMode.Server,
    );
    expect(explanation.eligiblePayloads[0].matchesSegment).toBe(false);
  });
});
