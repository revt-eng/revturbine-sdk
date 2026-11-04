/**
 * ST-1447 (BUG-1192) — one CTA vocabulary.
 *
 * The engine now delivers a placement CTA with the type exactly as authored
 * (`open_checkout`, `view_plans`). A resolver registered under the authored
 * name runs; the legacy names `open_checkout_modal` and `navigate_to_plans`
 * stay accepted as registrations, deprecated, with a one-time warning.
 * `validateUiPathResolvers()` covers authored CTA paths as well as
 * `content_ui_paths`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RevTurbineConfig } from '@revt-eng/schema';
import { RevTurbineCustomerSdk } from './customer-side';
import {
  CtaResolverRegistry,
  canonicalCtaActionType,
  dispatchCtaClick,
  getDefaultCtaResolverRegistry,
  resetDefaultCtaResolverRegistry,
  resetLegacyCtaActionWarnings,
} from './placements/cta-resolvers';
import type { CtaResolverContext, PlacementUiPath } from './placements/types';

const noop = (): void => {};

const context = { placement: { output_id: 'out_1' } } as unknown as CtaResolverContext;

beforeEach(() => {
  resetLegacyCtaActionWarnings();
  resetDefaultCtaResolverRegistry();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDefaultCtaResolverRegistry();
});

describe('CtaResolverRegistry vocabulary', () => {
  it('maps the legacy names onto the authored names and leaves everything else alone', () => {
    expect(canonicalCtaActionType('open_checkout_modal')).toBe('open_checkout');
    expect(canonicalCtaActionType('navigate_to_plans')).toBe('view_plans');
    expect(canonicalCtaActionType('open_checkout')).toBe('open_checkout');
    expect(canonicalCtaActionType('connect_crm')).toBe('connect_crm');
    expect(canonicalCtaActionType('toString')).toBe('toString');
  });

  it('dispatches an authored open_checkout / view_plans CTA to a resolver registered under that name', () => {
    const registry = new CtaResolverRegistry();
    const checkout = vi.fn();
    const plans = vi.fn();
    registry.register('open_checkout', checkout);
    registry.register('view_plans', plans);

    const handledCheckout = dispatchCtaClick({ type: 'open_checkout', plan_handle: 'pro' }, context, registry);
    const handledPlans = dispatchCtaClick({ type: 'view_plans' }, context, registry);

    expect(handledCheckout).toBe(true);
    expect(handledPlans).toBe(true);
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(plans).toHaveBeenCalledTimes(1);
  });

  it('still runs a resolver registered under a legacy name when the CTA arrives as authored, with one deprecation warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new CtaResolverRegistry();
    const checkout = vi.fn();
    registry.register('open_checkout_modal', checkout);
    registry.register('navigate_to_plans', noop);

    const uiPath: PlacementUiPath = { type: 'open_checkout', plan_handle: 'pro' };
    expect(dispatchCtaClick(uiPath, context, registry)).toBe(true);
    expect(checkout).toHaveBeenCalledWith(uiPath, context);
    expect(registry.has('open_checkout_modal')).toBe(true);
    expect(registry.has('view_plans')).toBe(true);

    const deprecations = warn.mock.calls.filter(([message]) => String(message).includes('deprecated'));
    expect(deprecations).toHaveLength(2);
    expect(String(deprecations[0]?.[0])).toContain('open_checkout_modal');
    expect(String(deprecations[0]?.[0])).toContain('"open_checkout"');
    expect(String(deprecations[1]?.[0])).toContain('navigate_to_plans');
  });

  it('warns about a legacy name once, however often it is registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = new CtaResolverRegistry();
    const second = new CtaResolverRegistry();
    first.register('open_checkout_modal', noop);
    second.register('open_checkout_modal', noop);
    first.unregister('open_checkout_modal');
    first.register('open_checkout_modal', noop);

    const deprecations = warn.mock.calls.filter(([message]) => String(message).includes('deprecated'));
    expect(deprecations).toHaveLength(1);
  });

  it('does not warn when the authored names are registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new CtaResolverRegistry();
    registry.register('open_checkout', noop);
    registry.register('view_plans', noop);
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats the legacy and authored names as one entry: the later registration replaces the earlier', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new CtaResolverRegistry();
    const legacy = vi.fn();
    const authored = vi.fn();
    registry.register('open_checkout_modal', legacy);
    registry.register('open_checkout', authored);

    dispatchCtaClick({ type: 'open_checkout' }, context, registry);
    expect(authored).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(registry.unregister('open_checkout_modal')).toBe(true);
    expect(registry.has('open_checkout')).toBe(false);
  });
});

function makeConfig(ctaPaths: string[]): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [
      {
        id: 'pl_upgrade',
        payloads: [
          {
            id: 'payload_1',
            surfaces: [{ template_id: 'banner_upgrade', ctas: ctaPaths.map((path) => ({ label: path, path })) }],
          },
        ],
      },
    ],
  } as unknown as RevTurbineConfig;
}

function makeSdk(
  ctaPaths: string[],
  uiPathResolvers?: Record<string, () => void>,
): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_cta_paths',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    user: { id: 'user_1' },
    localRuntime: { playbook: makeConfig(ctaPaths) },
    ...(uiPathResolvers ? { uiPathResolvers } : {}),
  });
}

describe('validateUiPathResolvers() over authored CTA paths', () => {
  it('flags an authored CTA path with no resolver, naming the placement', async () => {
    const sdk = makeSdk(['open_checkout', 'view_plans']);
    const report = await sdk.validateUiPathResolvers();

    expect(report.valid).toBe(false);
    expect(report.totalCtaPaths).toBe(2);
    expect(report.resolvedCtaPaths).toBe(0);
    expect(report.issues).toEqual([
      { actionType: 'open_checkout', reason: 'missing_resolver', source: 'cta_path', placementId: 'pl_upgrade' },
      { actionType: 'view_plans', reason: 'missing_resolver', source: 'cta_path', placementId: 'pl_upgrade' },
    ]);
    sdk.dispose();
  });

  it('is satisfied by the authored names, and by the deprecated names', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const authored = makeSdk(['open_checkout', 'view_plans'], { open_checkout: noop, view_plans: noop });
    const legacy = makeSdk(['open_checkout', 'view_plans'], {
      open_checkout_modal: noop,
      navigate_to_plans: noop,
    });

    for (const sdk of [authored, legacy]) {
      const report = await sdk.validateUiPathResolvers();
      expect(report.valid).toBe(true);
      expect(report.resolvedCtaPaths).toBe(2);
      sdk.dispose();
    }
  });

  it('counts per-call resolvers and explicit registerCtaResolver() entries, and leaves dismiss and snooze to the SDK', async () => {
    const sdk = makeSdk(['open_checkout', 'view_plans', 'dismiss', 'snooze']);
    getDefaultCtaResolverRegistry().register('view_plans', noop);

    const report = await sdk.validateUiPathResolvers({ resolvers: { open_checkout: noop } });
    expect(report.valid).toBe(true);
    expect(report.totalCtaPaths).toBe(2);
    expect(report.resolvedCtaPaths).toBe(2);
    sdk.dispose();
  });

  it('throws naming the uncovered CTA path when throwOnMissing is set', async () => {
    const sdk = makeSdk(['view_plans']);
    await expect(sdk.validateUiPathResolvers({ throwOnMissing: true })).rejects.toThrow(/view_plans/);
    sdk.dispose();
  });
});
