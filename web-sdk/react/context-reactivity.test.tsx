/**
 * @vitest-environment jsdom
 *
 * Plan 194 REQ-3 (AC-3) — a mounted gate re-evaluates when the user context
 * changes.
 *
 * The user context is a private field on the SDK instance, and the instance's
 * identity never changes, so React was never told that `update()` or
 * `identify()` had happened. `EntitlementGate.notify()` fires only from inside
 * `check()` — it announces the gate's own re-check and knew nothing about a
 * context change — and `useEntitlement`'s effect keyed on `[sdk, handle]`,
 * neither of which a context change moves. Net effect: the SDK returned
 * `denied` while the mounted gate kept rendering granted children, through an
 * effect flush and a forced parent re-render. Only a remount or a manual
 * `recheck()` fixed it, and `useCan` has no `recheck`.
 *
 * These tests drive a REAL `RevTurbineCustomerSdk` rather than a mock. A mock
 * would assert the wiring against itself; the property under test is that a
 * real `update()` reaches a real mounted gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineCustomerSdk } from '../customer-side';
import { RevTurbineContext } from './useRevTurbine';
import { useCan } from './useCan';

const PLAYBOOK = {
  version: '1.0.0',
  plans: [
    { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
    { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 1 },
  ],
  entitlements: [
    { unique_handle: 'generations', name: 'Generations', type: 'usage_limit', unit: 'runs' },
    { unique_handle: 'brand_kit', name: 'Brand Kit', type: 'feature' },
  ],
  entitlement_rules: [
    {
      id: 'r_gen',
      entitlement_id: 'generations',
      targets: [{ kind: 'plan', id: 'free' }, { kind: 'plan', id: 'pro' }],
      segment_ids: [],
      kind: 'usage_limit',
      limit_value: 10,
      enforcement: 'hard_block',
    },
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

function makeSdk(): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_reactivity',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    localRuntime: { playbook: PLAYBOOK as never },
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
  });
  sdk.setUserContext({ id: 'user_r', plan_handle: 'free' });
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

/** Let the local evaluation and its re-render settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountGate(sdk: RevTurbineCustomerSdk, handle: string): Promise<{ renders: number }> {
  const counter = { renders: 0 };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  function Probe(): React.ReactElement {
    counter.renders += 1;
    const { can, isLoading } = useCan(handle);
    if (isLoading) return <span data-testid="state">loading</span>;
    return <span data-testid="state">{can ? 'granted' : 'denied'}</span>;
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

const state = (): string | undefined =>
  container?.querySelector('[data-testid="state"]')?.textContent ?? undefined;

describe('a mounted gate re-evaluates on update()', () => {
  it('flips granted → denied when reported usage passes the limit', async () => {
    const sdk = makeSdk();
    await mountGate(sdk, 'generations');
    expect(state()).toBe('granted');

    // No remount, no recheck() — the app only reports usage.
    await act(async () => {
      sdk.update({ usage: { generations: 99 } });
    });
    await settle();

    expect(state()).toBe('denied');
  });

  it('flips denied → granted when the plan changes', async () => {
    const sdk = makeSdk();
    await mountGate(sdk, 'brand_kit');
    // `brand_kit` targets `pro`; the user starts on `free`.
    expect(state()).toBe('denied');

    await act(async () => {
      sdk.update({ plan_handle: 'pro' });
    });
    await settle();

    expect(state()).toBe('granted');
  });

  it('re-evaluates on identify(), not only on update()', async () => {
    const sdk = makeSdk();
    await mountGate(sdk, 'brand_kit');
    expect(state()).toBe('denied');

    await act(async () => {
      sdk.identify('user_pro', { plan_handle: 'pro' });
    });
    await settle();

    expect(state()).toBe('granted');
  });

  it('denies after a sign-out, rather than holding the signed-out entitlement', async () => {
    const sdk = makeSdk();
    await act(async () => {
      sdk.identify('user_pro', { plan_handle: 'pro' });
    });
    await mountGate(sdk, 'brand_kit');
    expect(state()).toBe('granted');

    await act(async () => {
      sdk.resetUserContext();
    });
    await settle();

    // No plan after reset → no plan identity → fail closed (plan 194 REQ-1).
    expect(state()).toBe('denied');
  });

  it('does not re-render on a context change that changes no decision', async () => {
    const sdk = makeSdk();
    const counter = await mountGate(sdk, 'brand_kit');
    const before = counter.renders;

    // A usage report for an unrelated entitlement still notifies, but the gate
    // re-checks to the same answer — so this asserts the re-check is cheap and
    // idempotent, not that it is skipped.
    await act(async () => {
      sdk.update({ usage: { generations: 1 } });
    });
    await settle();

    expect(state()).toBe('denied');
    // Bounded: a notification must not cascade into a render loop.
    expect(counter.renders - before).toBeLessThan(10);
  });
});

describe('a changed check context re-evaluates', () => {
  it('honours a new `context` prop without a remount', async () => {
    const sdk = makeSdk();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    // `<Gate check={{ entitlement, context }}>` passes this straight through to
    // useEntitlement. The gate captured `context` at construction and the
    // effect keyed on `[sdk, handle]`, so a changed context was inert.
    function Probe({ used }: { used: number }): React.ReactElement {
      const { can, isLoading } = useCan('generations', { context: { used } });
      if (isLoading) return <span data-testid="state">loading</span>;
      return <span data-testid="state">{can ? 'granted' : 'denied'}</span>;
    }

    await act(async () => {
      root!.render(
        <RevTurbineContext.Provider
          value={{ sdk: sdk as never, isReady: true, error: '', setContext: () => {} }}
        >
          <Probe used={0} />
        </RevTurbineContext.Provider>,
      );
    });
    await settle();
    expect(state()).toBe('granted');

    await act(async () => {
      root!.render(
        <RevTurbineContext.Provider
          value={{ sdk: sdk as never, isReady: true, error: '', setContext: () => {} }}
        >
          <Probe used={99} />
        </RevTurbineContext.Provider>,
      );
    });
    await settle();
    expect(state()).toBe('denied');
  });
});

describe('the subscription is released', () => {
  it('stops re-checking once the consumer unmounts', async () => {
    const sdk = makeSdk();
    await mountGate(sdk, 'generations');
    expect(state()).toBe('granted');

    await act(async () => root!.unmount());
    root = null;

    const spy = vi.spyOn(sdk, 'checkEntitlement');
    await act(async () => {
      sdk.update({ usage: { generations: 99 } });
    });
    await settle();

    // A gate that outlives its consumer would keep evaluating forever.
    expect(spy).not.toHaveBeenCalled();
  });
});
