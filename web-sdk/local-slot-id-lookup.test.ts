/**
 * BL-0119 — local-mode placement lookup by SLOT ID.
 *
 * Reported from the CybeDefend demo on SDK 0.7.13: in `local_only` mode,
 * looking up a placement by its slot id returns `null` (with or without the
 * component type), and the controller's slot path resolves to
 * `placement_not_found`. Looking the same placement up by NAME works.
 *
 * The distinction matters because `placement_slots[]` is the authored registry
 * of surfaces: a slot declares its `id`, `surface_type` and `template`, and a
 * placement targets it through `trigger.slot_id`. Scaffold's headless
 * `LocalRuntime` resolves that registry (`slotRecordForConfig`), but the
 * browser SDK never consulted it — `registerSurfaceSlot` built a record with no
 * `surface_template_ids`, which drops the shared resolver into its
 * direct-lookup branch. That branch is keyed by placement NAME/ID only, which
 * is exactly why by-name worked and by-slot-id did not.
 *
 * The by-name assertions below are the positive control: they must keep
 * passing, or the fix has moved the bug rather than removed it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

const SLOT_ID = 'slot_upgrade_banner';
const PLACEMENT_ID = 'pl_cybedefend_upgrade_banner';
const PLACEMENT_NAME = 'cybedefend_upgrade_banner';
/** A built-in template id, so the fixture needs no `surface_templates` entry. */
const TEMPLATE_ID = 'banner_placement';

function playbook(): Record<string, unknown> {
  return {
    artifact_type: 'playbook',
    format_version: '1.0.0',
    playbook_handle: 'default',
    playbook_version_id: null,
    tenant_id: 'tenant_bl0119',
    environment_id: 'production',
    plans: [],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    // The authored surface registry the report says was declared.
    placement_slots: [
      {
        id: SLOT_ID,
        label: 'Upgrade banner',
        description: 'Inline upgrade banner on the scan results page',
        surface_type: 'banner',
        template: TEMPLATE_ID,
        placement_handle: PLACEMENT_NAME,
      },
    ],
    placements: [
      {
        id: PLACEMENT_ID,
        category: 'fixed',
        order: 0,
        trigger: { slot_id: SLOT_ID },
        payloads: [
          {
            id: 'payload_upgrade_banner',
            status: 'active',
            surfaces: [
              {
                template_id: TEMPLATE_ID,
                fields: { header: 'Upgrade', body: 'Unlock more scans' },
                ctas: [{ label: 'See plans', path: 'open_checkout', config: {} }],
              },
            ],
            target: { plan_ids: [], segment_chips: [] },
          },
        ],
      },
    ],
  };
}

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_bl0119',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'production',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    user: { id: 'user_1' },
    localRuntime: { playbook: playbook() },
    ...over,
  } as unknown as RevTurbineInitOptions);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('BL-0119 — getPlacement() by slot id in local_only mode', () => {
  it('resolves a placement_slots-declared slot by slot id alone', async () => {
    const sdk = makeSdk();

    const output = await sdk.getPlacement({ slotId: SLOT_ID });

    expect(output).not.toBeNull();
    // `surface.slot_id` carries the PLACEMENT id, not the trigger slot id —
    // the shared resolver sets it from `entry.id` for every port, so assert on
    // the identity that actually distinguishes the resolved placement.
    expect(output?.rule_id).toBe(PLACEMENT_ID);
    expect(output?.surface.template).toBe(TEMPLATE_ID);
  });

  it('resolves it with the component type supplied too', async () => {
    const sdk = makeSdk();

    const output = await sdk.getPlacement({ slotId: SLOT_ID, componentType: 'banner' });

    expect(output).not.toBeNull();
    expect(output?.rule_id).toBe(PLACEMENT_ID);
  });

  it('resolves by component type alone when no slot id is given', async () => {
    // Parity with scaffold's `LocalRuntime.slotRecordForConfig`, which falls
    // back to matching the slot's `surface_type`.
    const sdk = makeSdk();

    const output = await sdk.getPlacement({ componentType: 'banner' });

    expect(output?.rule_id).toBe(PLACEMENT_ID);
  });

  it('positive control: by-name lookup keeps working', async () => {
    const sdk = makeSdk();

    const placementId = await sdk.registerSurfaceSlot({ id: PLACEMENT_NAME, name: PLACEMENT_NAME });
    const decision = await sdk.getPlacementDecision({ placementId, userId: 'user_1' });

    expect(decision.reasonCodes ?? []).not.toContain('placement_not_found');
    expect(decision.visible).toBe(true);
  });

  it('returns null for a slot id no placement_slots entry declares', async () => {
    const sdk = makeSdk();

    expect(await sdk.getPlacement({ slotId: 'slot_does_not_exist' })).toBeNull();
  });
});

describe('BL-0119 — controller slot lookup in local_only mode', () => {
  it('does not report placement_not_found for a declared slot', async () => {
    const sdk = makeSdk();

    const placementId = await sdk.registerSurfaceSlot({ id: SLOT_ID, name: SLOT_ID });
    const decision = await sdk.getPlacementDecision({ placementId, userId: 'user_1' });

    expect(decision.reasonCodes ?? []).not.toContain('placement_not_found');
    expect(decision.visible).toBe(true);
  });

  it('adopts the declared surface template so the slot branch runs', async () => {
    // The mechanism behind the fix, asserted directly: registering a slot the
    // Playbook declares must carry that slot's template into the record, or the
    // shared resolver silently falls back to name-keyed direct lookup.
    const sdk = makeSdk();
    await sdk.registerSurfaceSlot({ id: SLOT_ID, name: SLOT_ID });

    const [slot] = sdk.getRegisteredSlots();
    expect(slot.slotId).toBe(SLOT_ID);
    expect(slot.surfaceTemplateIds).toEqual([TEMPLATE_ID]);
  });

  it('does not invent a template for an undeclared slot', async () => {
    const sdk = makeSdk();
    await sdk.registerSurfaceSlot({ id: 'slot_unknown', name: 'slot_unknown' });

    const [slot] = sdk.getRegisteredSlots();
    expect(slot.surfaceTemplateIds).toEqual([]);
  });

  it('an explicitly-passed surfaceTemplateIds still wins', async () => {
    const sdk = makeSdk();
    await sdk.registerSurfaceSlot({
      id: SLOT_ID,
      name: SLOT_ID,
      surfaceTemplateIds: ['modal_overlay'],
    });

    expect(sdk.getRegisteredSlots()[0].surfaceTemplateIds).toEqual(['modal_overlay']);
  });
});
