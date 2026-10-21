/**
 * @vitest-environment jsdom
 *
 * BUG-554 (AC-2) — a mounted entitlement hook follows purchased add-on
 * quantities without a remount: 1 → 3 → 0 and an explicit empty list.
 *
 * Drives a REAL `RevTurbineCustomerSdk` (same reasoning as
 * context-reactivity.test.tsx): the property under test is that a real
 * `update({ addons })` reaches a real mounted hook, and that the allowance it
 * reports is the plan maximum plus the purchased contribution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineCustomerSdk } from '../customer-side';
import { RevTurbineContext } from './useRevTurbine';
import { useEntitlement } from './useEntitlement';

const PLAYBOOK = {
  version: '1.0.0',
  plans: [{ unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 0 }],
  addons: [{ unique_handle: 'seat_pack', name: 'Seat pack' }],
  entitlements: [{ unique_handle: 'seats', name: 'Seats', type: 'seat' }],
  entitlement_rules: [
    {
      id: 'seats_base',
      entitlement_id: 'seats',
      targets: [{ kind: 'plan', id: 'pro' }],
      segment_ids: [],
      included_count: 10,
      enforcement: 'hard_block',
    },
    {
      id: 'seats_pack',
      entitlement_id: 'seats',
      targets: [{ kind: 'addon', id: 'seat_pack' }],
      segment_ids: [],
      included_count: 5,
      enforcement: 'hard_block',
    },
  ],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [],
};

function makeSdk(): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_purchased_reactivity',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    localRuntime: { playbook: PLAYBOOK as never },
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
  });
  sdk.setUserContext({ id: 'user_p', plan_handle: 'pro' });
  return sdk;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountSeats(sdk: RevTurbineCustomerSdk): Promise<{ mounts: number }> {
  const counter = { mounts: 0 };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  function Probe(): React.ReactElement {
    React.useEffect(() => {
      counter.mounts += 1;
    }, []);
    const { result, isLoading } = useEntitlement({ handle: 'seats' });
    if (isLoading || !result) return <span data-testid="limit">loading</span>;
    return <span data-testid="limit">{String(result.limit)}</span>;
  }

  await act(async () => {
    root!.render(
      <RevTurbineContext.Provider
        value={{ sdk: sdk as never, isReady: true, error: '', setContext: () => {} }}
      >
        <Probe />
      </RevTurbineContext.Provider>,
    );
  });
  await settle();
  return counter;
}

const limit = (): string | undefined =>
  container?.querySelector('[data-testid="limit"]')?.textContent ?? undefined;

async function buy(sdk: RevTurbineCustomerSdk, quantity: number | null): Promise<void> {
  await act(async () => {
    sdk.update({
      addons: quantity === null ? [] : [{ addon_handle: 'seat_pack', quantity }],
    });
  });
  await settle();
}

describe('a mounted entitlement hook follows purchased quantities', () => {
  it('reports 10 + 5 x quantity through 1 → 3 → 0 → [] without a remount', async () => {
    const sdk = makeSdk();
    const counter = await mountSeats(sdk);
    expect(limit()).toBe('10');

    await buy(sdk, 1);
    expect(limit()).toBe('15');

    await buy(sdk, 3);
    expect(limit()).toBe('25');

    await buy(sdk, 0);
    expect(limit()).toBe('10');

    await buy(sdk, 3);
    expect(limit()).toBe('25');

    // An explicit empty authoritative list clears the holdings.
    await buy(sdk, null);
    expect(limit()).toBe('10');

    expect(counter.mounts).toBe(1);
  });
});
