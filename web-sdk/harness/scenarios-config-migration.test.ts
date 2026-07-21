import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStaticPlacementResolver,
  type RevTurbinePlacementRecord,
} from '@revt-eng/core';
import {
  BundleHandle,
  createBundlePlacementResolver,
  encodeBundle,
  lowerToIR,
} from '@revt-eng/core/bundle';
import { PlaybookSchema } from '@revt-eng/schema';
import { configArtifactForRuntime } from '../config-artifact';
import {
  buildDefaultContentOverrides,
  buildExportedConfig,
  buildLookupConfigKey,
  createLocalRuntimeData,
  DEFAULT_ENTITLEMENTS,
  DEFAULT_ENTITLEMENT_RULES,
  DEFAULT_PLANS,
  DEFAULT_SEGMENTS,
  DEFAULT_SLOT_TRIGGERS,
  DEFAULT_THEME,
  HARNESS_LOCALSTATE_STORAGE_KEY,
  HARNESS_SLOTS,
  loadExportedConfig,
  loadHarnessLocalState,
  saveHarnessLocalState,
  type HarnessSlotDescriptor,
} from './scenarios';

const BODY = {
  plans: [],
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
};

const SLOT: HarnessSlotDescriptor = HARNESS_SLOTS[0];

function canonicalHarnessPlaybook(slots: HarnessSlotDescriptor[] = [SLOT]) {
  const contentOverrides = buildDefaultContentOverrides(slots);
  if (contentOverrides[SLOT.id]) {
    contentOverrides[SLOT.id].title = 'Canonical block title';
    contentOverrides[SLOT.id].body = 'Canonical block body';
  }
  return buildExportedConfig({
    plans: DEFAULT_PLANS,
    entitlements: DEFAULT_ENTITLEMENTS,
    entitlementRules: DEFAULT_ENTITLEMENT_RULES,
    segments: DEFAULT_SEGMENTS,
    contentOverrides,
    theme: DEFAULT_THEME,
    slots,
  });
}

function normalizeDecision(output: {
  category: string;
  content: Record<string, unknown>;
  cta_path: Record<string, unknown>;
  surface: { template?: string; type: string };
} | null | undefined) {
  const content = Object.fromEntries(
    Object.entries(output?.content ?? {})
      .filter(([key]) => !key.startsWith('__'))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    visible: Boolean(output),
    category: output?.category,
    template: output?.surface.template,
    surfaceType: output?.surface.type,
    content,
    ctaPath: output?.cta_path,
  };
}

