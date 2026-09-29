/**
 * Plan 282 TASK-9 (REQ-5; research §6.2) — `sdk.checkoutMetadata(outputId)`.
 *
 * The Checkout Session is created by the customer's server; this is the bag it
 * passes as `metadata` and `subscription_data.metadata`, plus the session's
 * `client_reference_id`. Every key must come from something the SDK holds for
 * the output — nothing minted — and a value the SDK does not hold must be
 * ABSENT: Stripe reads an empty metadata value as an unset, and an invented id
 * would turn confirmed credit (AC-7) into a lie.
 *
 * Plan: docs/dev-lifecycle/inprogress/282-control-center-real-data-attribution-proof.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacementOutput } from '@revt-eng/core';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import { FALLBACK_ACCOUNT_ID_PREFIX } from './account-identity';
import { redactIdentityField } from './pii-redact';

const SLOT = 'slot_upgrade';
const OUTPUT_ID = 'payload_upgrade';
const USER = 'user_checkout';

function upgradeOutput(over: Partial<PlacementOutput> = {}): PlacementOutput {
  return {
    output_id: OUTPUT_ID,
    rule_id: 'rule_upgrade',
    decision_id: 'dec_upgrade',
    config_version: 'v1',
    category: 'upsell',
    surface: { type: 'banner', template: 'banner_placement', slot_id: SLOT },
    content: { header: 'Upgrade to Pro', cta_label: 'See plans' },
    cta_path: { type: 'navigate_to_plans', plan_handle: 'pro' },
    present_upsell: true,
    ...over,
  };
}

/**
 * A local-only SDK whose resolver hands back `output` for `SLOT`, so the
 * decision path indexes it exactly as production does — the helper reads the
 * index, never the decision object.
 */
function makeSdk(opts: { user?: RevTurbineInitOptions['user']; output?: PlacementOutput } = {}): RevTurbineCustomerSdk {
  const output = opts.output ?? upgradeOutput();
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_282',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...(opts.user ? { user: opts.user } : {}),
    localRuntime: {
      resolvers: {
        getPlacementDecision: async (input: { placementId: string }) => ({
          placementId: input.placementId,
          requestId: 'rid_282',
          visible: true,
          decisionSource: 'local' as const,
          reasonCodes: [],
          content: output.content,
          output,
        }),
      },
    },
  });
  // Seed the registry with the literal slot id so `getPlacementDecision`
  // addresses it, as `convert-reloads-user-context.test.ts` does.
  (sdk as unknown as { placements: Map<string, unknown> }).placements
    .set(SLOT, { id: SLOT, name: SLOT, route: '/' });
  return sdk;
}

async function decide(sdk: RevTurbineCustomerSdk): Promise<string> {
  const decision = await sdk.getPlacementDecision({ placementId: SLOT, userId: USER });
  return String(decision.output?.output_id);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('checkoutMetadata(outputId) — every key sourced from the decision the SDK indexed', () => {
  it('returns the §6.2 bag and the client_reference_id for an output this SDK decided', async () => {
    const sdk = makeSdk({ user: { id: USER, account_id: 'acct_9', plan_handle: 'free' } });
    const outputId = await decide(sdk);

    expect(sdk.checkoutMetadata(outputId)).toEqual({
      client_reference_id: USER,
      metadata: {
        revturbine_user_id: USER,
        revturbine_account_id: 'acct_9',
        revturbine_placement_id: SLOT,
        revturbine_decision_id: 'dec_upgrade',
        revturbine_output_id: OUTPUT_ID,
        revturbine_rule_id: 'rule_upgrade',
        revturbine_plan_handle: 'pro',
      },
    });
  });

  it('is Stripe-shaped: every value a non-empty string, no null or undefined slots', async () => {
    const sdk = makeSdk({ user: { id: USER, account_id: 'acct_9' } });
    const result = sdk.checkoutMetadata(await decide(sdk));

    expect(result).not.toBeNull();
    for (const [key, value] of Object.entries(result!.metadata)) {
      expect(typeof value, `${key} must be a string Stripe accepts as metadata`).toBe('string');
      expect((value as string).length, `${key} must not be empty`).toBeGreaterThan(0);
    }
  });

  it('is null for an output no decision from this SDK produced — nothing is invented', async () => {
    const sdk = makeSdk({ user: { id: USER } });
    await decide(sdk);

    expect(sdk.checkoutMetadata('out_never_decided')).toBeNull();
  });

  it('omits the account rather than sending the user-derived fallback', async () => {
    const sdk = makeSdk({ user: { id: USER } });
    const result = sdk.checkoutMetadata(await decide(sdk));

    expect(result!.metadata).not.toHaveProperty('revturbine_account_id');
    // The interaction lane labels a missing account `user-fallback:<id>` so the
    // warehouse can exclude it; Stripe metadata is read as truth, so it gets
    // no such row at all.
    expect(JSON.stringify(result)).not.toContain(FALLBACK_ACCOUNT_ID_PREFIX);
  });

  it('omits the user id and client_reference_id for a user identify() never named', async () => {
    const sdk = makeSdk();
    const result = sdk.checkoutMetadata(await decide(sdk));

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('client_reference_id');
    expect(result!.metadata).not.toHaveProperty('revturbine_user_id');
    // The placement-side keys are still what the decision held.
    expect(result!.metadata.revturbine_placement_id).toBe(SLOT);
    expect(result!.metadata.revturbine_output_id).toBe(OUTPUT_ID);
  });

  it('omits the plan handle when the CTA names none', async () => {
    const sdk = makeSdk({
      user: { id: USER },
      output: upgradeOutput({ cta_path: { type: 'navigate_to_plans' } }),
    });
    const result = sdk.checkoutMetadata(await decide(sdk));

    expect(result!.metadata).not.toHaveProperty('revturbine_plan_handle');
    expect(result!.metadata.revturbine_rule_id).toBe('rule_upgrade');
  });

  it('carries the user id the way the SDK’s own telemetry does — an email-shaped id is hashed identically', async () => {
    const email = 'buyer@example.com';
    const sdk = makeSdk({ user: { id: email } });
    const result = sdk.checkoutMetadata(await decide(sdk));

    const wire = redactIdentityField(email);
    expect(wire.redacted).toBe(true);
    expect(result!.client_reference_id).toBe(wire.value);
    expect(result!.metadata.revturbine_user_id).toBe(wire.value);
    expect(JSON.stringify(result)).not.toContain('@');
  });
});
