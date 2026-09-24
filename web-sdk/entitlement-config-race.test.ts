/**
 * BL-0179 — an entitlement checked before the Playbook resolves must still end
 * in the real verdict, not the fail-closed deny the race produced.
 *
 * BL-0177 fixed this for placements (#528) and left `checkEntitlement` — and
 * therefore `can` / `gate` / `useCan` / `useEntitlement` — on the old behaviour:
 * while the load was in flight the check returned `config_unavailable`, which is
 * indistinguishable from a rule denial, so a gate mounted before config
 * resolution rendered its paywall and never re-evaluated.
 *
 * The same two states this pins for entitlements:
 *   TRANSIENT — a load is in flight (`getPlaybookLoadState() === 'loading'`).
 *               `checkEntitlement` waits it out, bounded, and re-evaluates; if
 *               the load outruns that bound, `EntitlementGate` parks the deny
 *               and re-checks when the load settles. No `gate_evaluated` for the
 *               transient state — a lost race is not an evaluation.
 *   TERMINAL  — no config is coming (no provider, or the load settled empty).
 *               Unchanged: fail-CLOSED deny, `config_unavailable` in Server
 *               mode, with exactly one `gate_evaluated`.
 *
 * The post-bound retry path is reached by injecting a wait bound of `0`
 * (`setPlaybookWaitBoundMs`) rather than with fake timers — BL-0177 shipped that
 * path untested because fake timers fought `act()`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import { EntitlementGate, PlacementController } from './controllers';

const SLOT_ID = 'slot_upgrade';

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
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
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
              fields: { header: 'Upgrade to Pro', body: 'Unlock it', cta_label: 'Upgrade' },
              ctas: [{ label: 'Upgrade', path: 'view_plans', config: {} }],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * A config provider that has nothing until the test releases it — the cold-load
 * race, made deterministic. Same seam `ServerLaunchedPlaybookProvider` sits
 * behind, so no `fetch` mocking.
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
        // `null` models a load that came back empty: terminal.
        loaded = playbook ?? undefined;
        return loaded;
      },
    },
  };
}

/**
 * `local_only` + an explicit `configProvider`: `resolveConfigProvider` honors a
 * supplied provider in every mode, so this is the Server-mode race (config
 * arrives after the first check) without the Server-mode endpoints. The states
 * under test are provider-level, not mode-level — the Server-mode reason string
 * is pinned separately, against a real fetch failure.
 */
function raceSdk(provider: unknown, plan = 'pro'): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_race',
    apiKey: 'local',
    endpoint: 'http://localhost',
    mode: 'snippet',
    runtimeMode: 'local_only',
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    configProvider: provider,
  } as unknown as RevTurbineInitOptions);
  sdk.setUserContext({ id: 'user_race', plan: { handle: plan, name: plan } });
  return sdk;
}

const gateEvaluatedCalls = (emit: ReturnType<typeof vi.spyOn>) =>
  emit.mock.calls.filter(([name]) => name === 'gate_evaluated');

afterEach(() => vi.restoreAllMocks());

describe('BL-0179 — checkEntitlement during an in-flight Playbook load (TRANSIENT)', () => {
  it('waits out the load and returns the real ALLOW verdict', async () => {
    const config = deferredConfigProvider(PLAYBOOK);
    const sdk = raceSdk(config.provider, 'pro');

    // Checked mid-race: the load has not settled when this call is made.
    const pending = sdk.checkEntitlement('batch_export');
    expect(sdk.getPlaybookLoadState()).toBe('loading');
    config.release();

    const result = await pending;
    expect(result.reason).not.toBe('config_unavailable');
    expect(result.allowed).toBe(true);
    expect(result.status).toBe('allowed');
  });

  it('waits out the load and returns the real DENY verdict, not the race deny', async () => {
    const config = deferredConfigProvider(PLAYBOOK);
    const sdk = raceSdk(config.provider, 'free');

    const pending = sdk.checkEntitlement('batch_export');
    config.release();
    const result = await pending;

    // A deny either way — which is exactly why this assertion has to look past
    // `allowed`. Pre-fix this denied with a config-miss reason (the race); it
    // must now deny because the `free` rule says the feature is off.
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('denied');
    expect(['config_unavailable', 'entitlement_not_in_playbook']).not.toContain(result.reason);
    // The rule that produced the verdict is named (BL-0062) — a race deny has
    // no rule to name.
    expect(result.rule_handle).toBeTruthy();
  });
});

