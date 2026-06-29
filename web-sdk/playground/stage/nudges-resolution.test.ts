import { describe, expect, it } from 'vitest';
import { RevTurbineConfigSchema } from '@revt-eng/schema';
import { RevTurbineCustomerSdk, createLocalRuntimeConfig } from '../../index';
import { InMemoryStorage, type RevTurbineStorage } from '../../storage';
import rawConfig from '../config/prism-export-config.json';
import { DEFAULT_DEMO_STATE, type DemoState } from '../state/demo-state';
import { toTrialStatus, toUserContext } from '../state/to-user-context';

/**
 * Plan 81 TASK-3 integration guard. The playground renders threshold / gate
 * placements by resolving them *by name* in local-runtime mode (the resolver's
 * direct-lookup path), because the local resolver does not evaluate
 * threshold_percent itself. This pins that the by-name path actually returns a
 * visible decision with the bundled copy — the assumption the Nudges component
 * depends on and that can't be eyeballed in a headless test run.
 */
const PRISM_CONFIG = RevTurbineConfigSchema.parse(rawConfig);

/** Per-mount store options. The playground injects a fresh `InMemoryStorage`
 * per mount so a stale persisted trialStatus can't override initialData. */
interface StoreOpts {
  persistentStorage?: RevTurbineStorage;
  storageKey?: string;
}

function localSdk(state: DemoState, store: StoreOpts = {}): RevTurbineCustomerSdk {
  const noop = () => {};
  const options = createLocalRuntimeConfig({
    tenantId: 'prism',
    apiKey: 'local',
    endpoint: 'http://localhost',
    mode: 'snippet',
    ...(store.persistentStorage ? { persistentStorage: store.persistentStorage } : {}),
    user: toUserContext(PRISM_CONFIG, state),
    localRuntime: {
      exportedConfig: PRISM_CONFIG,
      // Hydrate trial status synchronously at construction.
      initialData: { trialStatus: toTrialStatus(state) },
      resolvers: { getTrialStatus: () => toTrialStatus(state) },
      ...(store.storageKey ? { storageKey: store.storageKey } : {}),
    },
    // The SDK asserts a resolver exists for every content_ui_paths action_type.
    uiPathResolvers: {
      open_checkout_modal: noop,
      contact_sales: noop,
      navigate_to_plans: noop,
    },
  });
  return new RevTurbineCustomerSdk(options);
}

async function resolveByName(sdk: RevTurbineCustomerSdk, name: string) {
  const placementId = await sdk.registerPlacement({ name });
  return sdk.getPlacementDecision({ placementId, userId: DEFAULT_DEMO_STATE.userId });
}

const free = (over: Partial<DemoState> = {}): DemoState => ({ ...DEFAULT_DEMO_STATE, planHandle: 'free', ...over });

