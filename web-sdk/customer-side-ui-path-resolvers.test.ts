import { describe, expect, it } from 'vitest';
import {
  RevTurbineCustomerSdk,
  defineUiPathResolvers,
  type RevTurbineUiPathResolverMap,
} from './customer-side';
import type { AnyDomainProvider } from './providers/types';
import type { RevTurbineConfig } from '@revt-eng/schema';

/**
 * Coverage for the `uiPathResolvers` validation surface — the init-time guard
 * (`assertUiPathResolverCoverageOrThrow`), the public `validateUiPathResolvers`
 * report API, and the `defineUiPathResolvers` / `sanitizeUiPathResolverMap`
 * authoring helpers. The CTA resolver *registry* (a different mechanism) is
 * covered by `placements/cta-resolvers.test.ts`; this file does not touch it.
 *
 * Plan: docs/dev-lifecycle/inprogress/105-ui-path-resolver-test-coverage.md
 */

const noop = (): void => {};

/** A raw `content_ui_paths` entry — kept raw (not schema-parsed) so `id` survives. */
type RawUiPath = Record<string, unknown>;

function makeConfig(contentUiPaths: RawUiPath[]): RevTurbineConfig {
  return {
    version: 'v1',
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
  domainProviders?: AnyDomainProvider[],
): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_ui_paths',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { exportedConfig: makeConfig(contentUiPaths) },
    ...(uiPathResolvers ? { uiPathResolvers } : {}),
    ...(domainProviders ? { domainProviders } : {}),
  });
}

/** A `domain: 'cta'` provider exposing handlers keyed by action_type. */
function ctaProvider(handlerKeys: string[]): AnyDomainProvider {
  const handlers: Record<string, () => void> = {};
  for (const key of handlerKeys) handlers[key] = noop;
  return {
    domain: 'cta' as const,
    resolve: () => ({ handlers }),
  } as unknown as AnyDomainProvider;
}

const CHECKOUT: RawUiPath = { id: 'u1', name: 'checkout', action_type: 'open_checkout_modal' };
const PLANS: RawUiPath = { id: 'u2', name: 'plans', action_type: 'navigate_to_plans' };

