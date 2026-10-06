/**
 * Plan 45 TASK-5 / AC-6 — `fixedOnly` SDK config wiring.
 *
 * Pins the contract: when `rt.getPlacement({ slotId, fixedOnly: true })`
 * is called against a mixed (Fixed + Conversion) candidate set for the
 * same slot, the resolver returns the Fixed candidate. When no Fixed
 * candidate matches, returns null even if other categories do match.
 *
 * D-39 / BL-0379: `getPlacement` is a pure function of (user context,
 * Playbook), so the candidates are AUTHORED in a Playbook and resolved
 * through the decision path — not seeded as pre-decided outputs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { ConfigArtifact } from './customer-side';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const SLOT_ID = 'header_upgrade';

const placement = (id: string, category: string, order: number, trigger: Record<string, unknown>) => ({
  id,
  name: id,
  category,
  order,
  trigger,
  payloads: [{
    id: `${id}_p0`,
    target: { plan_ids: [], segment_chips: [] },
    surfaces: [{ template_id: 'banner_placement', fields: { header: id, body: '' }, ctas: [] }],
  }],
});
const fixed = placement('out_fixed', 'fixed', 0, { type: 'surface_render', slot_id: SLOT_ID });
const conversion = placement('out_conv', 'other_conversion', 0, {});
const retention = placement('out_ret', 'retention', 1, {});

function makeLocalSdk(placements: unknown[]): RevTurbineCustomerSdk {
  const playbook = {
    artifact_type: 'playbook', format_version: '1.0.0', playbook_handle: 'default',
    playbook_version_id: null, tenant_id: 'tenant_fixed_only', environment_id: 'production',
    plans: [], entitlements: [], entitlement_rules: [], segments: [], content_ui_paths: [],
    placement_slots: [{ id: SLOT_ID, label: 'Header', surface_type: 'banner', placement_handle: SLOT_ID, template: 'banner_placement' }],
    placements,
  } as unknown as ConfigArtifact;
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_fixed_only',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook },
  });
}

const idOf = (output: { rule_id?: string | null } | null) => output?.rule_id ?? null;

describe('rt.getPlacement({ fixedOnly: true })', () => {
  it('AC-6: returns the Fixed candidate from a mixed (Fixed + Conversion) set', async () => {
    const sdk = makeLocalSdk([fixed, conversion]);
    const result = await sdk.getPlacement({ slotId: SLOT_ID, componentType: 'banner', fixedOnly: true });
    expect(idOf(result)).toBe('out_fixed');
  });

  it('AC-6: returns null when no Fixed candidate matches, even with other categories present', async () => {
    const sdk = makeLocalSdk([conversion, retention]);
    const result = await sdk.getPlacement({ slotId: SLOT_ID, surfaceType: 'banner', fixedOnly: true });
    expect(result).toBeNull();
  });

  it('without fixedOnly: Fixed beats Conversion (category first, D-59)', async () => {
    const sdk = makeLocalSdk([conversion, fixed]);
    const result = await sdk.getPlacement({ slotId: SLOT_ID, surfaceType: 'banner' });
    expect(idOf(result)).toBe('out_fixed');
  });

  it('keeps surfaceType as an alias and gives componentType precedence', async () => {
    const sdk = makeLocalSdk([fixed]);
    const alias = await sdk.getPlacement({ slotId: SLOT_ID, surfaceType: 'banner' });
    const canonical = await sdk.getPlacement({ slotId: SLOT_ID, componentType: 'banner', surfaceType: 'modal' });
    expect(idOf(alias)).toBe('out_fixed');
    expect(idOf(canonical)).toBe('out_fixed');
  });
});
