/**
 * @vitest-environment jsdom
 *
 * Plan 233 TASK-8a/8b/8c — dismissal cooldowns actually suppress, at the
 * authored window.
 *
 * Three defects, one outcome. Cooldowns were a complete no-op in production:
 *
 * 8a — the write keyed interaction state on `{placementId, userId, treatmentId}`
 *      while the decision-time read keyed on `{placementId, userId}` only. Core's
 *      key is `[tenantId, userId, placementId, treatmentId || 'default']` and the
 *      controllers ALWAYS populate `treatmentId`, so the two keys could never
 *      match. Plan 167 shipped AC-1 green because its proving test dismissed
 *      without a treatmentId — both keys fell back to 'default' and matched.
 *
 * 8b — `caps.cooldown_days` was authored, exported, imported and never read
 *      back. The controller defaulted to 24h and passed it on EVERY dismissal,
 *      so both the authored value and the 7-day default were unreachable.
 *
 * 8c — remind-me-later had no window of its own reaching the runtime.
 *
 * So these drive the PUBLIC path with a non-empty treatmentId — the exact shape
 * that fails on the old code — rather than calling the store directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initRevTurbine, RuntimeMode } from './customer-side';
import type { ConfigArtifact, RevTurbineCustomerSdk } from './customer-side';

const PLACEMENT_ID = 'pl_upgrade';
const PAYLOAD_ID = 'payload_1';

/** A Playbook whose single payload authors BOTH windows. */
function playbookWith(options: { cooldownDays?: number; remindMinutes?: number }): ConfigArtifact {
  return {
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
        id: PLACEMENT_ID,
        name: 'Upgrade',
        category: 'upsell',
        payloads: [
          {
            id: PAYLOAD_ID,
            target: { plan_ids: [], segment_chips: [] },
            surfaces: [{ template_id: 'modal_overlay', fields: {} }],
            ...(options.cooldownDays !== undefined
              ? { caps: { cooldown_days: options.cooldownDays } }
              : {}),
            ...(options.remindMinutes !== undefined
              ? { remind_later_minutes: options.remindMinutes }
              : {}),
          },
        ],
      },
    ],
  } as unknown as ConfigArtifact;
}

function makeSdk(playbook: ConfigArtifact): RevTurbineCustomerSdk {
  return initRevTurbine({
    tenantId: 't_1',
    runtimeMode: RuntimeMode.LocalOnly,
    localRuntime: { playbook },
  } as never);
}

/** Dismiss the way the React controllers do — WITH a treatmentId. */
async function dismissLikeProduction(
  sdk: RevTurbineCustomerSdk,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await sdk.trackTreatmentInteraction({
    userId: 'user_1',
    placementId: PLACEMENT_ID,
    treatmentId: PAYLOAD_ID,
    payloadId: PAYLOAD_ID,
    interactionType: 'dismiss',
    metadata,
  } as never);
}

/**
 * Read the suppression the next decision would see — under the READER's key.
 *
 * Deliberately not `[...state.values()][0]`. That finds the write wherever it
 * landed, so it passes even when the reader's key holds nothing, which is the
 * whole defect. Asking for the reader's key is what makes these tests fail on
 * the old code.
 */
function suppressedUntilFor(sdk: RevTurbineCustomerSdk): number | undefined {
  const state = Reflect.get(sdk, 'interactionState') as Map<string, { suppressedUntil?: number }>;
  const readKey = (Reflect.get(sdk, 'interactionStateKey') as (i: unknown) => string).call(sdk, {
    placementId: PLACEMENT_ID,
    userId: 'user_1',
  });
  return state.get(readKey)?.suppressedUntil;
}

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('AC-10 — the write key and the read key agree (TASK-8a)', () => {
  it('records exactly one entry, under the key the reader uses', async () => {
    const sdk = makeSdk(playbookWith({}));

    await dismissLikeProduction(sdk);

    const state = Reflect.get(sdk, 'interactionState') as Map<string, unknown>;
    expect(state.size).toBe(1);

    // The reader derives its key without a treatmentId. Before plan 233 the
    // writer appended one, so this key held nothing.
    const readKey = (Reflect.get(sdk, 'interactionStateKey') as (i: unknown) => string).call(sdk, {
      placementId: PLACEMENT_ID,
      userId: 'user_1',
    });
    expect(state.has(readKey)).toBe(true);
  });

  it('suppresses after a dismissal carrying a treatmentId', async () => {
    // The exact case that failed: production always sets treatmentId.
    const sdk = makeSdk(playbookWith({}));

    await dismissLikeProduction(sdk);

    expect(suppressedUntilFor(sdk)).toBeGreaterThan(Date.now());
  });

  it('a dismissal WITHOUT a treatmentId still suppresses', async () => {
    // Plan 167's proving test used this shape, which is why it passed while the
    // feature was dead. It must keep working — but it is no longer the only
    // shape covered.
    const sdk = makeSdk(playbookWith({}));

    await sdk.trackTreatmentInteraction({
      userId: 'user_1',
      placementId: PLACEMENT_ID,
      interactionType: 'dismiss',
    } as never);

    expect(suppressedUntilFor(sdk)).toBeGreaterThan(Date.now());
  });
});

describe('AC-10b — the window comes from the authored config (TASK-8b)', () => {
  it('uses the payload authored cooldown_days, not a default', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sdk = makeSdk(playbookWith({ cooldownDays: 3 }));

    await dismissLikeProduction(sdk);

    // 3 days, because the Playbook says so — not 24h and not 7 days.
    expect(suppressedUntilFor(sdk)).toBe(now + 3 * DAY);
  });

  it('falls back to the 7-day default when nothing is authored', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sdk = makeSdk(playbookWith({}));

    await dismissLikeProduction(sdk);

    expect(suppressedUntilFor(sdk)).toBe(now + 7 * DAY);
  });

  it('an explicit caller value still wins over the authored one', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sdk = makeSdk(playbookWith({ cooldownDays: 3 }));

    await dismissLikeProduction(sdk, { cooldown_ms: 60_000 });

    expect(suppressedUntilFor(sdk)).toBe(now + 60_000);
  });

  it('never resolves to the legacy 24h', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sdk = makeSdk(playbookWith({}));

    await dismissLikeProduction(sdk);

    expect(suppressedUntilFor(sdk)).not.toBe(now + DAY);
  });
});

describe('AC-10c — remind-me-later is its own window (TASK-8c)', () => {
  it('uses the authored remind_later_minutes', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sdk = makeSdk(playbookWith({ cooldownDays: 7, remindMinutes: 15 }));

    await sdk.trackTreatmentInteraction({
      userId: 'user_1',
      placementId: PLACEMENT_ID,
      treatmentId: PAYLOAD_ID,
      payloadId: PAYLOAD_ID,
      interactionType: 'remind_me_later',
    } as never);

    // 15 minutes — NOT the 7-day dismiss window authored on the same payload.
    expect(suppressedUntilFor(sdk)).toBe(now + 15 * 60 * 1000);
  });

  it('does not borrow the dismiss window when only that is authored', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sdk = makeSdk(playbookWith({ cooldownDays: 7 }));

    await sdk.trackTreatmentInteraction({
      userId: 'user_1',
      placementId: PLACEMENT_ID,
      treatmentId: PAYLOAD_ID,
      payloadId: PAYLOAD_ID,
      interactionType: 'remind_me_later',
    } as never);

    expect(suppressedUntilFor(sdk)).not.toBe(now + 7 * DAY);
  });
});
