/** Plan 176 — app-owned server mutations dispatched from authored CTAs. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RevTurbineCustomerSdk,
  type RevTurbineInitOptions,
  type ServerActionHandler,
} from './customer-side';
import type { PlacementOutput } from '@revt-eng/core';
import type { RevTurbineConfig } from '@revt-eng/schema';
import { parseUiPath } from './placements/registry';
import {
  dispatchCtaClick,
  getDefaultCtaResolverRegistry,
  registerCtaResolver,
  resetDefaultCtaResolverRegistry,
} from './placements/cta-resolvers';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
});

afterEach(() => {
  resetDefaultCtaResolverRegistry();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeSdk(handler: ServerActionHandler, over: Partial<RevTurbineInitOptions> = {}) {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_server_actions',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    localRuntime: { exportedConfig: config() },
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    user: { id: 'user_1', plan_handle: 'free' },
    serverActions: { extend_trial: handler },
    ...over,
  });
}

function config(): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [
      { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
      { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 0 },
    ],
    entitlements: [{ unique_handle: 'advanced_export', name: 'Advanced export', type: 'feature' }],
    entitlement_rules: [{
      id: 'rule_pro_export',
      entitlement_id: 'advanced_export',
      targets: [{ kind: 'plan', id: 'pro' }],
      segment_ids: [],
      type_fields: { kind: 'feature' },
    }],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

function placement(): PlacementOutput {
  return {
    output_id: 'out_1',
    rule_id: 'rule_1',
    decision_id: 'decision_1',
    config_version: 'v1',
    category: 'trials',
    surface: { type: 'modal', slot_id: 'trial_modal' },
    content: {},
    cta_path: { type: 'extend_trial', extension_days: 7 },
    present_upsell: true,
  };
}

function click(value = placement()): boolean {
  const uiPath = parseUiPath(value.cta_path ?? {});
  return dispatchCtaClick(uiPath, { placement: value, kind: 'primary' }, getDefaultCtaResolverRegistry());
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('RevTurbineInitOptions.serverActions', () => {
  it('dispatches extend_trial, applies returned context, and re-evaluates can()', async () => {
    const handler = vi.fn<ServerActionHandler>().mockResolvedValue({
      success: true,
      userContext: { plan_handle: 'pro', trial: { in_trial: true, days_remaining: 7 } },
    });
    const sdk = makeSdk(handler);
    expect((await sdk.can('advanced_export')).allowed).toBe(false);
    expect(click()).toBe(true);
    await settle();

    expect(handler).toHaveBeenCalledWith({
      placement: expect.objectContaining({ output_id: 'out_1' }),
      actionType: 'extend_trial',
      params: { extension_days: 7 },
    });
    expect((await sdk.can('advanced_export')).allowed).toBe(true);
  });

  it('tracks success on the canonical placement_interaction event', async () => {
    const sdk = makeSdk(async () => ({ success: true }));
    const emitted = vi.spyOn(sdk, 'emitSemantic').mockResolvedValue(undefined);
    click();
    await settle();
    expect(emitted).toHaveBeenCalledWith('placement_interaction', expect.objectContaining({
      interaction_type: 'cta_clicked',
      action_type: 'extend_trial',
      action_success: true,
      action_outcome: 'success',
    }), { immediate: false });
  });

  it('leaves context unchanged and tracks a reported failure', async () => {
    const sdk = makeSdk(async () => ({ success: false, userContext: { plan_handle: 'pro' } }));
    const emitted = vi.spyOn(sdk, 'emitSemantic').mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    click();
    await settle();
    expect((await sdk.can('advanced_export')).allowed).toBe(false);
    expect(emitted).toHaveBeenCalledWith('placement_interaction', expect.objectContaining({
      action_success: false,
      action_outcome: 'failure',
    }), { immediate: false });
  });

  it('contains a rejected handler, logs it, and leaves context unchanged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sdk = makeSdk(async () => { throw new Error('backend unavailable'); });
    const emitted = vi.spyOn(sdk, 'emitSemantic').mockResolvedValue(undefined);
    expect(() => click()).not.toThrow();
    await settle();
    expect((await sdk.can('advanced_export')).allowed).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('serverActions.extend_trial'), expect.any(Error));
    expect(emitted).toHaveBeenCalledWith('placement_interaction', expect.objectContaining({ action_outcome: 'rejected' }), { immediate: false });
  });

  it('keeps uiPathResolvers and explicit resolver precedence', async () => {
    const serverAction = vi.fn<ServerActionHandler>().mockResolvedValue({ success: true });
    const uiResolver = vi.fn();
    makeSdk(serverAction, { uiPathResolvers: { extend_trial: uiResolver } });
    click();
    await settle();
    expect(uiResolver).toHaveBeenCalledOnce();
    expect(serverAction).not.toHaveBeenCalled();

    resetDefaultCtaResolverRegistry();
    const explicit = vi.fn();
    registerCtaResolver('extend_trial', explicit);
    makeSdk(serverAction);
    click();
    await settle();
    expect(explicit).toHaveBeenCalledOnce();
    expect(serverAction).not.toHaveBeenCalled();
  });

  it('dispose unregisters only its own server-action resolver', async () => {
    const handler = vi.fn<ServerActionHandler>().mockResolvedValue({ success: true });
    const sdk = makeSdk(handler);
    sdk.dispose();
    expect(click()).toBe(false);
    await settle();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects empty keys and non-function handlers at init', () => {
    expect(() => makeSdk(async () => ({ success: true }), { serverActions: { ' ': async () => ({ success: true }) } })).toThrow('empty action type');
    expect(() => makeSdk(async () => ({ success: true }), { serverActions: { extend_trial: null as never } })).toThrow('non-function handler');
  });
});
