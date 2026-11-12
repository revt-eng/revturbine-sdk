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
    user: { id: 'u_test' },
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

describe('ST-1696 C3a — an authored 0 means no cooldown, not "unset"', () => {
  it('a dismissal on a payload authored with cooldown_days: 0 leaves the placement eligible', async () => {
    const sdk = makeSdk(playbookWith({ cooldownDays: 0 }));

    await dismissLikeProduction(sdk);

    expect(suppressedUntilFor(sdk)).toBeUndefined();
  });

  it('an absent cooldown_days still gives seven days', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const sdk = makeSdk(playbookWith({}));

    await dismissLikeProduction(sdk);

    expect(suppressedUntilFor(sdk)).toBe(now + 7 * DAY);
  });

  it('an explicit metadata.cooldown_ms of 0 is honoured the same way', async () => {
    const sdk = makeSdk(playbookWith({ cooldownDays: 3 }));

    await dismissLikeProduction(sdk, { cooldown_ms: 0 });

    expect(suppressedUntilFor(sdk)).toBeUndefined();
  });

  it('a zero cooldown also reaches the impression history (no hidden 7-day suppression)', async () => {
    const sdk = makeSdk(playbookWith({ cooldownDays: 0 }));
    const recordDismissal = vi.spyOn(sdk.impressionHistory, 'recordDismissal');

    await dismissLikeProduction(sdk);

    expect(recordDismissal).toHaveBeenCalledWith(PLACEMENT_ID, PAYLOAD_ID, undefined, undefined, 0);
  });
});

