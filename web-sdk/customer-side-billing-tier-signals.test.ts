/**
 * Plan 138 TASK-4 — user-context billing + tier signals reach provider state.
 *
 * `synthesizeProviderContext` maps the user context the customer sets into the
 * DomainProvider state the local placement resolver reads. This pins that
 * mapping for the plan-138 signals:
 *   - `payment_failed` / `payment_at_risk` → PlanProviderState (the Retention
 *     `qualifier` placement triggers read `paymentFailed` / `paymentAtRisk`);
 *   - `tiers` → EntitlementProviderState (the `entitlement_gate.tier_threshold`
 *     gate ranks the current tier against the entitlement's ladder).
 *
 * The downstream gating behavior is proven byte-for-byte in the cross-language
 * parity suite (tests/parity `placement_entitlement_gate_*` + `qualifier_*`);
 * this file pins the SDK-side field mapping those gates depend on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions, RevTurbineUserContext } from './customer-side';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' }) as unknown as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_signals_test',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

/** The provider-context shape `synthesizeProviderContext` returns (partial). */
interface SynthesizedContext {
  plan?: { paymentFailed?: boolean; paymentAtRisk?: boolean };
  entitlements?: { tiers?: Record<string, string> };
}

/** Set the user context, then read back the synthesized provider context. */
function synth(
  sdk: RevTurbineCustomerSdk,
  ctx: Partial<RevTurbineUserContext>,
): SynthesizedContext | undefined {
  sdk.setUserContext(ctx as RevTurbineUserContext);
  return (
    sdk as unknown as { synthesizeProviderContext(): SynthesizedContext | undefined }
  ).synthesizeProviderContext();
}

describe('web-SDK synthesizeProviderContext — plan-138 billing + tier signals', () => {
  it('threads tiers onto EntitlementProviderState (entitlement_gate.tier_threshold gate)', () => {
    const sdk = makeSdk();
    const ctx = synth(sdk, {
      id: 'u1',
      plan: { id: 'pro', name: 'Pro' },
      tiers: { branding: 'custom_branding' },
    });
    expect(ctx?.entitlements?.tiers).toEqual({ branding: 'custom_branding' });
  });

  it('threads payment_failed / payment_at_risk onto PlanProviderState (Retention qualifier)', () => {
    const sdk = makeSdk();
    const ctx = synth(sdk, {
      id: 'u1',
      plan: { id: 'pro', name: 'Pro' },
      payment_failed: true,
      payment_at_risk: false,
    });
    expect(ctx?.plan?.paymentFailed).toBe(true);
    expect(ctx?.plan?.paymentAtRisk).toBe(false);
  });

  it('omits the signals when the user context does not set them', () => {
    const sdk = makeSdk();
    const ctx = synth(sdk, { id: 'u1', plan: { id: 'pro', name: 'Pro' } });
    expect(ctx?.plan && 'paymentFailed' in ctx.plan).toBe(false);
    expect(ctx?.plan && 'paymentAtRisk' in ctx.plan).toBe(false);
    expect(ctx?.entitlements?.tiers).toBeUndefined();
  });

  it('builds EntitlementProviderState from tiers alone (no usage present)', () => {
    const sdk = makeSdk();
    const ctx = synth(sdk, {
      id: 'u1',
      plan: { id: 'pro', name: 'Pro' },
      tiers: { branding: 'white_label' },
    });
    expect(ctx?.entitlements?.tiers).toEqual({ branding: 'white_label' });
  });

  it('treats an empty tiers map as no tier signal', () => {
    const sdk = makeSdk();
    const ctx = synth(sdk, { id: 'u1', plan: { id: 'pro', name: 'Pro' }, tiers: {} });
    expect(ctx?.entitlements?.tiers).toBeUndefined();
  });
});
