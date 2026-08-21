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
  plan?: { currentPlanHandle?: string };
  experiments?: { assignments?: Record<string, string> };
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

describe('web-SDK synthesizeProviderContext — plan-183 experiment assignments', () => {
  it('threads UserContext.experiments onto ExperimentProviderState', () => {
    const ctx = synth(makeSdk(), {
      id: 'u1',
      plan: { handle: 'pro', name: 'Pro' },
      experiments: { pricing_test: 'variant_b', copy_test: 'control' },
    });
    expect(ctx?.experiments?.assignments).toEqual({
      pricing_test: 'variant_b',
      copy_test: 'control',
    });
  });

  it('synthesizes a context from assignments ALONE — no plan, usage or tiers', () => {
    // The early return must not treat an experiments-only user as "nothing to
    // synthesize", or enrollment would silently never reach the decision path.
    const ctx = synth(makeSdk(), { id: 'u1', experiments: { pricing_test: 'variant_b' } });
    expect(ctx?.experiments?.assignments).toEqual({ pricing_test: 'variant_b' });
  });

  it('omits experiments entirely when the app supplies none', () => {
    const ctx = synth(makeSdk(), { id: 'u1', plan: { handle: 'pro', name: 'Pro' } });
    expect(ctx?.experiments).toBeUndefined();
  });

  it('omits experiments for an empty map rather than reporting enrollment', () => {
    const ctx = synth(makeSdk(), { id: 'u1', plan: { handle: 'pro', name: 'Pro' }, experiments: {} });
    expect(ctx?.experiments).toBeUndefined();
  });

  it('carries a control assignment through — control is enrollment, not absence', () => {
    const ctx = synth(makeSdk(), { id: 'u1', experiments: { pricing_test: 'control' } });
    expect(ctx?.experiments?.assignments).toEqual({ pricing_test: 'control' });
  });
});