describe('BL-0179 — checkEntitlement with no config coming (TERMINAL)', () => {
  it('denies with config_unavailable in Server mode when the config fetch fails', async () => {
    // The terminal contract, unchanged: no load is pending, so nothing is
    // waited on and the fail-closed deny is the answer.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    const sdk = new RevTurbineCustomerSdk({
      tenantId: 'tenant_fc',
      apiKey: 'sk_test',
      publicKey: 'pub_test',
      endpoint: 'https://edge.example.com',
      mode: 'snippet',
      runtimeMode: 'revturbine_server',
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    } as unknown as RevTurbineInitOptions);
    sdk.setUserContext({ id: 'user_fc', plan: { handle: 'free', name: 'Free' } });

    const result = await sdk.checkEntitlement('batch_export');
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('denied');
    expect(result.reason).toBe('config_unavailable');
    expect(sdk.getPlaybookLoadState()).toBe('unavailable');
  });

  it('does not wait when the load already settled empty', async () => {
    const config = deferredConfigProvider(null);
    const sdk = raceSdk(config.provider);

    config.release();
    await sdk.checkEntitlement('batch_export');
    expect(sdk.getPlaybookLoadState()).toBe('unavailable');

    // A second check must not re-enter the wait — the state is terminal, so it
    // resolves without another refresh.
    const before = config.refreshes;
    const result = await sdk.checkEntitlement('batch_export');
    expect(result.allowed).toBe(false);
    expect(config.refreshes).toBe(before);
  });
});

describe('BL-0179 — EntitlementGate emission rule', () => {
  it('emits no gate_evaluated for the transient state and exactly one for the verdict', async () => {
    const emit = vi.spyOn(RevTurbineCustomerSdk.prototype, 'emitPlatformEvent')
      .mockResolvedValue(undefined);
    const config = deferredConfigProvider(PLAYBOOK);
    const sdk = raceSdk(config.provider, 'pro');
    // Bound 0: the load always outruns the wait, so the gate takes the parked
    // (post-bound) path — the one BL-0177 could not test.
    sdk.setPlaybookWaitBoundMs(0);

    const gate = new EntitlementGate(sdk, { handle: 'batch_export' });
    await gate.check();

    // Parked, not published: no verdict, no telemetry, still loading.
    expect(gateEvaluatedCalls(emit)).toHaveLength(0);
    expect(gate.state.result).toBeNull();
    expect(gate.state.denied).toBe(false);
    expect(gate.state.isLoading).toBe(true);

    config.release();
    await vi.waitFor(() => {
      expect(gate.state.result).not.toBeNull();
    });

    expect(gate.state.allowed).toBe(true);
    expect(gate.state.isLoading).toBe(false);
    const evaluated = gateEvaluatedCalls(emit);
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]?.[1]).toMatchObject({ outcome: 'allowed', gated: false });
    // BL-0062 — the verdict still names its rule.
    expect(evaluated[0]?.[1]).toHaveProperty('rule_handle');
    gate.dispose();
  });

  it('publishes the fail-closed deny once, with one gate_evaluated, when nothing arrives', async () => {
    const emit = vi.spyOn(RevTurbineCustomerSdk.prototype, 'emitPlatformEvent')
      .mockResolvedValue(undefined);
    const config = deferredConfigProvider(null);
    const sdk = raceSdk(config.provider);
    sdk.setPlaybookWaitBoundMs(0);

    const gate = new EntitlementGate(sdk, { handle: 'batch_export' });
    await gate.check();
    config.release();

    await vi.waitFor(() => {
      expect(gate.state.isLoading).toBe(false);
    });

    expect(gate.state.denied).toBe(true);
    expect(gateEvaluatedCalls(emit)).toHaveLength(1);

    // Bounded: the gate re-checks at most MAX_CONFIG_RETRIES times, so the
    // provider is not refreshed for as long as the gate lives.
    const settled = config.refreshes;
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    expect(config.refreshes).toBeLessThanOrEqual(settled + 1);
    expect(gateEvaluatedCalls(emit)).toHaveLength(1);
    gate.dispose();
  });
});

describe('BL-0179 — the injected bound reaches PlacementController\'s post-bound retry', () => {
  it('re-decides when the load settles after the wait bound elapsed', async () => {
    const emit = vi.spyOn(RevTurbineCustomerSdk.prototype, 'emitPlatformEvent')
      .mockResolvedValue(undefined);
    const config = deferredConfigProvider(PLAYBOOK);
    const sdk = raceSdk(config.provider);
    // Without this the path below needs the 4s default to elapse — which is why
    // #528 left `onPlaybookSettled` → `load()` uncovered.
    sdk.setPlaybookWaitBoundMs(0);

    const controller = new PlacementController(sdk, { surfaceSlot: { id: SLOT_ID } });
    await controller.load();

    // The decision lost the race and the controller is holding it: still
    // loading, and no `placement_resolved` yet.
    expect(controller.state.isLoading).toBe(true);
    expect(emit.mock.calls.filter(([name]) => name === 'placement_resolved')).toHaveLength(0);

    config.release();
    await vi.waitFor(() => {
      expect(controller.state.isLoading).toBe(false);
    });

    expect(controller.state.decision?.reasonCodes ?? []).not.toContain('config_unavailable');
    expect(emit.mock.calls.filter(([name]) => name === 'placement_resolved')).toHaveLength(1);
    controller.dispose();
  });
});
