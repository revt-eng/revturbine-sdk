/**
 * @vitest-environment jsdom
 *
 * BL-0179 — a gate mounted before the Playbook resolves must end in the real
 * verdict, not the paywall the race produced.
 *
 * This is the consumer-visible half of the fix: `useCan` / `useEntitlement`
 * decide once per mount, so while the Playbook load was in flight
 * `checkEntitlement`'s fail-closed `config_unavailable` deny became the gate's
 * settled answer — `can: false`, `isLoading: false` — and nothing re-evaluated.
 * BL-0177 fixed exactly this for placement slots (#528); an entitlement gate is
 * the same race with a worse failure mode, because a wrongly-denied gate hides
 * a feature the user paid for.
 *
 * Both verdicts are covered on purpose. An allow proves the gate re-evaluates;
 * a deny proves it re-evaluates to the RULE's answer rather than settling on a
 * deny that happened to look the same.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from './RevTurbineProvider';
import { useCan, type UseCanResult } from './useCan';
import type { RevTurbineInitInputOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const PLAYBOOK = {
  version: '1.0.0',
  plans: [
    { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
    { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 1 },
  ],
  entitlements: [{ unique_handle: 'batch_export', name: 'Batch Export', type: 'feature' }],
  entitlement_rules: [
    {
      id: 'r_free', entitlement_id: 'batch_export', targets: [{ kind: 'plan', id: 'free' }],
      segment_ids: [], kind: 'feature', enabled: false,
    },
    {
      id: 'r_pro', entitlement_id: 'batch_export', targets: [{ kind: 'plan', id: 'pro' }],
      segment_ids: [], kind: 'feature', enabled: true,
    },
  ],
  segments: [], content_ui_paths: [], surface_templates: [], placements: [],
};

/**
 * A config provider that has nothing on mount and only produces the Playbook
 * when the test releases it — the cold-load race, made deterministic. The
 * customer-facing `configProvider` contract, so this drives the same seam
 * `ServerLaunchedPlaybookProvider` sits behind rather than mocking `fetch`.
 */
function deferredConfigProvider() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let loaded: unknown = undefined;

  return {
    release: () => { release(); },
    provider: {
      getPlaybook: () => loaded,
      refresh: async () => {
        await gate;
        loaded = PLAYBOOK;
        return loaded;
      },
    },
  };
}

/**
 * `local_only` + an explicit `configProvider`: `resolveConfigProvider` honors a
 * supplied provider in every mode, so this reproduces the Server-mode race
 * (config arrives after mount) without jsdom having to serve the Server-mode
 * endpoints. The states under test are provider-level, not mode-level.
 */
function optionsWith(provider: unknown, plan: string): RevTurbineInitInputOptions {
  return {
    tenantId: 't_1',
    runtimeMode: 'local_only',
    configProvider: provider,
    anonymousTelemetry: false,
    user: { id: 'u_1', plan: { handle: plan, name: plan } },
  } as unknown as RevTurbineInitInputOptions;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

async function mountGate(plan: string): Promise<{ release: () => void; last: () => UseCanResult }> {
  const config = deferredConfigProvider();
  const snapshots: UseCanResult[] = [];

  function Probe(): React.ReactElement {
    const result = useCan('batch_export');
    snapshots.push(result);
    return <span data-testid="verdict">{result.isLoading ? 'deciding' : String(result.can)}</span>;
  }

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={optionsWith(config.provider, plan)}>
        <Probe />
      </RevTurbineProvider>,
    );
  });

  return { release: config.release, last: () => snapshots[snapshots.length - 1]! };
}

async function waitForDom(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => {});
    assertion();
  }, { timeout: 5_000 });
}

describe('BL-0179 — a gate mounted before the Playbook resolves', () => {
  it('ends ALLOWED once the config lands, with no caller-side retry', async () => {
    const gate = await mountGate('pro');

    // Mounted mid-race: nothing has decided, and nothing claims to have.
    expect(container?.textContent).not.toBe('true');
    expect(gate.last().result).toBeNull();

    gate.release();

    // No `recheck()`, no remount, no polling by the caller.
    await waitForDom(() => {
      expect(container?.textContent).toBe('true');
    });
    expect(gate.last()).toMatchObject({ can: true, isLoading: false });
  });

  it('ends DENIED on the rule\'s verdict once the config lands, not on the race deny', async () => {
    const gate = await mountGate('free');

    gate.release();

    await waitForDom(() => {
      expect(gate.last().result).not.toBeNull();
    });

    const settled = gate.last();
    expect(settled.can).toBe(false);
    expect(settled.isLoading).toBe(false);
    // The deny came from the `free` rule, not from the missing config.
    expect(['config_unavailable', 'entitlement_not_in_playbook'])
      .not.toContain(settled.result?.reason);
  });

  it('never reports a settled deny while the config is still in flight', async () => {
    // The regression itself: `!can && !isLoading` is the documented "settled
    // deny" a consumer paywalls on. It must not be reachable during the race.
    const gate = await mountGate('pro');

    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });

    expect(gate.last()).toMatchObject({ can: false, isLoading: true });

    gate.release();
    await waitForDom(() => {
      expect(gate.last().can).toBe(true);
    });
  });
});