describe('harness Playbook projection migration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads equivalent legacy and canonical headers identically', () => {
    const legacy = loadExportedConfig({
      version: '1.0.0',
      ...BODY,
    });
    const canonical = loadExportedConfig({
      artifact_type: 'playbook',
      format_version: '1.0.0',
      playbook_handle: 'default',
      playbook_version_id: null,
      tenant_id: 'tenant_harness',
      environment_id: 'default',
      ...BODY,
    });

    expect(canonical).toEqual(legacy);
  });

  it('rejects unsupported future Playbook formats', () => {
    expect(() => loadExportedConfig({
      artifact_type: 'playbook',
      format_version: '2.0.0',
      playbook_handle: 'default',
      playbook_version_id: null,
      tenant_id: 'tenant_harness',
      environment_id: 'default',
      ...BODY,
    })).toThrow('unsupported "format_version"');
  });

  it('single-writes Message Block/Payload content and keeps placement_slots populated', () => {
    const playbook = canonicalHarnessPlaybook();

    expect(() => PlaybookSchema.parse(playbook)).not.toThrow();
    expect('slot_configs' in playbook).toBe(false);
    expect('content_overrides' in playbook).toBe(false);
    expect(playbook.placement_slots).toHaveLength(1);
    expect(playbook.plans[0]).not.toHaveProperty('id');
    expect(playbook.entitlement_rules[0]).toMatchObject({
      entitlement_id: 'api_calls',
      targets: [{ kind: 'plan', id: 'trial' }],
    });
    expect(playbook.message_blocks?.[0]?.default_content).toMatchObject({
      header: 'Canonical block title',
      body: 'Canonical block body',
      user_name: '{{user_name}}',
      plan_name: '{{plan_name}}',
      position: 'top',
      dismissible: 'true',
    });
    expect(playbook.placements[0]).toMatchObject({
      category: 'usage_credit_seat',
      payloads: [{
        surfaces: [{
          ctas: [{
            label: 'Upgrade plan',
            path: 'open_checkout',
            config: { purchase: 'pro' },
          }, {
            label: 'View limits',
            path: 'dismiss',
          }],
        }],
      }],
    });
    expect(playbook.placement_payloads?.[0]?.content_link?.message_block_id)
      .toBe(playbook.message_blocks?.[0]?.block_id);

    const loaded = loadExportedConfig(playbook);
    expect(loaded.contentOverrides[SLOT.id]).toMatchObject({
      title: 'Canonical block title',
      body: 'Canonical block body',
    });
    expect(loaded.legacyLocalState).toBeUndefined();
  });

  it('migrates legacy projection behavior with a development warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loaded = loadExportedConfig({
      version: '1.0.0',
      ...BODY,
      placement_slots: [{
        id: SLOT.id,
        label: SLOT.label,
        description: SLOT.description,
        surface_type: SLOT.surfaceType,
        placement_handle: SLOT.placementHandle,
        template: SLOT.template,
      }],
      slot_configs: [{ slot_id: SLOT.id, active: true, triggers: ['legacy_trigger'] }],
      content_overrides: {
        [SLOT.id]: { title: 'Legacy title', body: 'Legacy body' },
      },
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(loaded.legacyLocalState?.activeSlots[SLOT.id]).toBe(true);
    expect(loaded.legacyLocalState?.slotTriggers[SLOT.id]).toEqual(new Set(['legacy_trigger']));
    expect(loaded.contentOverrides[SLOT.id]).toMatchObject({
      title: 'Legacy title',
      body: 'Legacy body',
    });
  });

  it('persists activation and triggers under a non-Playbook local-state key', () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    const defaults = {
      activeSlots: { [SLOT.id]: false },
      slotTriggers: { [SLOT.id]: new Set(DEFAULT_SLOT_TRIGGERS[SLOT.id] ?? []) },
    };

    saveHarnessLocalState({
      activeSlots: { [SLOT.id]: true },
      slotTriggers: { [SLOT.id]: new Set(['local_trigger']) },
    });

    expect(stored.has(HARNESS_LOCALSTATE_STORAGE_KEY)).toBe(true);
    expect(loadHarnessLocalState(defaults)).toEqual({
      activeSlots: { [SLOT.id]: true },
      slotTriggers: { [SLOT.id]: new Set(['local_trigger']) },
    });
  });

  it('keeps raw Playbook, Bundle, and harness-runtime decisions equivalent', async () => {
    const playbook = canonicalHarnessPlaybook(HARNESS_SLOTS);
    const runtimeConfig = configArtifactForRuntime(playbook, 'parity fixture');
    if (!runtimeConfig) throw new Error('Expected a runtime config');

    const staticResolver = createStaticPlacementResolver({
      placements: { placements: runtimeConfig.placements ?? [] },
      exportedConfig: runtimeConfig,
    });
    const { ir, diagnostics } = lowerToIR(playbook, {
      tenantId: 'tenant_harness',
      clock: () => 0,
    });
    const handle = new BundleHandle(encodeBundle(ir));
    const bundleResolver = createBundlePlacementResolver({ handle });
    const context = {
      __providers: {
        plan: { currentPlanHandle: DEFAULT_PLANS[0].unique_handle, currentPlanName: DEFAULT_PLANS[0].name },
      },
    };
    const contentOverrides = buildDefaultContentOverrides(HARNESS_SLOTS);
    contentOverrides[SLOT.id].title = 'Canonical block title';
    contentOverrides[SLOT.id].body = 'Canonical block body';
    const runtimeData = createLocalRuntimeData(
      Object.fromEntries(HARNESS_SLOTS.map((slot) => [slot.id, true])),
      'user_harness_01',
      'Taylor Harness',
      DEFAULT_PLANS[0].unique_handle,
      [],
      HARNESS_SLOTS,
      [],
      contentOverrides,
    );

    expect(diagnostics.unresolved_placement_ids).toEqual([]);
    expect(ir.slot_configs).toEqual([]);
    expect(ir.content_override_keys).toEqual([]);
    expect(handle.slotsLength()).toBe(HARNESS_SLOTS.length);

    for (const slot of HARNESS_SLOTS) {
      const placement = runtimeConfig.placements?.find(
        (candidate) => candidate.trigger.type === 'surface_render' && candidate.trigger.slot_id === slot.id,
      );
      if (!placement) throw new Error(`Expected a canonical placement fixture for ${slot.id}`);

      const placementRecord: RevTurbinePlacementRecord = {
        id: placement.id,
        name: placement.name,
        route: placement.id,
        metadata: {
          surface_template_ids: [slot.template ?? ''],
          surface_slot_id: slot.id,
          surface_slot_category: 'fixed',
        },
      };
      const input = { placementId: placement.id, userId: 'user_harness_01' };
      const rawDecision = await staticResolver(input, placementRecord, context);
      const bundleDecision = await bundleResolver(input, placementRecord, context);
      const runtimeOutput = runtimeData.placementsByLookupKey?.[buildLookupConfigKey({
        slotId: slot.id,
        surfaceType: slot.surfaceType,
        placementHandle: slot.placementHandle,
        planHandle: DEFAULT_PLANS[0].unique_handle,
      })];

      expect(normalizeDecision(rawDecision.output), `raw/Bundle parity for ${slot.id}`)
        .toEqual(normalizeDecision(bundleDecision.output));
      expect(normalizeDecision(bundleDecision.output), `Bundle/harness parity for ${slot.id}`)
        .toEqual(normalizeDecision(runtimeOutput));
    }
  });
});
