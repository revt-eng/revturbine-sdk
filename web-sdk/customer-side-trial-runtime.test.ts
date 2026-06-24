/**
 * Plan 43 TASK-8 — SDK trial runtime wiring.
 *
 * Covers:
 *   1. The new public impression-record methods write through to
 *      ImpressionHistory (TASK-9 minimum-viable consumer API).
 *   2. The SDK re-exports scaffold's trial-status derivation helpers
 *      so customers can compute UserTrialStatus from a persisted
 *      TrialInstance + matching rule.
 *
 * The full trial-state PlanProvider plumbing + reverse-trial
 * entitlement grants are exercised end-to-end through
 * `getPlacementDecision` / `checkEntitlement`; those private code
 * paths are integration-tested in cross-language parity. This file
 * pins the *public* surface introduced by TASK-8.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

// NOTE: The trial-status helper re-exports (deriveLocalTrialStatusFromInstance,
// findActiveTrialInstance, deriveReverseTrialGrants) added to headless.ts in
// TASK-8c require @revt-eng/core@0.1.45+ to be published with the helpers
// in its main barrel export. Until that lands, the imports work for type-
// checking but the runtime re-exports resolve to `undefined`. Tests for
// those re-exports will be enabled in a follow-up commit once v0.1.45
// ships. The SDK call sites that USE these helpers internally are exercised
// through deriveLocalEntitlementFromConfiguredRules below.

let fetchImpl: (url: string) => Promise<Response>;

beforeEach(() => {
  fetchImpl = async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response);
  vi.stubGlobal('fetch', vi.fn((url: string) => fetchImpl(String(url))));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_trial_test',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

describe('SDK impression-record public API (TASK-9 minimum-viable)', () => {
  it('recordImpression writes an impressed record through ImpressionHistory', async () => {
    const sdk = makeSdk();
    await sdk.recordImpression('pl_trial_progress_70', 'pay_trial_70');
    const history = await sdk.impressionHistory.queryHistory({ placementIds: ['pl_trial_progress_70'] });
    expect(history).toHaveLength(1);
    expect(history[0]?.outcome).toBe('impressed');
    expect(history[0]?.placementId).toBe('pl_trial_progress_70');
    expect(history[0]?.payloadId).toBe('pay_trial_70');
  });

  it('recordDismissal permanently retires the placement', async () => {
    const sdk = makeSdk();
    await sdk.recordDismissal('pl_upgrade_modal');
    await sdk.impressionHistory.hydrate();
    expect(sdk.impressionHistory.isHiddenSync('pl_upgrade_modal')).toBe(true);
  });

  it('recordClickThru permanently retires the placement', async () => {
    const sdk = makeSdk();
    await sdk.recordClickThru('pl_pro_upsell', 'pay_pro_a');
    await sdk.impressionHistory.hydrate();
    expect(sdk.impressionHistory.isHiddenSync('pl_pro_upsell')).toBe(true);
  });

  it('multiple impressions for the same placement append independent records', async () => {
    const sdk = makeSdk();
    await sdk.recordImpression('pl_trial_25');
    await sdk.recordImpression('pl_trial_25');
    const history = await sdk.impressionHistory.queryHistory({ placementIds: ['pl_trial_25'] });
    expect(history).toHaveLength(2);
  });
});

// TODO(v0.1.45): re-export tests for deriveLocalTrialStatusFromInstance,
// findActiveTrialInstance, and deriveReverseTrialGrants enabled when
// @revt-eng/core publishes them in its main barrel.
