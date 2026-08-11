/**
 * Plan 174 TASK-1 (F-70) — init-supplied `uiPathResolvers` drive runtime CTA
 * dispatch.
 *
 * Before this change the init map was read only by init-time validation while
 * runtime dispatch consulted a separate `CtaResolverRegistry` nothing wired the
 * init options into — resolvers supplied exactly as documented produced
 * buttons that tracked the click and did nothing. These tests pin the bridge:
 * constructing the SDK registers the init map into the default registry that
 * `PlacementRenderer` dispatches through (AC-1 — note: no `registerCtaResolver`
 * call in the core scenario's setup), explicit registrations keep precedence
 * in both orders, `dispose()` removes exactly the bridged entries, and a
 * rejected async resolver is contained.
 *
 * Plan: docs/dev-lifecycle/inprogress/174-spec-check-remediation-batch.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RevTurbineCustomerSdk,
  type RevTurbineUiPathResolverMap,
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
  vi.clearAllMocks();
});

/** A raw `content_ui_paths` entry — kept raw (not schema-parsed) so `id` survives. */
type RawUiPath = Record<string, unknown>;

function makeConfig(contentUiPaths: RawUiPath[]): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: contentUiPaths,
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

function makeSdk(
  contentUiPaths: RawUiPath[],
  uiPathResolvers?: RevTurbineUiPathResolverMap,
): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_ui_path_dispatch',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { exportedConfig: makeConfig(contentUiPaths) },
    ...(uiPathResolvers ? { uiPathResolvers } : {}),
  });
}

const CHECKOUT: RawUiPath = { id: 'u1', name: 'checkout', action_type: 'open_checkout_modal' };

function makePlacement(ctaPath: Record<string, unknown>): PlacementOutput {
  return {
    output_id: 'out_1',
    rule_id: 'rule_1',
    decision_id: 'dec_1',
    config_version: 'v1',
    category: 'fixed',
    surface: { type: 'modal', template: 'modal_overlay', slot_id: 'slot_1' },
    content: {},
    cta_path: ctaPath,
    present_upsell: true,
  };
}

