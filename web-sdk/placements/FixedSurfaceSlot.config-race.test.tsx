/**
 * @vitest-environment jsdom
 *
 * BL-0177 — a slot that mounts before the Playbook resolves must still end in a
 * decision, not a permanent fallback.
 *
 * `getPlacementDecision` returns `config_unavailable` UNCACHED specifically so a
 * retry can succeed, but neither `useSurfaceSlot` nor `FixedSurfaceSlot` ever
 * issued one — they decide once per mount. On a cold `revturbine_server` load,
 * whenever the first decision beat the two-hop bootstrap → config fetch, the
 * slot painted its fallback forever and every consumer hand-rolled a retry
 * (BL-0006's transport e2e had to do it twice, and still saw 4/18
 * chromium+firefox failures on sdk-internal #526).
 *
 * The two states this pins:
 *   TRANSIENT — a load is in flight (`getPlaybookLoadState() === 'loading'`).
 *               The decision path waits for it and re-resolves; if it outruns
 *               the wait, `PlacementController` re-decides when the load
 *               settles. Either way the slot ends visible.
 *   TERMINAL  — no config is coming (no provider, or the load settled empty).
 *               The slot ends on the honest `config_unavailable` fallback and
 *               stops: bounded retries, no spin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from '../react/RevTurbineProvider';
import { FixedSurfaceSlot } from './FixedSurfaceSlot';
import { FIXED_SURFACE_TEMPLATE_IDS } from './surface-slot-constants';
import { RevTurbineCustomerSdk, type RevTurbineInitInputOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const SLOT_ID = 'slot_upgrade';

const PLAYBOOK = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  playbook_handle: 'default',
  playbook_version_id: null,
  tenant_id: 't_1',
  environment_id: 'production',
  plans: [],
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
  placements: [
    {
      id: 'pl_upgrade',
      name: SLOT_ID,
      category: 'conversion',
      order: 1,
      trigger: { slot_id: SLOT_ID },
      payloads: [
        {
          id: 'payload_upgrade',
          status: 'active',
          target: { plan_ids: [], segment_chips: [] },
          surfaces: [
            {
              template_id: 'banner_placement',
              fields: { header: 'Upgrade to Pro', body: 'Unlock the dashboard', cta_label: 'Upgrade' },
              ctas: [{ label: 'Upgrade', path: 'view_plans', config: {} }],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * A config provider that has nothing on mount and only produces the Playbook
 * when the test releases it — the cold-load race, made deterministic.
 *
 * This is the customer-facing `configProvider` contract, so the test drives the
 * same provider seam `ServerLaunchedPlaybookProvider` sits behind rather than
 * mocking `fetch`.
 */
function deferredConfigProvider(playbook: unknown | null) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let loaded: unknown = undefined;
  let refreshes = 0;

  return {
    release: () => { release(); },
    get refreshes() { return refreshes; },
    provider: {
      getPlaybook: () => loaded,
      refresh: async () => {
        refreshes += 1;
        await gate;
        // `null` models a provider whose fetch came back empty: terminal.
        loaded = playbook ?? undefined;
        return loaded;
      },
    },
  };
}

/**
 * `local_only` + an explicit `configProvider`: `resolveConfigProvider` honors a
 * supplied provider in every mode, so this reproduces the Server-mode race
 * (config arrives after mount) without jsdom having to serve the slot-upsert
 * and clickstream endpoints Server mode also reaches. The states under test
 * are provider-level, not mode-level.
 */
function optionsWith(provider: unknown): RevTurbineInitInputOptions {
  return {
    tenantId: 't_1',
    runtimeMode: 'local_only',
    configProvider: provider,
    anonymousTelemetry: false,
    user: { id: 'u_1' },
  } as unknown as RevTurbineInitInputOptions;
}

async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

async function waitForDom(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => {});
    assertion();
  }, { timeout: 5_000 });
}

const slot = (
  <FixedSurfaceSlot
    id={SLOT_ID}
    surfaceTemplateIds={FIXED_SURFACE_TEMPLATE_IDS as string[]}
    fallback={<span data-testid="fallback">FALLBACK</span>}
  />
);

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

describe('BL-0177 — a slot mounted before the Playbook resolves', () => {
  it('ends in a real decision once the config lands, with no caller-side retry', async () => {
    const config = deferredConfigProvider(PLAYBOOK);

    await mount(
      <RevTurbineProvider options={optionsWith(config.provider)}>
        {slot}
      </RevTurbineProvider>,
    );

    // Mounted mid-race: nothing has resolved yet, so nothing claims to have.
    expect(container?.textContent).not.toContain('Upgrade to Pro');

    config.release();

    // No `refresh()` call, no retry button, no polling by the caller.
    await waitForDom(() => {
      expect(container?.textContent).toContain('Upgrade to Pro');
      expect(container?.querySelector('[data-testid="fallback"]')).toBeNull();
    });
  });

  it('settles on the fallback when no config is coming, without spinning', async () => {
    // A provider whose load completes with nothing: terminal `config_unavailable`.
    const config = deferredConfigProvider(null);

    await mount(
      <RevTurbineProvider options={optionsWith(config.provider)}>
        {slot}
      </RevTurbineProvider>,
    );

    config.release();

    await waitForDom(() => {
      expect(container?.querySelector('[data-testid="fallback"]')).not.toBeNull();
    });

    // Bounded: the controller re-decides at most MAX_CONFIG_RETRIES times, so
    // the refresh count stays small instead of climbing for as long as the slot
    // is mounted (the retry loop this guards against).
    const settled = config.refreshes;
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    await act(async () => {});
    expect(config.refreshes).toBeLessThanOrEqual(settled + 1);
    expect(config.refreshes).toBeLessThan(12);
    expect(container?.querySelector('[data-testid="fallback"]')).not.toBeNull();
  });

  it('emits no placement_resolved for the transient race, exactly one for the real decision', async () => {
    // The funnel reason this matters: `placement_resolved` and the §10.1 slot
    // diagnostics are denominator signals. Counting a lost config race as a
    // resolution (and `slot_empty`) would understate fill rate on every cold
    // load — and this is the assertion that catches a future refactor
    // re-emitting during the wait.
    const emit = vi.spyOn(RevTurbineCustomerSdk.prototype, 'emitPlatformEvent');
    const resolved = () => emit.mock.calls.filter(([name]) => name === 'placement_resolved');
    const config = deferredConfigProvider(PLAYBOOK);

    await mount(
      <RevTurbineProvider options={optionsWith(config.provider)}>
        {slot}
      </RevTurbineProvider>,
    );

    expect(resolved()).toHaveLength(0);

    config.release();
    await waitForDom(() => {
      expect(container?.textContent).toContain('Upgrade to Pro');
    });

    expect(resolved()).toHaveLength(1);
    expect(emit.mock.calls.filter(([name]) => name === 'slot_empty')).toHaveLength(0);
  });
});