describe('ST-1696 C3b — a bare CTA click starts no cooldown', () => {
  async function clickLikeProduction(sdk: RevTurbineCustomerSdk): Promise<void> {
    await sdk.trackTreatmentInteraction({
      userId: 'user_1',
      placementId: PLACEMENT_ID,
      treatmentId: PAYLOAD_ID,
      payloadId: PAYLOAD_ID,
      interactionType: 'cta_clicked',
    } as never);
  }

  it('a bare cta_clicked leaves the placement eligible', async () => {
    const sdk = makeSdk(playbookWith({}));
    const recordClickThru = vi.spyOn(sdk.impressionHistory, 'recordClickThru');

    await clickLikeProduction(sdk);

    expect(suppressedUntilFor(sdk)).toBeUndefined();
    expect(recordClickThru).not.toHaveBeenCalled();
  });

  it('even with an authored cooldown, a click does not start it', async () => {
    const sdk = makeSdk(playbookWith({ cooldownDays: 7 }));

    await clickLikeProduction(sdk);

    expect(suppressedUntilFor(sdk)).toBeUndefined();
  });

  it('a click-started window persisted by an older SDK is not honoured after hydration', () => {
    const writer = makeSdk(playbookWith({}));
    const state = Reflect.get(writer, 'interactionState') as Map<string, unknown>;
    const readKey = (Reflect.get(writer, 'interactionStateKey') as (i: unknown) => string).call(writer, {
      placementId: PLACEMENT_ID,
      userId: 'user_1',
    });
    state.set(readKey, {
      lastInteractionType: 'cta_clicked',
      suppressedUntil: Date.now() + 7 * DAY,
      updatedAt: new Date().toISOString(),
    });
    (Reflect.get(writer, 'persistInteractionState') as () => void).call(writer);

    const reader = makeSdk(playbookWith({}));

    expect(suppressedUntilFor(reader)).toBeUndefined();
  });

  describe('the persisted impression history (a 0.15.0-shaped store)', () => {
    const future = (): string => new Date(Date.now() + 7 * DAY).toISOString();
    const rowsFor = (sdk: RevTurbineCustomerSdk, rows: Array<{ outcome: string; at: string; until?: string }>): void => {
      const store = Reflect.get(sdk.impressionHistory, 'store') as {
        append(userId: string, record: unknown): void;
      };
      for (const row of rows) {
        store.append('u_test', {
          placementId: PLACEMENT_ID,
          outcome: row.outcome,
          occurredAt: row.at,
          ...(row.until ? { metadata: { suppressUntil: row.until } } : {}),
        });
      }
    };
    const hydrated = async (): Promise<RevTurbineCustomerSdk> => {
      const sdk = makeSdk(playbookWith({}));
      await sdk.impressionHistory.hydrate();
      return sdk;
    };

    it('a clicked_thru row with a future suppressUntil is not honoured after hydration', async () => {
      rowsFor(makeSdk(playbookWith({})), [{ outcome: 'clicked_thru', at: new Date().toISOString(), until: future() }]);
      const sdk = await hydrated();
      expect(sdk.impressionHistory.isSuppressedSync(PLACEMENT_ID)).toBe(false);
    });

    it('a dismissed row with a future suppressUntil is still honoured', async () => {
      rowsFor(makeSdk(playbookWith({})), [{ outcome: 'dismissed', at: new Date().toISOString(), until: future() }]);
      const sdk = await hydrated();
      expect(sdk.impressionHistory.isSuppressedSync(PLACEMENT_ID)).toBe(true);
    });

    it('a dismiss followed by a later bare click stays suppressed (the click no longer masks it)', async () => {
      const t0 = new Date(Date.now() - 1000).toISOString();
      rowsFor(makeSdk(playbookWith({})), [
        { outcome: 'dismissed', at: t0, until: future() },
        { outcome: 'clicked_thru', at: new Date().toISOString(), until: future() },
      ]);
      const sdk = await hydrated();
      expect(sdk.impressionHistory.isSuppressedSync(PLACEMENT_ID)).toBe(true);
    });

    const windowOf = (sdk: RevTurbineCustomerSdk): number | undefined => {
      const cache = Reflect.get(sdk.impressionHistory, 'suppressedCache') as Map<string, string> | null;
      const until = cache?.get(PLACEMENT_ID);
      return until === undefined ? undefined : new Date(until).getTime();
    };
    const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
    const HOUR = 60 * 60 * 1000;
    const older = (): string => at(-2000);
    const newer = (): string => at(-1000);

    it('takes the NEWEST unexpired window: an older 7-day dismiss then a newer 1-hour suppression gives about 1 hour', async () => {
      rowsFor(makeSdk(playbookWith({})), [
        { outcome: 'dismissed', at: older(), until: at(7 * DAY) },
        { outcome: 'suppressed', at: newer(), until: at(HOUR) },
      ]);
      const until = windowOf(await hydrated());
      expect(until).toBeGreaterThan(Date.now());
      expect(until).toBeLessThanOrEqual(Date.now() + 2 * HOUR);
    });

    it('takes the NEWEST unexpired window in the other order too: older 1-hour then newer 7-day gives about 7 days', async () => {
      rowsFor(makeSdk(playbookWith({})), [
        { outcome: 'suppressed', at: older(), until: at(HOUR) },
        { outcome: 'dismissed', at: newer(), until: at(7 * DAY) },
      ]);
      const until = windowOf(await hydrated());
      expect(until).toBeGreaterThan(Date.now() + 6 * DAY);
    });

    it('a newer EXPIRED row does not mask an older unexpired one (core semantics)', async () => {
      rowsFor(makeSdk(playbookWith({})), [
        { outcome: 'dismissed', at: older(), until: at(3 * DAY) },
        { outcome: 'dismissed', at: newer(), until: at(-HOUR) },
      ]);
      const until = windowOf(await hydrated());
      expect(until).toBeGreaterThan(Date.now() + 2 * DAY);
    });

    it('a newest bare click is skipped and the older unexpired dismiss window is the one used', async () => {
      rowsFor(makeSdk(playbookWith({})), [
        { outcome: 'dismissed', at: older(), until: at(5 * DAY) },
        { outcome: 'clicked_thru', at: newer(), until: at(7 * DAY) },
      ]);
      const until = windowOf(await hydrated());
      expect(until).toBeGreaterThan(Date.now() + 4 * DAY);
      expect(until).toBeLessThan(Date.now() + 6 * DAY);
    });

    it('the public recordClickThru() starts no cooldown either', async () => {
      const sdk = makeSdk(playbookWith({}));
      await sdk.recordClickThru(PLACEMENT_ID, PAYLOAD_ID, undefined, undefined, 7 * DAY);
      expect(sdk.impressionHistory.isSuppressedSync(PLACEMENT_ID)).toBe(false);
    });
  });
});
