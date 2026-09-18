import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineConfigSchema } from '@revt-eng/schema';
import { evaluateSegmentEligibility } from '@revt-eng/core';
import { RevTurbineCustomerSdk, RuntimeMode } from './customer-side';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const segmentCases = [
  { name: 'no chips', chips: [], region: 'eu', matches: true },
  { name: 'one match', chips: ['europe'], region: 'eu', matches: true },
  { name: 'no match', chips: ['america'], region: 'eu', matches: false },
  { name: 'OR within chips', chips: ['america', 'europe'], region: 'eu', matches: true },
  { name: 'missing context', chips: ['europe'], region: undefined, matches: false },
  { name: 'unknown segment', chips: ['unknown'], region: 'eu', matches: false },
  { name: 'exact handle matching', chips: ['Europe'], region: 'eu', matches: false },
];
const planCases = [
  { name: 'no filter', targets: [], plan: 'free', matches: true },
  { name: 'matching plan', targets: ['free'], plan: 'free', matches: true },
  { name: 'different plan', targets: ['pro'], plan: 'free', matches: false },
  // Missing plan context is currently permissive in both paths.
  { name: 'missing plan context', targets: ['pro'], plan: undefined, matches: true },
];

describe.each([RuntimeMode.LocalOnly, RuntimeMode.Server])('placement explanation segments (%s)', (runtimeMode) => {
  for (const segment of segmentCases) {
    for (const plan of planCases) {
      it(`${segment.name}; ${plan.name}`, async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
        const config = RevTurbineConfigSchema.parse({
          version: '1.0.0', exported_at: '2026-09-17T00:00:00Z',
          plans: ['free', 'pro'].map((handle) => ({ id: handle, unique_handle: handle, name: handle })),
          entitlements: [], entitlement_rules: [], content_ui_paths: [], surface_templates: [],
          segments: [
            { handle: 'europe', name: 'Europe', predicates: [{ field: 'region', operator: 'eq', value: 'eu' }] },
            { handle: 'america', name: 'America', predicates: [{ field: 'region', operator: 'eq', value: 'us' }] },
          ],
          placements: [{
            id: 'offer', name: 'offer', category: 'fixed', order: 0,
            trigger: { type: 'surface_render', slot_id: 'offer_slot' },
            payloads: [{
              id: 'offer_payload', target: { plan_ids: plan.targets, segment_chips: segment.chips },
              surfaces: [{ template_id: 'banner_placement', fields: {}, ctas: [] }],
            }],
          }],
        });
        const sdk = new RevTurbineCustomerSdk({
          tenantId: 'explanation_segments', apiKey: 'local-only',
          endpoint: 'https://sdk.example.test', mode: 'snippet', runtimeMode,
          previewMode: true, anonymousTelemetry: false, analytics: false,
          contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
          ...(runtimeMode === RuntimeMode.LocalOnly
            ? { localRuntime: { playbook: config } }
            : { configProvider: { getExportedConfig: () => config } }),
        });
        try {
          await sdk.identify('user_1', {
            ...(plan.plan ? { plan_handle: plan.plan } : {}),
            ...(segment.region ? { custom: { region: segment.region } } : {}),
          });
          const placementId = await sdk.registerSurfaceSlot({
            id: 'offer_slot', name: 'offer', surfaceTemplateIds: ['banner_placement'],
          });
          const explanation = await sdk.explainPlacementDecision({ placementId, userId: 'user_1' });
          expect(explanation.eligiblePayloads).toHaveLength(1);
          const [payload] = explanation.eligiblePayloads;
          expect(payload.matchesSegment).toBe(segment.matches);
          expect(payload.matchesSegment).toBe(evaluateSegmentEligibility(
            { target_segment_chips: segment.chips },
            { segmentIds: explanation.targeting.segmentIds },
          ).eligible);
          expect(payload.matchesPlan).toBe(plan.matches);
          expect(payload.eligible).toBe(segment.matches && plan.matches);
          expect(Boolean(explanation.decision.output)).toBe(payload.eligible);
          expect(payload.selected).toBe(payload.eligible);
        } finally {
          sdk.dispose();
        }
      });
    }
  }
});
