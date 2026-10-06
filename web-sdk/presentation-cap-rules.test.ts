/**
 * D-59 (Kent, 2026-10-06) / BL-0536 — caps run BEFORE the pick, and the
 * Playbook's overall presentation cap rules + session cooldown are enforced.
 *
 * - A capped winner yields to the next-ranked candidate instead of blanking
 *   the slot, on a fresh resolve and on a decision-cache hit.
 * - `placement_settings[].global_frequency_cap.capRules` caps discretionary
 *   placements per template / slot; `sessionCooldownMinutes` spaces any two
 *   discretionary presentations in one session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const nudge = (id: string, order: number, header: string, caps: Record<string, unknown> = {}) => ({
  id,
  name: id,
  category: 'other_conversion',
  order,
  trigger: {},
  payloads: [{
    id: `${id}_p0`,
    target: { plan_ids: [], segment_chips: [] },
    surfaces: [{ template_id: 'banner_placement', fields: { header, body: '' }, ctas: [] }],
    caps,
  }],
});

function playbook(placements: unknown[], capRules: unknown[] = [], sessionCooldownMinutes = 0) {
  return {
    artifact_type: 'playbook',
    format_version: '1.0.0',
    playbook_handle: 'default',
    playbook_version_id: null,
    tenant_id: 'tenant_caps',
    environment_id: 'production',
    plans: [],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    placements,
    placement_settings: [{
      handle: 'default',
      global_frequency_cap: { capRules, sessionCooldownMinutes, testMode: 'off' },
    }],
  };
}

async function sdkWithSlot(config: ReturnType<typeof playbook>) {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_caps',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'production',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: config as never },
  });
  const placementId = await sdk.registerSurfaceSlot({
    id: 'slot_home',
    name: 'slot_home',
    surfaceTemplateIds: ['banner_placement'],
  });
  return { sdk, placementId };
}

describe('D-59 — caps before the pick', () => {
  it('a per-payload-capped winner yields to the next candidate on the next decision', async () => {
    const { sdk, placementId } = await sdkWithSlot(playbook([
      nudge('pl_a', 0, 'A', { max_per_period: { count: 1, period: 'day' } }),
      nudge('pl_b', 1, 'B'),
    ]));
    const first = await sdk.getPlacementDecision({ placementId, userId: 'u1' });
    expect(first.visible).toBe(true);
    expect(first.content.header).toBe('A');
    const second = await sdk.getPlacementDecision({ placementId, userId: 'u1' });
    expect(second.visible).toBe(true);
    expect(second.content.header).toBe('B');
  });
});

describe('D-59 — overall presentation cap rules', () => {
  it('a template rule caps every discretionary candidate it covers', async () => {
    const { sdk, placementId } = await sdkWithSlot(playbook(
      [nudge('pl_a', 0, 'A'), nudge('pl_b', 1, 'B')],
      [{ id: 'cap_banner', group: [{ kind: 'template', id: 'banner-placement' }], cap: { count: 1, period: 'day' } }],
    ));
    expect((await sdk.getPlacementDecision({ placementId, userId: 'u1' })).visible).toBe(true);
    const second = await sdk.getPlacementDecision({ placementId, userId: 'u1' });
    expect(second.visible).toBe(false);
    expect(second.reasonCodes).toContain('suppressed_by_presentation_cap');
  });

  it('a slot rule caps only that slot', async () => {
    const { sdk, placementId } = await sdkWithSlot(playbook(
      [nudge('pl_a', 0, 'A')],
      [{ id: 'cap_other_slot', group: [{ kind: 'slot', id: 'slot_elsewhere' }], cap: { count: 1, period: 'session' } }],
    ));
    expect((await sdk.getPlacementDecision({ placementId, userId: 'u1' })).visible).toBe(true);
    expect((await sdk.getPlacementDecision({ placementId, userId: 'u1' })).visible).toBe(true);
  });

  it('the session cooldown spaces discretionary presentations', async () => {
    const { sdk, placementId } = await sdkWithSlot(playbook([nudge('pl_a', 0, 'A'), nudge('pl_b', 1, 'B')], [], 30));
    expect((await sdk.getPlacementDecision({ placementId, userId: 'u1' })).visible).toBe(true);
    const second = await sdk.getPlacementDecision({ placementId, userId: 'u1' });
    expect(second.visible).toBe(false);
    expect(second.reasonCodes).toContain('suppressed_by_system_cooldown');
  });

  it('usage alerts are exempt from the overall rules', async () => {
    const alert = {
      ...nudge('pl_alert', 0, 'Alert'),
      category: 'usage_credit_seat',
    };
    const { sdk, placementId } = await sdkWithSlot(playbook(
      [alert],
      [{ id: 'cap_banner', group: [{ kind: 'template', id: 'banner_placement' }], cap: { count: 1, period: 'day' } }],
      30,
    ));
    expect((await sdk.getPlacementDecision({ placementId, userId: 'u1' })).visible).toBe(true);
    expect((await sdk.getPlacementDecision({ placementId, userId: 'u1' })).visible).toBe(true);
  });
});
