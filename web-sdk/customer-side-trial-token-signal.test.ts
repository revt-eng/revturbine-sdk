/**
 * BL-0120 — `{{trial_days_remaining}}` stays raw when only
 * `initialData.trialStatus` is supplied (no `plan` / `plan_handle`).
 *
 * Root cause (confirmed against BL-0119's diagnosis): `synthesizeProviderContext()`
 * derived every trial field into `planTrialFields`, but two separate guards kept
 * trial-only integrations from ever seeing them:
 *   1. the early-return guard (`if (!plan && !planHandle && !usage && !hasTiers
 *      && !hasExperiments) return undefined`) omitted trial, so the whole
 *      provider context came back `undefined`;
 *   2. even past that guard, the returned `plan` key itself was gated on
 *      `plan || planHandle` — so without a commercial plan, `planTrialFields`
 *      (which carries `trialDaysRemaining`) was still dropped on the floor.
 *
 * `derivePlacementPersonalizationTokens()` (revturbine-scaffold
 * src/placements/controllers/token-derivation.ts:125-127) only sets
 * `tokens.trial_days_remaining` when `providers?.plan?.trialDaysRemaining` is
 * defined — so with `providers` (or `providers.plan`) undefined, the token
 * never derives and `{{trial_days_remaining}}` in placement copy renders raw,
 * exactly as reported for the CybeDefend demo (SDK 0.7.13).
 *
 * This file pins the fix at both altitudes: the raw `synthesizeProviderContext`
 * mapping (matching the style of `customer-side-billing-tier-signals.test.ts`),
 * and the customer-visible symptom — feeding the derived tokens through the
 * SDK's own `resolveContent` token-interpolation (`placements/registry.ts`)
 * the same way `PlacementRenderer` / `SurfaceTypes` do at render time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions, RevTurbineUserContext } from './customer-side';
import { derivePlacementPersonalizationTokens } from './placements/token-derivation';
import { resolveContent } from './placements/registry';
import type { ResolvedProviderContext } from '@revt-eng/core';

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
    tenantId: 'tenant_trial_token_test',
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
  plan?: { currentPlanHandle?: string; trialActive?: boolean; trialDaysRemaining?: number };
}

function synth(sdk: RevTurbineCustomerSdk): SynthesizedContext | undefined {
  return (
    sdk as unknown as { synthesizeProviderContext(): SynthesizedContext | undefined }
  ).synthesizeProviderContext();
}

/** Set only local trial data (no plan) via the local runtime's initialData path. */
function makeTrialOnlySdk(): RevTurbineCustomerSdk {
  return makeSdk({
    runtimeMode: 'local_only',
    localRuntime: {
      initialData: {
        trialStatus: { in_trial: true, days_remaining: 3 },
      },
    },
  });
}

describe('BL-0120 — synthesizeProviderContext threads trial-only local state', () => {
  it('returns a provider context (not undefined) when only trialStatus is supplied', () => {
    const sdk = makeTrialOnlySdk();
    const ctx = synth(sdk);
    expect(ctx).not.toBeUndefined();
  });

  it('carries trialDaysRemaining onto PlanProviderState with no plan/plan_handle present', () => {
    const sdk = makeTrialOnlySdk();
    const ctx = synth(sdk);
    expect(ctx?.plan?.trialActive).toBe(true);
    expect(ctx?.plan?.trialDaysRemaining).toBe(3);
  });

  it('end-to-end: {{trial_days_remaining}} resolves to "3" via derivePlacementPersonalizationTokens + resolveContent', () => {
    const sdk = makeTrialOnlySdk();
    const providers = synth(sdk) as ResolvedProviderContext | undefined;
    const tokens = derivePlacementPersonalizationTokens({ providers });

    expect(tokens.trial_days_remaining).toBe(3);

    const resolved = resolveContent(
      { body: 'Your trial ends in {{trial_days_remaining}} days.' },
      tokens,
    );
    expect(resolved.body).toBe('Your trial ends in 3 days.');
  });

  it('positive control: trial + plan supplied together still resolves (no regression)', () => {
    const sdk = makeSdk({
      runtimeMode: 'local_only',
      localRuntime: {
        initialData: {
          trialStatus: { in_trial: true, days_remaining: 5 },
        },
      },
    });
    sdk.setUserContext({ id: 'u1', plan: { handle: 'pro', name: 'Pro' } } as RevTurbineUserContext);

    const providers = synth(sdk) as ResolvedProviderContext | undefined;
    expect(providers?.plan?.currentPlanHandle).toBe('pro');
    const tokens = derivePlacementPersonalizationTokens({ providers });
    expect(tokens.trial_days_remaining).toBe(5);

    const resolved = resolveContent(
      { body: '{{trial_days_remaining}} days left on {{plan_name}}.' },
      tokens,
    );
    expect(resolved.body).toBe('5 days left on Pro.');
  });

  it('negative control: no trial data at all leaves the token absent, not 0', () => {
    const sdk = makeSdk();
    // No plan, no usage entries, no tiers, no experiments, no trial:
    // localTrialStatus stays at its untouched default ({ in_trial: false }),
    // which must NOT be mistaken for an explicitly-supplied trial. (The SDK
    // seeds `userContext.usage` to `{}` at init — an empty, not absent, map —
    // so `ctx.plan` is the field to assert absent, not `ctx` itself.)
    const ctx = synth(sdk) as ResolvedProviderContext | undefined;
    expect(ctx?.plan).toBeUndefined();

    const tokens = derivePlacementPersonalizationTokens({ providers: ctx });
    expect(tokens.trial_days_remaining).toBeUndefined();

    const resolved = resolveContent(
      { body: 'Your trial ends in {{trial_days_remaining}} days.' },
      tokens,
    );
    // Unresolved token stays literal — never coerced to "0".
    expect(resolved.body).toBe('Your trial ends in {{trial_days_remaining}} days.');
  });

  it('sibling check: usage supplied alone (no plan) already threaded through — unaffected by this fix', () => {
    const sdk = makeSdk();
    sdk.setUserContext({
      id: 'u1',
      usage: { api_calls: { amount: 10, limit: 100 } },
    } as unknown as RevTurbineUserContext);
    const ctx = synth(sdk) as ResolvedProviderContext | undefined;
    expect(ctx).not.toBeUndefined();
    expect(ctx?.entitlements?.usage?.api_calls).toBeDefined();
  });
});
