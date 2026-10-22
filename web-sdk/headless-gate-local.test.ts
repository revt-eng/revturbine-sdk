/**
 * BL-0426 (3) and (4) — headless placement resolution in local mode.
 *
 * (4) `EntitlementGate` with `autoGate` resolved its upsell through
 * `getPlacement({ entitlementHandle })`, which names no slot, so in local mode
 * a denied gate never got its Access Gate placement (`<Gate>` did). It now
 * decides through the same gated surface slot `<Gate>` uses.
 *
 * (3) `SdkSession.getPlacementBySlotId` accepts `surfaceTemplateIds`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import { EntitlementGate, SdkSession } from './controllers';
import { DEFAULT_THEME } from './theme/defaults';
import type { RevTurbineConfig } from '@revt-eng/schema';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const gatePlacement = {
  id: 'pl_gate_sso',
  name: 'gate sso',
  category: 'gated',
  order: 0,
  trigger: { type: 'entitlement_gate', entitlement_handle: 'sso' },
  payloads: [{
    id: 'pay_gate_sso',
    target: { plan_ids: [], segment_chips: [] },
    surfaces: [{ template_id: 'inline_gate_message', fields: { header: 'SSO is a Pro feature', body: 'Upgrade' }, ctas: [] }],
  }],
};

const bannerPlacement = {
  id: 'pl_banner',
  name: 'banner',
  category: 'other_conversion',
  order: 0,
  trigger: { type: 'qualifier', qualifier: 'none_always_on' },
  payloads: [{
    id: 'pay_banner',
    target: { plan_ids: [], segment_chips: [] },
    surfaces: [{ template_id: 'banner_placement', fields: { header: 'Hello', body: 'Banner' }, ctas: [] }],
  }],
};

function playbook(): RevTurbineConfig {
  return {
    artifact_type: 'playbook',
    format_version: '1.0.0',
    playbook_handle: 'default',
    playbook_version_id: null,
    tenant_id: 't_1',
    environment_id: 'production',
    plans: [
      { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
      { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 1 },
    ],
    entitlements: [{ unique_handle: 'sso', name: 'SSO', type: 'feature' }],
    entitlement_rules: [
      { id: 'r_sso_pro', entitlement_id: 'sso', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], kind: 'feature', enabled: true },
    ],
    segments: [],
    content_ui_paths: [],
    placements: [gatePlacement, bannerPlacement],
  } as unknown as RevTurbineConfig;
}

function makeSdk(): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 't_1',
    publicKey: 'pub_test',
    runtimeMode: 'local_only',
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: playbook() },
  });
  sdk.identify('user_1', { plan_handle: 'free' });
  return sdk;
}

describe('BL-0426 (4): headless autoGate resolves the Access Gate placement in local mode', () => {
  it('a denied gate with autoGate gets its entitlement_gate placement', async () => {
    const gate = new EntitlementGate(makeSdk(), { handle: 'sso', autoGate: true });
    await gate.check();
    expect(gate.denied).toBe(true);
    expect(gate.gatedPlacement).not.toBeNull();
    expect(gate.gatedPlacement?.content).toMatchObject({ header: 'SSO is a Pro feature' });
  });

  it('an allowed gate resolves no placement', async () => {
    const sdk = makeSdk();
    sdk.identify('user_1', { plan_handle: 'pro' });
    const gate = new EntitlementGate(sdk, { handle: 'sso', autoGate: true });
    await gate.check();
    expect(gate.allowed).toBe(true);
    expect(gate.gatedPlacement).toBeNull();
  });

  it('a denied gate never borrows another entitlement\'s gate', async () => {
    const sdk = makeSdk();
    const gate = new EntitlementGate(sdk, { handle: 'not_in_playbook', autoGate: true });
    await gate.check();
    expect(gate.denied).toBe(true);
    expect(gate.gatedPlacement).toBeNull();
  });

  it('without autoGate nothing is resolved', async () => {
    const gate = new EntitlementGate(makeSdk(), { handle: 'sso' });
    await gate.check();
    expect(gate.gatedPlacement).toBeNull();
  });
});

describe('BL-0426 (3): getPlacementBySlotId takes surfaceTemplateIds', () => {
  it('a slot restricted to the banner template serves the banner', async () => {
    const session = new SdkSession(makeSdk(), DEFAULT_THEME);
    const decision = await session.getPlacementBySlotId('home_banner', { surfaceTemplateIds: ['banner_placement'] });
    expect(decision?.visible).toBe(true);
    expect(decision?.output?.content).toMatchObject({ header: 'Hello' });
  });

  it('a slot restricted to a template no placement uses serves nothing', async () => {
    const session = new SdkSession(makeSdk(), DEFAULT_THEME);
    const decision = await session.getPlacementBySlotId('home_toast', { surfaceTemplateIds: ['toast_message'] });
    expect(decision?.visible ?? false).toBe(false);
  });
});
