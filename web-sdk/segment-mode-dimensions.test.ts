import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineConfigSchema } from '@revt-eng/schema';
import { RevTurbineCustomerSdk, RuntimeMode } from './customer-side';

// ST-1391 / BUG-1389: a segment's dimension and mode are derived from its
// predicates. Every segment below carries the same upload placeholder
// `dimension_id`; a stored-id lookup would collapse them into one bucket.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const PLACEHOLDER = 'dim_imported_tenant';

function segment(handle: string, field: string, value: string, extra: Record<string, unknown> = {}) {
  return {
    handle,
    name: handle,
    dimension_id: PLACEHOLDER,
    predicates: [{ field, operator: 'eq', value }],
    ...extra,
  };
}

function playbook() {
  return RevTurbineConfigSchema.parse({
    version: '1.0.0',
    exported_at: '2026-10-30T00:00:00Z',
    plans: [{ id: 'free', unique_handle: 'free', name: 'free' }],
    entitlements: [{ unique_handle: 'feature_x', name: 'Feature X', type: 'feature' }],
    entitlement_rules: [{
      id: 'rule_x',
      entitlement_id: 'feature_x',
      targets: [{ kind: 'plan', id: 'free' }],
      segment_ids: ['pro', 'team', 'us', 'ca'],
      enabled: true,
      type_fields: { kind: 'feature', enabled: true },
    }],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
    segments: [
      segment('pro', 'plan', 'pro'),
      segment('team', 'plan', 'team'),
      segment('us', 'country', 'us'),
      segment('ca', 'country', 'ca'),
      // Basic, repeated field: ORs. Advanced twin: flat AND, never matches.
      {
        handle: 'either_plan',
        name: 'either_plan',
        predicates: [
          { field: 'plan', operator: 'eq', value: 'pro' },
          { field: 'plan', operator: 'eq', value: 'team' },
        ],
      },
      {
        handle: 'either_plan_advanced',
        name: 'either_plan_advanced',
        mode: 'advanced',
        predicates: [
          { field: 'plan', operator: 'eq', value: 'pro' },
          { field: 'plan', operator: 'eq', value: 'team' },
        ],
      },
    ],
  });
}

async function explain(custom: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'segment_mode_dimensions',
    apiKey: 'local-only',
    endpoint: 'https://sdk.example.test',
    mode: 'snippet',
    runtimeMode: RuntimeMode.LocalOnly,
    previewMode: true,
    anonymousTelemetry: false,
    analytics: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: playbook() },
  });
  try {
    await sdk.identify('user_1', { plan_handle: 'free', custom });
    const placementId = await sdk.registerSurfaceSlot({
      id: 'offer_slot',
      name: 'offer',
      surfaceTemplateIds: ['banner_placement'],
    });
    return await sdk.explainPlacementDecision({ placementId, userId: 'user_1' });
  } finally {
    sdk.dispose();
  }
}

describe('segment mode and derived dimensions (ST-1391)', () => {
  it('buckets rule segments by derived dimension: (pro OR team) AND (us OR ca)', async () => {
    const both = await explain({ plan: 'pro', country: 'us' });
    expect(both.entitlementRules[0]?.matchesSegment).toBe(true);

    const planOnly = await explain({ plan: 'pro' });
    expect(planOnly.entitlementRules[0]?.matchesSegment).toBe(false);

    const countryOnly = await explain({ country: 'ca' });
    expect(countryOnly.entitlementRules[0]?.matchesSegment).toBe(false);
  });

  it('evaluates a repeated-field basic segment as OR and an advanced twin as AND', async () => {
    const team = await explain({ plan: 'team' });
    expect(team.targeting.segmentIds).toContain('either_plan');
    expect(team.targeting.segmentIds).not.toContain('either_plan_advanced');
    const byHandle = new Map(team.segments.map((s) => [s.segmentId, s.matched]));
    expect(byHandle.get('either_plan')).toBe(true);
    expect(byHandle.get('either_plan_advanced')).toBe(false);
  });
});
