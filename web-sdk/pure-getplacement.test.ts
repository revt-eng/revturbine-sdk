/**
 * D-39 / BL-0379 — `getPlacement` is a pure function of (user context,
 * Playbook). It returns exactly what `getPlacementDecision` and the server
 * runtimes (`LocalRuntime.getPlacement`, mirrored by py/rs) return for the
 * same inputs; a changed user context changes the answer; pre-decided
 * outputs are never consulted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalRuntime, createStaticProviders } from '@revt-eng/core';
import { RevTurbineCustomerSdk } from './customer-side';
import type { ConfigArtifact, PlacementOutput } from './customer-side';

const SLOT = 'home_banner';
const banner = (id: string, category: string, order: number, trigger: Record<string, unknown>, header: string) => ({
  id, name: id, category, order, trigger,
  payloads: [{ id: `${id}_p0`, target: { plan_ids: [], segment_chips: [] },
    surfaces: [{ template_id: 'banner_placement', fields: { header, body: '' }, ctas: [] }] }],
});
const PLAYBOOK = {
  artifact_type: 'playbook', format_version: '1.0.0', playbook_handle: 'default',
  playbook_version_id: null, tenant_id: 't', environment_id: 'production',
  plans: [{ unique_handle: 'free', name: 'Free' }],
  entitlements: [{ unique_handle: 'api_calls', name: 'API calls', type: 'usage_limit' }],
  entitlement_rules: [], segments: [], content_ui_paths: [],
  placement_slots: [{ id: SLOT, label: 'Home', surface_type: 'banner', placement_handle: SLOT, template: 'banner_placement' }],
  placements: [
    banner('pl_nudge', 'other_conversion', 0, {}, 'Try Pro'),
    banner('pl_limit', 'usage_credit_seat', 0, { type: 'usage_threshold', entitlement_handle: 'api_calls', threshold_percent: 100 }, 'API limit reached'),
  ],
} as unknown as ConfigArtifact;

function sdk(used: number, extra: Record<string, unknown> = {}) {
  const instance = new RevTurbineCustomerSdk({
    tenantId: 't', apiKey: 'local', endpoint: 'https://edge.example.com', mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: PLAYBOOK, ...extra },
  } as never);
  instance.setUserContext({ id: 'u1', plan: { handle: 'free', name: 'Free' }, usage: { api_calls: { entitlement_handle: 'api_calls', unit: 'calls', amount: used, limit: 100 } } } as never);
  return instance;
}

async function serverAnswer(used: number): Promise<PlacementOutput | null> {
  const runtime = new LocalRuntime({
    tenantId: 't', userId: 'u1', playbook: PLAYBOOK as never,
    providers: createStaticProviders({ config: PLAYBOOK as never, planHandle: 'free', usage: { api_calls: { used, limit: 100 } } }),
  });
  const decision = await runtime.getPlacement({ slotId: SLOT });
  return decision?.visible ? (decision.output as PlacementOutput) : null;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BL-0379 — getPlacement is a pure function of (user context, Playbook)', () => {
  it('matches the server runtime for the same inputs', async () => {
    for (const used of [10, 100]) {
      const browser = await sdk(used).getPlacement({ slotId: SLOT });
      const server = await serverAnswer(used);
      expect(browser?.rule_id).toBe(server?.rule_id);
      expect(browser?.content.header).toBe(server?.content.header);
    }
  });

  it('reflects the current user context on every call (no stale lane)', async () => {
    const instance = sdk(10);
    expect((await instance.getPlacement({ slotId: SLOT }))?.rule_id).toBe('pl_nudge');
    instance.setUserContext({ id: 'u1', plan: { handle: 'free', name: 'Free' }, usage: { api_calls: { entitlement_handle: 'api_calls', unit: 'calls', amount: 100, limit: 100 } } } as never);
    expect((await instance.getPlacement({ slotId: SLOT }))?.rule_id).toBe('pl_limit');
  });

  it('ignores pre-decided outputs and warns that the option is deprecated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seeded = { output_id: 'seeded', rule_id: 'seeded_rule', decision_id: 'd', config_version: 'v',
      category: 'fixed', surface: { type: 'banner', template: 'banner_placement', slot_id: SLOT }, content: { header: 'Seeded' },
      cta_path: {}, present_upsell: false };
    const instance = sdk(10, { initialData: { placementsByLookupKey: { [`${SLOT}::banner::::::`]: seeded } } });
    expect((await instance.getPlacement({ slotId: SLOT }))?.rule_id).toBe('pl_nudge');
    expect(warn.mock.calls.some(([m]) => String(m).includes('placementsByLookupKey is deprecated'))).toBe(true);
  });
});