/** Mirror `PlacementRenderer.handleCtaClick` — the real dispatch path. */
function clickCta(placement: PlacementOutput): boolean {
  const uiPath = parseUiPath(placement.cta_path ?? placement.ui_path ?? {});
  return dispatchCtaClick(uiPath, { placement, kind: 'primary' }, getDefaultCtaResolverRegistry());
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('init uiPathResolvers → CTA dispatch bridge (AC-1)', () => {
  it('a CTA click invokes the init-supplied resolver with the raw authored cta_path record', async () => {
    const resolver = vi.fn();
    makeSdk([CHECKOUT], { open_checkout_modal: resolver });

    const handled = clickCta(
      makePlacement({ type: 'open_checkout_modal', plan_handle: 'pro' }),
    );
    await flushMicrotasks();

    expect(handled).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith({ type: 'open_checkout_modal', plan_handle: 'pro' });
  });

  it('an action type with no init resolver still falls through to the fallback', () => {
    makeSdk([CHECKOUT], { open_checkout_modal: vi.fn() });
    const fallback = vi.fn();

    const placement = makePlacement({ type: 'contact_sales' });
    const uiPath = parseUiPath(placement.cta_path ?? {});
    const handled = dispatchCtaClick(
      uiPath,
      { placement, kind: 'primary' },
      getDefaultCtaResolverRegistry(),
      fallback,
    );

    expect(handled).toBe(false);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('an explicit registerCtaResolver() made before init keeps precedence over the init map', async () => {
    const explicit = vi.fn();
    const fromInit = vi.fn();
    registerCtaResolver('open_checkout_modal', explicit);
    makeSdk([CHECKOUT], { open_checkout_modal: fromInit });

    clickCta(makePlacement({ type: 'open_checkout_modal' }));
    await flushMicrotasks();

    expect(explicit).toHaveBeenCalledTimes(1);
    expect(fromInit).not.toHaveBeenCalled();
  });

  it('an explicit registerCtaResolver() made after init replaces the bridged entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const explicit = vi.fn();
    const fromInit = vi.fn();
    makeSdk([CHECKOUT], { open_checkout_modal: fromInit });
    registerCtaResolver('open_checkout_modal', explicit);

    clickCta(makePlacement({ type: 'open_checkout_modal' }));
    await flushMicrotasks();

    expect(explicit).toHaveBeenCalledTimes(1);
    expect(fromInit).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('dispose() removes the bridged entries so dispatch falls back again', async () => {
    const fromInit = vi.fn();
    const sdk = makeSdk([CHECKOUT], { open_checkout_modal: fromInit });
    sdk.dispose();

    const handled = clickCta(makePlacement({ type: 'open_checkout_modal' }));
    await flushMicrotasks();

    expect(handled).toBe(false);
    expect(fromInit).not.toHaveBeenCalled();
  });

  it('dispose() leaves a customer replacement registered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const explicit = vi.fn();
    const sdk = makeSdk([CHECKOUT], { open_checkout_modal: vi.fn() });
    registerCtaResolver('open_checkout_modal', explicit);
    sdk.dispose();

    const handled = clickCta(makePlacement({ type: 'open_checkout_modal' }));
    await flushMicrotasks();

    expect(handled).toBe(true);
    expect(explicit).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('an authored snooze CTA dispatches to the built-in remind-later resolver (plan 174 TASK-6 / Q-5)', async () => {
    const snooze = vi
      .spyOn(RevTurbineCustomerSdk.prototype, 'snooze')
      .mockImplementation(async () => {});
    makeSdk([CHECKOUT], { open_checkout_modal: vi.fn() });

    const handled = clickCta(makePlacement({ type: 'snooze' }));
    await flushMicrotasks();

    expect(handled).toBe(true);
    expect(snooze).toHaveBeenCalledWith('out_1', undefined);
    snooze.mockRestore();
  });

  it('a payload-authored remind_later_minutes window rides into the snooze call as seconds', async () => {
    const snooze = vi
      .spyOn(RevTurbineCustomerSdk.prototype, 'snooze')
      .mockImplementation(async () => {});
    makeSdk([CHECKOUT], { open_checkout_modal: vi.fn() });

    const placement = makePlacement({ type: 'snooze' });
    (placement as unknown as Record<string, unknown>).remind_later_minutes = 45; // sdk-ok: boundary-parse — test fixture extra field
    clickCta(placement);
    await flushMicrotasks();

    expect(snooze).toHaveBeenCalledWith('out_1', 2700);
    snooze.mockRestore();
  });

  it('a customer snooze resolver in the init map wins over the built-in', async () => {
    const snooze = vi
      .spyOn(RevTurbineCustomerSdk.prototype, 'snooze')
      .mockImplementation(async () => {});
    const custom = vi.fn();
    makeSdk([CHECKOUT], { open_checkout_modal: vi.fn(), snooze: custom });

    clickCta(makePlacement({ type: 'snooze' }));
    await flushMicrotasks();

    expect(custom).toHaveBeenCalledTimes(1);
    expect(snooze).not.toHaveBeenCalled();
    snooze.mockRestore();
  });

  it('dispose() removes the built-in snooze resolver', async () => {
    const snooze = vi
      .spyOn(RevTurbineCustomerSdk.prototype, 'snooze')
      .mockImplementation(async () => {});
    const sdk = makeSdk([CHECKOUT], { open_checkout_modal: vi.fn() });
    sdk.dispose();

    const handled = clickCta(makePlacement({ type: 'snooze' }));
    await flushMicrotasks();

    expect(handled).toBe(false);
    expect(snooze).not.toHaveBeenCalled();
    snooze.mockRestore();
  });

  it('a rejected async resolver is logged, not thrown into the click handler', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    makeSdk([CHECKOUT], {
      open_checkout_modal: () => Promise.reject(new Error('resolver exploded')),
    });

    expect(() => clickCta(makePlacement({ type: 'open_checkout_modal' }))).not.toThrow();
    await flushMicrotasks();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('uiPathResolvers.open_checkout_modal'),
      expect.any(Error),
    );
    error.mockRestore();
  });
});
