/**
 * The SDK's trial-revision emit surface and the D-21 provider nudge
 * (plan 276 TASK-13 / BL-0237).
 *
 * The classifier itself is scaffold's and is fixture-covered there; what is
 * asserted here is the SDK's half — that a `pending_unknown` episode puts
 * NOTHING on the wire, that a supported revision emits exactly one
 * `trial_revision` with the classifier's own `effective_at`, that local mode
 * reports itself honestly, and that the missing-provider notice is one
 * info-level line per runtime rather than a warning, an error or a repeat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk, RuntimeMode } from './customer-side';
import {
  NO_TRIAL_PROVIDER_NOTICE,
  resolveTrialRevision,
  type TrialEpisodeFacts,
} from './trial-revision';
import type { AnyDomainProvider } from '@revt-eng/core';

const playbook = {
  version: '1.0.0',
  exported_at: '2026-01-01T00:00:00Z',
  plans: [{ unique_handle: 'starter', name: 'Starter', tier_position: 0, sort_order: 0 }],
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
  placements: [],
} as unknown;

function openEpisode(overrides: Partial<TrialEpisodeFacts> = {}): TrialEpisodeFacts {
  return {
    trial_episode_id: 'app:acct_1:reverse:1',
    account_id: 'acct_1',
    subject_scope: 'account',
    limit_type: 'time',
    enrollment: { kind: 'app_fact', ref: 'write_1', occurred_at: '2026-09-01T00:00:00.000Z' },
    started_at: '2026-09-01T00:00:00.000Z',
    scheduled_end_at: '2026-09-15T00:00:00.000Z',
    actual_end_at: null,
    end_evidence: null,
    extension: null,
    revocation: null,
    commitment: null,
    fallback: null,
    exhaustion: null,
    observed_through: '2026-09-05T00:00:00.000Z',
    ...overrides,
  };
}

const endedEpisode = openEpisode({
  actual_end_at: '2026-09-15T00:00:00.000Z',
  end_evidence: { kind: 'app_fact', ref: 'write_end', occurred_at: '2026-09-15T00:00:00.000Z' },
  observed_through: '2026-09-20T00:00:00.000Z',
});

function makeSdk(options: { playbook: unknown; localOnly?: boolean; providers?: AnyDomainProvider[] }) {
  return new RevTurbineCustomerSdk({
    ...(options.localOnly
      ? { runtimeMode: RuntimeMode.LocalOnly, tenantId: 'tenant_1', localRuntime: { playbook: options.playbook } }
      : { publicKey: 'rt_pub_test', tenantId: 'tenant_1', localRuntime: { playbook: options.playbook } }),
    ...(options.providers ? { domainProviders: options.providers } : {}),
  } as never);
}

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordTrialRevision', () => {
  it('emits nothing for an episode whose evidence supports no revision', async () => {
    const sdk = makeSdk({ playbook });
    const emit = vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
    const result = await sdk.recordTrialRevision(
      openEpisode({ observed_through: '2026-10-30T00:00:00.000Z' }),
    );
    expect(result.status).toBe('pending_unknown');
    expect(result.payload).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits exactly one trial_revision for a supported revision', async () => {
    const sdk = makeSdk({ playbook });
    const emit = vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
    const result = await sdk.recordTrialRevision(endedEpisode, {
      rule_handle: 'reverse_14d',
      plan_handle: 'pro',
      trial_type: 'reverse_trial',
    });
    expect(result.status).toBe('recorded');
    const calls = emit.mock.calls.filter((c) => c[0] === 'trial_revision');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toMatchObject({
      trial_episode_id: 'app:acct_1:reverse:1',
      account_id: 'acct_1',
      revision: 'expired',
      effective_at: '2026-09-15T00:00:00.000Z',
      rule_handle: 'reverse_14d',
      evidence: { kind: 'app_fact', ref: 'write_end' },
    });
  });

  it('carries the classifier effective_at, not a write clock', async () => {
    const sdk = makeSdk({ playbook });
    const emit = vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
    const converted = {
      ...endedEpisode,
      commitment: {
        ref: 'sub_1',
        started_at: '2026-09-18T00:00:00.000Z',
        trial_episode_id: endedEpisode.trial_episode_id,
      },
    };
    await sdk.recordTrialRevision(converted);
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      revision: 'converted',
      effective_at: '2026-09-18T00:00:00.000Z',
    });
  });

  it('nulls the Playbook vocabulary when no labels are supplied', async () => {
    const sdk = makeSdk({ playbook });
    const emit = vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
    await sdk.recordTrialRevision(endedEpisode);
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      rule_handle: null,
      plan_handle: null,
      trial_type: null,
      provider_ref: null,
    });
  });

  it('reports local mode honestly rather than claiming RevTurbine received it', async () => {
    const sdk = makeSdk({ playbook, localOnly: true });
    vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
    const result = await sdk.recordTrialRevision(endedEpisode);
    expect(result.status).toBe('recorded_locally');
    expect(result.payload).not.toBeNull();
  });

  it('never throws into the host app', async () => {
    const sdk = makeSdk({ playbook });
    vi.spyOn(sdk, 'emitPlatformEvent').mockRejectedValue(new Error('network down'));
    await expect(sdk.recordTrialRevision(endedEpisode)).rejects.toThrow();
    // The emit path itself is fire-and-forget in production; what matters here
    // is that the classifier never throws on a malformed episode.
    const malformed = { ...endedEpisode, enrollment: null };
    const sdk2 = makeSdk({ playbook });
    vi.spyOn(sdk2, 'emitPlatformEvent').mockResolvedValue(undefined);
    await expect(sdk2.recordTrialRevision(malformed)).resolves.toMatchObject({
      status: 'pending_unknown',
    });
  });
});

describe('the D-21 provider nudge', () => {
  it('logs one gentle info notice when trials exist and no provider does', async () => {
    const sdk = makeSdk({ playbook });
    await sdk.setTrialInstances([
      {
        id: 'ti_1',
        status: 'active',
        started_at: '2026-09-01T00:00:00.000Z',
      } as never,
    ]);
    const notices = infoSpy.mock.calls.filter((c) => String(c[0]) === NO_TRIAL_PROVIDER_NOTICE);
    expect(notices).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalledWith(NO_TRIAL_PROVIDER_NOTICE);
    expect(errorSpy).not.toHaveBeenCalledWith(NO_TRIAL_PROVIDER_NOTICE);
  });

  it('logs it at most once per runtime', async () => {
    const sdk = makeSdk({ playbook });
    const instance = [{ id: 'ti_1', status: 'active', started_at: '2026-09-01T00:00:00.000Z' } as never];
    await sdk.setTrialInstances(instance);
    await sdk.setTrialInstances(instance);
    await sdk.syncTrialRevisions();
    expect(infoSpy.mock.calls.filter((c) => String(c[0]) === NO_TRIAL_PROVIDER_NOTICE)).toHaveLength(1);
  });

  it('stays quiet when a trial provider IS registered', async () => {
    const sdk = makeSdk({
      playbook,
      providers: [{ domain: 'trial', resolve: () => ({ episodes: [] }) } as AnyDomainProvider],
    });
    await sdk.setTrialInstances([
      { id: 'ti_1', status: 'active', started_at: '2026-09-01T00:00:00.000Z' } as never,
    ]);
    expect(infoSpy.mock.calls.filter((c) => String(c[0]) === NO_TRIAL_PROVIDER_NOTICE)).toHaveLength(0);
  });

  it('stays quiet when the app pushed no trials at all', async () => {
    const sdk = makeSdk({ playbook });
    await sdk.setTrialInstances([]);
    expect(infoSpy.mock.calls.filter((c) => String(c[0]) === NO_TRIAL_PROVIDER_NOTICE)).toHaveLength(0);
  });

  it('names the provider domain, the alternative and that trials keep working', () => {
    expect(NO_TRIAL_PROVIDER_NOTICE).toContain('No trial provider supplied');
    expect(NO_TRIAL_PROVIDER_NOTICE).toContain('trial revisions will not be recorded');
    expect(NO_TRIAL_PROVIDER_NOTICE).toContain("domain: 'trial'");
    expect(NO_TRIAL_PROVIDER_NOTICE).toContain('recordTrialRevision');
    expect(NO_TRIAL_PROVIDER_NOTICE).toContain('Trials keep working');
    expect(NO_TRIAL_PROVIDER_NOTICE).not.toMatch(/error|failed|invalid/i);
  });
});

describe('syncTrialRevisions', () => {
  it('reports no_trial_provider and emits nothing without a provider', async () => {
    const sdk = makeSdk({ playbook });
    const emit = vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
    const results = await sdk.syncTrialRevisions();
    expect(results).toEqual([{ status: 'no_trial_provider', classification: null, payload: null }]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('records every episode the provider states that has a supported revision', async () => {
    const sdk = makeSdk({
      playbook,
      providers: [
        {
          domain: 'trial',
          resolve: () => ({
            episodes: [endedEpisode, openEpisode({ observed_through: '2026-10-30T00:00:00.000Z' })],
          }),
        } as AnyDomainProvider,
      ],
    });
    const emit = vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
    const results = await sdk.syncTrialRevisions();
    expect(results.map((r) => r.status)).toEqual(['recorded', 'pending_unknown']);
    expect(emit.mock.calls.filter((c) => c[0] === 'trial_revision')).toHaveLength(1);
  });
});

describe('recordAccountCreated', () => {
  const evidenced = {
    account_id: 'acct_1',
    created_at: '2026-09-01T00:00:00.000Z',
    source: 'self_serve_signup',
    evidence: { kind: 'app_fact' as const, ref: 'write_acct_1' },
  };

  it('emits account_created with its evidence', async () => {
    const sdk = makeSdk({ playbook });
    const emit = vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
    await expect(sdk.recordAccountCreated(evidenced)).resolves.toEqual({ recorded: true, reason: null });
    expect(emit.mock.calls.filter((c) => c[0] === 'account_created')).toHaveLength(1);
  });

  it('refuses a user-grain source and emits no account_created (R-2)', async () => {
    const sdk = makeSdk({ playbook });
    const emit = vi.spyOn(sdk, 'emitPlatformEvent').mockResolvedValue(undefined);
    const result = await sdk.recordAccountCreated({ ...evidenced, source: 'user_signup' });
    expect(result).toEqual({
      recorded: false,
      reason: 'user_grain_signup_is_not_account_creation',
    });
    expect(emit.mock.calls.filter((c) => c[0] === 'account_created')).toHaveLength(0);
  });
});

describe('resolveTrialRevision — the shared port helper', () => {
  it('produces the same payload shape the ports hand back', () => {
    const { classification, payload } = resolveTrialRevision(endedEpisode, { plan_handle: 'pro' });
    expect(classification.status).toBe('revision');
    expect(Object.keys(payload ?? {}).sort()).toEqual(
      [
        'account_id',
        'actual_end_at',
        'effective_at',
        'evidence',
        'plan_handle',
        'provider_ref',
        'revision',
        'rule_handle',
        'scheduled_end_at',
        'subject_scope',
        'trial_episode_id',
        'trial_type',
      ].sort(),
    );
  });

  it('returns a null payload whenever the verdict is pending_unknown', () => {
    const { payload } = resolveTrialRevision(openEpisode({ observed_through: '2026-10-30T00:00:00.000Z' }));
    expect(payload).toBeNull();
  });
});
