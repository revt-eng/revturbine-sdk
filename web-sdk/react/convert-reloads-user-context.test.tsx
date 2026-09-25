/**
 * @vitest-environment jsdom
 *
 * BL-0004 — the React half: a mounted slot and a mounted gate both react to
 * `sdk.convert()`.
 *
 * Kent, 2026-09-25: *"Converting should trigger a reloading of UserContext with
 * the new plan/billing state the user has converted to."* Plan 236 TASK-13 had
 * recorded the opposite as a documented limitation — the converted placement
 * stayed on screen until the slot next happened to resolve a decision.
 *
 * These drive REAL components against a REAL `RevTurbineCustomerSdk`, for the
 * reason plan 233 TASK-16 gives: the interesting failures live in the wiring
 * between the hook, the controller and the SDK, and a mocked SDK asserts that
 * wiring against itself. The `useCan` leg is the counterpart of
 * `context-reactivity.test.tsx` with `convert()` as the trigger instead of
 * `update()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineCustomerSdk } from '../customer-side';
import { RevTurbineContext } from './useRevTurbine';
import { useCan } from './useCan';
import { usePlacement } from './usePlacement';
import type { PlacementOutput } from '@revt-eng/core';

const SLOT = 'slot_upgrade';
const USER = 'user_convert_react';

/**
 * `brand_kit` targets `pro`, so the gate is denied on `free` and granted the
 * moment the conversion moves the plan. `plans` is what lets the Playbook give
 * the converted handle its display name.
 */
const PLAYBOOK = {
  version: '1.0.0',
  plans: [
    { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
    { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 1 },
  ],
  entitlements: [{ unique_handle: 'brand_kit', name: 'Brand Kit', type: 'feature' }],
  entitlement_rules: [
    {
      id: 'r_brand',
      entitlement_id: 'brand_kit',
      targets: [{ kind: 'plan', id: 'pro' }],
      segment_ids: [],
      kind: 'feature',
      enabled: true,
    },
  ],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [],
};

function upgradeOutput(): PlacementOutput {
  return {
    output_id: 'payload_upgrade',
    rule_id: 'pl_upgrade',
    decision_id: 'dec_upgrade',
    config_version: 'v1',
    category: 'upsell',
    surface: { type: 'banner', template: 'banner_placement', slot_id: SLOT },
    content: { header: 'Upgrade to Pro', body: 'Unlock the dashboard', cta_label: 'Upgrade' },
    cta_path: { type: 'open_checkout_modal', plan_handle: 'pro' },
    ui_path: { type: 'open_checkout_modal', plan_handle: 'pro' },
    present_upsell: true,
  } as unknown as PlacementOutput;
}

function heldPlanHandle(sdk: RevTurbineCustomerSdk): string | undefined {
  return (sdk as unknown as { userContext: { plan_handle?: string } }).userContext.plan_handle;
}

function makeSdk(): RevTurbineCustomerSdk {
  let sdk: RevTurbineCustomerSdk;
  sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_bl0004_react',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: {
      playbook: PLAYBOOK as never,
      resolvers: {
        // Plan-dependent eligibility: the banner is for users not yet on `pro`.
        getPlacementDecision: async (input: { placementId: string }) => {
          const onPro = heldPlanHandle(sdk) === 'pro';
          return {
            placementId: input.placementId,
            requestId: `rid_${Math.random()}`,
            visible: !onPro,
            decisionSource: 'local' as const,
            reasonCodes: onPro ? ['plan_mismatch'] : [],
            content: onPro ? {} : { header: 'Upgrade to Pro', body: '', cta_label: 'Upgrade' },
            ...(onPro ? {} : { output: upgradeOutput() }),
          };
        },
      },
    },
  } as never);
  sdk.setUserContext({ id: USER, plan_handle: 'free' });
  (sdk as unknown as { placements: Map<string, unknown> }).placements
    .set(SLOT, { id: SLOT, name: SLOT, route: '/' });
  return sdk;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  });
}

async function mount(sdk: RevTurbineCustomerSdk, node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineContext.Provider
        value={{ sdk: sdk as never, isReady: true, error: '', setContext: () => {} }}
      >
        {node}
      </RevTurbineContext.Provider>,
    );
  });
  await settle();
}

const text = (testId: string): string | undefined =>
  container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? undefined;

/** A mounted slot that renders the placement and nothing else. */
function Banner({ onOutput }: { onOutput: (id: string) => void }): React.ReactElement {
  const { visible, content, decision } = usePlacement({ surfaceSlot: { id: SLOT, name: SLOT }, userId: USER });
  const outputId = decision?.output?.output_id;
  React.useEffect(() => {
    if (typeof outputId === 'string') onOutput(outputId);
  }, [outputId, onOutput]);
  return <span data-testid="banner">{visible ? String(content?.header ?? '') : ''}</span>;
}

describe('a mounted placement leaves the screen when the SDK convert path is used', () => {
  it('disappears in place — no remount, no host refresh(), no ctaComplete()', async () => {
    const sdk = makeSdk();
    let outputId = '';
    await mount(sdk, <Banner onOutput={(id) => { outputId = id; }} />);
    expect(text('banner')).toBe('Upgrade to Pro');
    expect(outputId).toBe('payload_upgrade');

    // The PUBLIC convert path, as a host calling it from its own checkout
    // callback would. This is what plan 236 TASK-13 said left the banner up.
    await act(async () => { await sdk.convert(outputId); });
    await settle();

    expect(heldPlanHandle(sdk)).toBe('pro');
    // The Playbook names the plan, so an optimistic move does not put a raw
    // handle in front of the user.
    expect(sdk.getUserContext().plan).toEqual({ handle: 'pro', name: 'Pro' });
    expect(text('banner')).toBe('');
  });

  it('keeps the placement when the conversion itself fails', async () => {
    const sdk = makeSdk();
    let outputId = '';
    await mount(sdk, <Banner onOutput={(id) => { outputId = id; }} />);
    expect(text('banner')).toBe('Upgrade to Pro');

    vi.spyOn(sdk, 'trackTreatmentInteraction').mockRejectedValue(new Error('network down'));
    await act(async () => {
      await expect(sdk.convert(outputId)).rejects.toThrow('network down');
    });
    await settle();

    // Fail-closed in the honest direction: nothing was recorded, so nothing is
    // claimed — the user still sees the offer and still holds `free`.
    expect(heldPlanHandle(sdk)).toBe('free');
    expect(text('banner')).toBe('Upgrade to Pro');
  });
});

describe('a mounted gate flips after the SDK convert path is used', () => {
  it('useCan(brand_kit) goes denied → granted without a remount', async () => {
    const sdk = makeSdk();
    // Index the output so `convert(outputId)` can resolve its CTA target plan,
    // without mounting a second hook for the same slot (two hooks deciding one
    // slot fight over its state — plan 233 TASK-16 hit exactly that).
    (sdk as unknown as { indexDecisionOutput: (d: unknown) => void })
      .indexDecisionOutput({ placementId: SLOT, output: upgradeOutput() });

    function Gate(): React.ReactElement {
      const { can, isLoading } = useCan('brand_kit');
      if (isLoading) return <span data-testid="gate">loading</span>;
      return <span data-testid="gate">{can ? 'granted' : 'denied'}</span>;
    }

    await mount(sdk, <Gate />);
    expect(text('gate')).toBe('denied');

    await act(async () => { await sdk.convert('payload_upgrade'); });
    await settle();

    expect(text('gate')).toBe('granted');
  });
});
