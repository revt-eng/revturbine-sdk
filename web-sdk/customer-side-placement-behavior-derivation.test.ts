/**
 * Plan 174 TASK-2 (F-72) — placementBehavior flags derive from the Playbook.
 *
 * The three flags previously defaulted to `false`, so authored caps and trial
 * placements did nothing until every app opted in. These tests pin the
 * derivation (AC-2): a Playbook that authors caps / gated placements / trial
 * placements turns the matching flag on with no `placementBehavior` option; a
 * Playbook that authors none leaves every flag `false` (behavior unchanged);
 * an explicit option — true or false — always wins over the derivation.
 *
 * Plan: docs/dev-lifecycle/inprogress/174-spec-check-remediation-batch.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RevTurbineCustomerSdk,
  type RevTurbineInitOptions,
  type RevTurbinePlacementBehaviorFlags,
} from './customer-side';
import type { RevTurbineConfig } from '@revt-eng/schema';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeConfig(over: Record<string, unknown> = {}): RevTurbineConfig {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
    ...over,
  } as unknown as RevTurbineConfig;
}

function makeSdk(
  config: RevTurbineConfig | undefined,
  placementBehavior?: Partial<RevTurbinePlacementBehaviorFlags>,
): RevTurbineCustomerSdk {
  const options: RevTurbineInitOptions = {
    tenantId: 'tenant_behavior_derivation',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...(config ? { localRuntime: { exportedConfig: config } } : {}),
    ...(placementBehavior ? { placementBehavior } : {}),
  };
  return new RevTurbineCustomerSdk(options);
}

function flags(sdk: RevTurbineCustomerSdk): RevTurbinePlacementBehaviorFlags {
  return sdk.getPolicy().placementBehavior;
}

const CAPPED_PLACEMENT = {
  id: 'pl_capped',
  name: 'Capped nudge',
  category: 'usage_credit_seat',
  trigger: { kind: 'threshold' },
  order: 0,
  payloads: [
    {
      id: 'pay_1',
      target: {},
      surfaces: [],
      caps: { max_per_period: { count: 1, period: 'lifetime' } },
    },
  ],
};

describe('placementBehavior derivation from the Playbook (AC-2)', () => {
  it('authored payload caps turn on caps enforcement with no placementBehavior option', () => {
    const sdk = makeSdk(makeConfig({ placements: [CAPPED_PLACEMENT] }));
    expect(flags(sdk)).toEqual({
      enableClientCapsEnforcement: true,
      enableAutoGatedPlacement: false,
      enableTrialAutoTriggers: false,
    });
  });

  it('an authored remind_later_minutes window also counts as authored caps', () => {
    const sdk = makeSdk(
      makeConfig({
        placements: [
          {
            ...CAPPED_PLACEMENT,
            payloads: [{ id: 'pay_1', target: {}, surfaces: [], remind_later_minutes: 45 }],
          },
        ],
      }),
    );
    expect(flags(sdk).enableClientCapsEnforcement).toBe(true);
  });

  it('caps on a standalone placement_payloads entry count too', () => {
    const sdk = makeSdk(
      makeConfig({
        placement_payloads: [
          {
            payload_id: 'pp_1',
            placement_id: 'pl_1',
            target: {},
            caps: { cooldown_days: 7 },
            source_mode: 'inline',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    expect(flags(sdk).enableClientCapsEnforcement).toBe(true);
  });

  it('a gated-category placement turns on auto gated placement', () => {
    const sdk = makeSdk(
      makeConfig({
        placements: [
          { id: 'pl_gate', name: 'Gate', category: 'gated', trigger: { kind: 'gate' }, order: 0, payloads: [] },
        ],
      }),
    );
    expect(flags(sdk)).toEqual({
      enableClientCapsEnforcement: false,
      enableAutoGatedPlacement: true,
      enableTrialAutoTriggers: false,
    });
  });

  it('a trials-category placement turns on trial auto-triggers', () => {
    const sdk = makeSdk(
      makeConfig({
        placements: [
          { id: 'pl_trial', name: 'Trial nudge', category: 'trials', trigger: { kind: 'trial' }, order: 0, payloads: [] },
        ],
      }),
    );
    expect(flags(sdk).enableTrialAutoTriggers).toBe(true);
  });

  it('a Playbook that authors none of these leaves every flag false', () => {
    const sdk = makeSdk(
      makeConfig({
        placements: [
          { id: 'pl_plain', name: 'Plain banner', category: 'fixed', trigger: { kind: 'fixed' }, order: 0, payloads: [{ id: 'pay_1', target: {}, surfaces: [] }] },
        ],
      }),
    );
    expect(flags(sdk)).toEqual({
      enableClientCapsEnforcement: false,
      enableAutoGatedPlacement: false,
      enableTrialAutoTriggers: false,
    });
  });

  it('no loaded config leaves every flag false', () => {
    const sdk = makeSdk(undefined);
    expect(flags(sdk)).toEqual({
      enableClientCapsEnforcement: false,
      enableAutoGatedPlacement: false,
      enableTrialAutoTriggers: false,
    });
  });

  it('an explicit false override wins over authored caps', () => {
    const sdk = makeSdk(makeConfig({ placements: [CAPPED_PLACEMENT] }), {
      enableClientCapsEnforcement: false,
    });
    expect(flags(sdk).enableClientCapsEnforcement).toBe(false);
  });

  it('an explicit true override wins when nothing is authored', () => {
    const sdk = makeSdk(makeConfig(), { enableTrialAutoTriggers: true });
    expect(flags(sdk).enableTrialAutoTriggers).toBe(true);
  });
});
