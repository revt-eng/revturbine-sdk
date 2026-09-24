/**
 * Plan 233 TASK-10 / AC-12 — the slot-inventory probe.
 *
 * `verify-integration` names this gap in its own text:
 *
 *   "A placement targeting a slot no code renders **can never show**, and
 *    nothing reports this; there is no probe, so walk the Playbook's placement
 *    triggers against your inventory of rendered slots."
 *
 * There was no way to obtain that inventory. The registry is private and keyed
 * by a hashed id rather than by the slot id the author wrote, so even reaching
 * into it gave you something that could not be diffed against config.
 *
 * Both directions fail differently, and only one of them is silent:
 *
 *   authoredButUnmounted — the placement can never show. The decision path is
 *     never even asked about a slot nobody mounted, so there is no error, no
 *     warning, and no reason code. Nothing surfaces it. This is the one that
 *     cost the escalated integration weeks.
 *   mountedButUnauthored — the slot renders its fallback forever. Visible, but
 *     easy to mistake for "the user isn't eligible".
 *
 * The August diagnosis of that escalation concluded the fixed slots were not
 * mounted. They were mounted; the call sites passed slot ids no placement
 * targeted. A config-side audit cannot tell those apart, because it cannot see
 * call sites — which is exactly why this probe has to run in the live app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

function playbookWithSlots(slotIds: string[]): Record<string, unknown> {
  return {
    artifact_type: 'playbook',
    format_version: '1.0.0',
    playbook_handle: 'default',
    playbook_version_id: null,
    tenant_id: 'tenant_slots',
    environment_id: 'production',
    plans: [],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    placements: slotIds.map((slotId, index) => ({
      id: `pl_${slotId}`,
      category: 'conversion',
      order: index,
      // `trigger.slot_id` is the field the resolvers match against — server-python's
      // local_resolver compares it to the registered record's `surface_slot_id`.
      trigger: { slot_id: slotId },
      payloads: [],
    })),
  };
}

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_slots',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'production',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    user: { id: 'user_1' },
    ...over,
  } as unknown as RevTurbineInitOptions);
}

function makeSdkWithPlaybook(slotIds: string[]): RevTurbineCustomerSdk {
  return makeSdk({
    localRuntime: { playbook: playbookWithSlots(slotIds) },
  } as unknown as Partial<RevTurbineInitOptions>);
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

describe('AC-12 — getRegisteredSlots()', () => {
  it('returns every slot registered through registerSurfaceSlot', async () => {
    const sdk = makeSdk();
    await sdk.registerSurfaceSlot({ id: 'slot_a', name: 'Slot A' });
    await sdk.registerSurfaceSlot({ id: 'slot_b', name: 'Slot B' });

    const slots = sdk.getRegisteredSlots();
    expect(slots.map((slot) => slot.slotId).sort()).toEqual(['slot_a', 'slot_b']);
  });

  it('reports the AUTHOR-facing slot id, not the internal hash', async () => {
    // The load-bearing property. `registerSurfaceSlot` hashes the id before
    // storing it, so a probe that returned registry keys would produce a diff
    // in hash space — always "everything is unmounted", which is useless and
    // would look like a working probe finding a real problem.
    const sdk = makeSdk();
    await sdk.registerSurfaceSlot({ id: 'slot_paywall', name: 'Paywall' });

    const [slot] = sdk.getRegisteredSlots();
    expect(slot.slotId).toBe('slot_paywall');
    expect(slot.internalId).not.toBe('slot_paywall');
    expect(slot.internalId.length).toBeGreaterThan(0);
  });

  it('carries the declared surface template ids', async () => {
    const sdk = makeSdk();
    await sdk.registerSurfaceSlot({
      id: 'slot_modal',
      name: 'Modal',
      surfaceTemplateIds: ['modal_overlay'],
    });

    expect(sdk.getRegisteredSlots()[0].surfaceTemplateIds).toEqual(['modal_overlay']);
  });

  it('is empty before anything mounts', () => {
    expect(makeSdk().getRegisteredSlots()).toEqual([]);
  });

  it('reflects the deprecated registerPlacement alias too', async () => {
    // `registerPlacement` delegates to `registerSurfaceSlot`. A probe that
    // missed the legacy entry point would under-report mounted slots and
    // manufacture false `authoredButUnmounted` findings for integrations that
    // have not migrated.
    const sdk = makeSdk();
    await sdk.registerPlacement({ name: 'legacy_slot', placementScopeKey: 'slot_legacy' });

    expect(sdk.getRegisteredSlots().map((slot) => slot.slotId)).toContain('slot_legacy');
  });
});

describe('AC-12 — diagnoseSlotInventory() diffs both directions', () => {
  it('reports a placement whose slot nobody mounted', async () => {
    const sdk = makeSdkWithPlaybook(['slot_mounted', 'slot_forgotten']);
    await sdk.registerSurfaceSlot({ id: 'slot_mounted', name: 'Mounted' });

    const diagnosis = sdk.diagnoseSlotInventory();

    expect(diagnosis.authoredButUnmounted.map((entry) => entry.slotId)).toEqual(['slot_forgotten']);
    expect(diagnosis.mountedButUnauthored).toEqual([]);
  });

  it('reports a mounted slot no placement targets', async () => {
    const sdk = makeSdkWithPlaybook(['slot_authored']);
    await sdk.registerSurfaceSlot({ id: 'slot_authored', name: 'Authored' });
    await sdk.registerSurfaceSlot({ id: 'slot_typo', name: 'Typo' });

    const diagnosis = sdk.diagnoseSlotInventory();

    expect(diagnosis.mountedButUnauthored.map((slot) => slot.slotId)).toEqual(['slot_typo']);
    expect(diagnosis.authoredButUnmounted).toEqual([]);
  });

  it('reports both directions at once', async () => {
    // The escalated shape: some slots line up, one placement points at nothing,
    // and one mounted slot points at nothing. A probe that short-circuits on the
    // first finding would report only half of this.
    const sdk = makeSdkWithPlaybook(['slot_ok', 'slot_never_shows']);
    await sdk.registerSurfaceSlot({ id: 'slot_ok', name: 'OK' });
    await sdk.registerSurfaceSlot({ id: 'slot_ghost', name: 'Ghost' });

    const diagnosis = sdk.diagnoseSlotInventory();

    expect(diagnosis.authoredButUnmounted.map((entry) => entry.slotId)).toEqual(['slot_never_shows']);
    expect(diagnosis.mountedButUnauthored.map((slot) => slot.slotId)).toEqual(['slot_ghost']);
  });

  it('finds nothing when the inventory matches the Playbook', async () => {
    const sdk = makeSdkWithPlaybook(['slot_a', 'slot_b']);
    await sdk.registerSurfaceSlot({ id: 'slot_a', name: 'A' });
    await sdk.registerSurfaceSlot({ id: 'slot_b', name: 'B' });

    const diagnosis = sdk.diagnoseSlotInventory();

    expect(diagnosis.authoredButUnmounted).toEqual([]);
    expect(diagnosis.mountedButUnauthored).toEqual([]);
    expect(diagnosis.authored).toHaveLength(2);
    expect(diagnosis.mounted).toHaveLength(2);
  });

  it('carries the placement id so a finding is actionable', async () => {
    const sdk = makeSdkWithPlaybook(['slot_never_shows']);

    const [finding] = sdk.diagnoseSlotInventory().authoredButUnmounted;
    // "some placement targets a slot you did not mount" is not actionable;
    // naming which placement is.
    expect(finding.placementId).toBe('pl_slot_never_shows');
    expect(finding.category).toBe('conversion');
  });

  it('ignores placements that are not slot-targeted at all', async () => {
    // A placement with no `trigger.slot_id` is not slot-targeted, so it is not
    // "unmounted" — reporting it would be a false positive, and a probe that
    // cries wolf gets ignored.
    const playbook = playbookWithSlots(['slot_real']) as { placements: Array<Record<string, unknown>> };
    playbook.placements.push({
      id: 'pl_entitlement_driven',
      category: 'gated',
      order: 9,
      trigger: { entitlement_handle: 'feature_x' },
      payloads: [],
    });

    const sdk = makeSdk({ localRuntime: { playbook } } as unknown as Partial<RevTurbineInitOptions>);
    const diagnosis = sdk.diagnoseSlotInventory();

    expect(diagnosis.authored.map((entry) => entry.slotId)).toEqual(['slot_real']);
    expect(diagnosis.authoredButUnmounted.map((entry) => entry.placementId))
      .not.toContain('pl_entitlement_driven');
  });

  it('says a config was unavailable rather than implying nothing is authored', () => {
    // "no Playbook reached the SDK" and "the Playbook authors no slots" produce
    // the same empty list, and they mean opposite things. Collapsing them is the
    // failure shape this whole plan is about, so the flag is asserted directly.
    const diagnosis = makeSdk().diagnoseSlotInventory();

    expect(diagnosis.configAvailable).toBe(false);
    expect(diagnosis.authored).toEqual([]);

    const withConfig = makeSdkWithPlaybook([]).diagnoseSlotInventory();
    expect(withConfig.configAvailable).toBe(true);
    expect(withConfig.authored).toEqual([]);
  });
});