describe('validateUiPathResolvers()', () => {
  it('reports full coverage as valid with correct counts', async () => {
    const sdk = makeSdk([CHECKOUT, PLANS], {
      open_checkout_modal: noop,
      navigate_to_plans: noop,
    });
    const report = await sdk.validateUiPathResolvers();
    expect(report.valid).toBe(true);
    expect(report.totalUiPaths).toBe(2);
    expect(report.resolvedUiPaths).toBe(2);
    expect(report.issues).toEqual([]);
  });

  it('flags an uncovered action_type as a missing_resolver issue carrying id/name', async () => {
    // Empty config so construction needs no resolvers; validate an explicit uiPath.
    const sdk = makeSdk([]);
    const report = await sdk.validateUiPathResolvers({ uiPaths: [CHECKOUT] as never });
    expect(report.valid).toBe(false);
    expect(report.totalUiPaths).toBe(1);
    expect(report.resolvedUiPaths).toBe(0);
    expect(report.issues).toEqual([
      {
        actionType: 'open_checkout_modal',
        reason: 'missing_resolver',
        uiPathId: 'u1',
        name: 'checkout',
      },
    ]);
  });

  it('flags an entry with no action_type as a missing_action_type issue', async () => {
    const sdk = makeSdk([]);
    const report = await sdk.validateUiPathResolvers({
      uiPaths: [{ id: 'u9', name: 'broken' }] as never,
    });
    expect(report.valid).toBe(false);
    expect(report.issues).toEqual([
      { actionType: 'unknown', reason: 'missing_action_type', uiPathId: 'u9', name: 'broken' },
    ]);
  });

  it('honors per-call options.resolvers', async () => {
    const sdk = makeSdk([]);
    const report = await sdk.validateUiPathResolvers({
      uiPaths: [{ action_type: 'foo' }] as never,
      resolvers: { foo: noop },
    });
    expect(report.valid).toBe(true);
    expect(report.resolvedUiPaths).toBe(1);
  });

  it('honors options.uiPaths over the exported config content_ui_paths', async () => {
    // Config is fully covered, but the explicit override is not.
    const sdk = makeSdk([CHECKOUT], { open_checkout_modal: noop });
    const report = await sdk.validateUiPathResolvers({
      uiPaths: [{ action_type: 'contact_sales' }] as never,
    });
    expect(report.totalUiPaths).toBe(1);
    expect(report.valid).toBe(false);
    expect(report.issues[0]?.actionType).toBe('contact_sales');
  });

  it('counts domain:cta provider handlers when includeProviderHandlers is on, ignores them when off', async () => {
    const sdk = makeSdk([], undefined, [ctaProvider(['open_checkout_modal'])]);

    const withProviders = await sdk.validateUiPathResolvers({ uiPaths: [CHECKOUT] as never });
    expect(withProviders.valid).toBe(true);
    expect(withProviders.resolvedUiPaths).toBe(1);

    const withoutProviders = await sdk.validateUiPathResolvers({
      uiPaths: [CHECKOUT] as never,
      includeProviderHandlers: false,
    });
    expect(withoutProviders.valid).toBe(false);
    expect(withoutProviders.issues[0]?.reason).toBe('missing_resolver');
  });

  it('throws naming the missing action_type when throwOnMissing is set', async () => {
    const sdk = makeSdk([]);
    await expect(
      sdk.validateUiPathResolvers({
        uiPaths: [{ action_type: 'contact_sales' }] as never,
        throwOnMissing: true,
      }),
    ).rejects.toThrow(/contact_sales/);
  });
});

describe('SDK init-time uiPathResolver coverage guard', () => {
  it('throws when a content_ui_paths action_type has no resolver', () => {
    expect(() => makeSdk([CHECKOUT])).toThrow(/open_checkout_modal/);
  });

  it('throws when a content_ui_paths entry has a blank action_type', () => {
    expect(() => makeSdk([{ id: 'u3', name: 'broken', action_type: '   ' }])).toThrow(
      /missing action_type/,
    );
  });

  it('constructs when every action_type is covered', () => {
    expect(() =>
      makeSdk([CHECKOUT, PLANS], { open_checkout_modal: noop, navigate_to_plans: noop }),
    ).not.toThrow();
  });

  it('constructs with empty content_ui_paths and no resolvers', () => {
    // Exercises sanitizeUiPathResolverMap(undefined) -> {} and the empty-paths short-circuit.
    expect(() => makeSdk([])).not.toThrow();
  });
});

describe('defineUiPathResolvers() / sanitizeUiPathResolverMap()', () => {
  it('returns a map containing every supplied resolver', () => {
    const map = defineUiPathResolvers([{ action_type: 'foo' }] as const, { foo: noop });
    expect(Object.keys(map)).toEqual(['foo']);
    expect(typeof map.foo).toBe('function');
  });

  it('trims whitespace from action_type keys', () => {
    const map = defineUiPathResolvers([] as const, { ' foo ': noop });
    expect(Object.keys(map)).toEqual(['foo']);
  });

  it('throws on an empty/whitespace action_type key', () => {
    expect(() => defineUiPathResolvers([] as const, { '   ': noop })).toThrow(/empty action_type/);
  });

  it('throws on a non-function resolver value', async () => {
    // Routed through validateUiPathResolvers(options.resolvers), which sanitizes the map.
    const sdk = makeSdk([]);
    await expect(
      sdk.validateUiPathResolvers({
        resolvers: { foo: 123 } as unknown as RevTurbineUiPathResolverMap,
      }),
    ).rejects.toThrow(/non-function resolver/);
  });
});