describe('Prism by-name placement resolution (local runtime)', () => {
  it('resolves the 80% usage warning with copy', async () => {
    const sdk = localSdk(free({ generationsUsed: 24 }));
    const decision = await resolveByName(sdk, 'pl_usage_80');
    expect(decision).not.toBeNull();
    expect(JSON.stringify(decision?.content ?? {})).toContain('left');
  });

  it('resolves the usage-exhausted modal', async () => {
    const sdk = localSdk(free({ generationsUsed: 30 }));
    const decision = await resolveByName(sdk, 'pl_usage_100');
    expect(decision).not.toBeNull();
    expect(JSON.stringify(decision?.content ?? {}).toLowerCase()).toContain('out of generations');
  });

  it('resolves the batch-export hard gate modal', async () => {
    const sdk = localSdk(free());
    const decision = await resolveByName(sdk, 'pl_gate_batch_export');
    expect(decision).not.toBeNull();
    expect(JSON.stringify(decision?.content ?? {}).toLowerCase()).toContain('batch export');
  });

  // AC-3: completing the Pro checkout flips entitlements. The upgrade CTA sets
  // planHandle='pro'; this pins that the entitlement check flips with the plan,
  // so the gated features unlock (the gate stops firing in the studio).
  it('flips batch_export from denied (Free) to allowed (Pro)', async () => {
    const onFree = await localSdk(free()).checkEntitlement('batch_export');
    expect(onFree.status).toBe('denied');
    const onPro = await localSdk(free({ planHandle: 'pro' })).checkEntitlement('batch_export');
    expect(onPro.status).not.toBe('denied');
  });

  // TASK-5: a reverse trial grants premium entitlements WITHOUT a plan change.
  // A Free user in an active reverse trial should have batch_export unlocked.
  it('grants premium entitlements during a reverse trial (Free plan)', async () => {
    const reverse = free({
      trial: { inTrial: true, trialType: 'reverse', dayNumber: 2, daysRemaining: 5 },
    });
    // No explicit getTrialStatus() call: initialData.trialStatus hydrates it at
    // construction, so the grant is in effect before the first entitlement check.
    const result = await localSdk(reverse).checkEntitlement('batch_export');
    expect(result.status).not.toBe('denied');
  });

  // Plan 82 REQ-2: the watermark is driven by the resolved capability tier, so a
  // reverse trial (grants Clean-4K on Free) removes it. This pins the tier the
  // ImageStudio reads.
  it('resolves resolution_tier to Watermarked on Free, Clean during a reverse trial', async () => {
    const onFree = await localSdk(free()).checkEntitlement('resolution_tier');
    expect(onFree.current_tier ?? '').toContain('Watermark');
    const reverse = free({ trial: { inTrial: true, trialType: 'reverse', dayNumber: 2, daysRemaining: 5 } });
    const onTrial = await localSdk(reverse).checkEntitlement('resolution_tier');
    expect(onTrial.current_tier ?? '').not.toContain('Watermark');
  });

  // Plan 82 AC-3: the trial PLACEMENTS resolve visible by name (the coverage gap
  // that let the trial-rendering bug ship — the earlier tests only resolved
  // usage/gate placements, never the trial ones).
  it('resolves the reverse-trial banner while a reverse trial is active', async () => {
    const reverse = free({ trial: { inTrial: true, trialType: 'reverse', dayNumber: 2, daysRemaining: 5 } });
    const d = await resolveByName(localSdk(reverse), 'pl_reverse_trial');
    // trial_progress passes the gate whenever the trial is active (was trial_started,
    // which only fires at day 0 — the bug /verify found).
    expect(d?.visible).toBe(true);
  });

  it('resolves the trial-ending banner in a free trial’s final days', async () => {
    const ending = free({ trial: { inTrial: true, trialType: 'free', dayNumber: 5, daysRemaining: 2 } });
    const d = await resolveByName(localSdk(ending), 'pl_trial_ending');
    expect(d?.visible).toBe(true);
  });

  // Plan 82 AC-4: a stale persisted trialStatus must not override initialData on
  // the next mount. This reproduces the browser-only bug in node via an injected
  // shared store, then shows a fresh store (the playground's fix) prevents it.
  it('REGRESSION: a fresh per-mount store keeps the reverse-trial grant (shared store would lose it)', async () => {
    const reverse = free({ trial: { inTrial: true, trialType: 'reverse', dayNumber: 2, daysRemaining: 5 } });
    const shared = new InMemoryStorage();
    const KEY = 'rt-shared';

    // Baseline mount (no trial) persists trialStatus:{in_trial:false} under KEY.
    await localSdk(free(), { persistentStorage: shared, storageKey: KEY }).checkEntitlement('batch_export');

    // Bug shape: a reverse mount sharing that store + key reads the stale
    // in_trial:false, which overrides initialData → grant lost.
    const buggy = await localSdk(reverse, { persistentStorage: shared, storageKey: KEY }).checkEntitlement('batch_export');
    expect(buggy.status).toBe('denied');

    // Fix: a fresh store per mount (what PrismApp now injects) → no stale override.
    const fixed = await localSdk(reverse, { persistentStorage: new InMemoryStorage() }).checkEntitlement('batch_export');
    expect(fixed.status).not.toBe('denied');
  });
});
