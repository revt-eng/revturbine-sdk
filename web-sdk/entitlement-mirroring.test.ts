/**
 * D-61 (Kent, 2026-10-06) — the browser SDK runs the shared core evaluation
 * (Playbook + user context) and merges app-mirrored entitlement data with the
 * configured precedence (default: app wins). The server SDKs run the same
 * function on the same inputs. Unknown handles fail closed with a warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initRevTurbine } from './customer-side';
import type { ConfigArtifact } from './customer-side';

const PLAYBOOK = {
  artifact_type: 'playbook', format_version: '1.0.0', playbook_handle: 'default',
  playbook_version_id: null, tenant_id: 't', environment_id: 'production',
  plans: [{ unique_handle: 'free', name: 'Free' }, { unique_handle: 'pro', name: 'Pro' }],
  entitlements: [{ unique_handle: 'exports', name: 'Exports', type: 'feature' }],
  entitlement_rules: [
    { id: 'r_exports_pro', entitlement_id: 'exports', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'feature', enabled: true } },
  ],
  reverse_trial_rules: [{ id: 'rt', fallback_plan_id: 'free', premium_plan_id: 'pro', entitlements_during_trial: ['exports'], is_active: true }],
  segments: [], content_ui_paths: [], placements: [],
} as unknown as ConfigArtifact;

function sdkFor(plan: string, extra: Record<string, unknown> = {}, userExtra: Record<string, unknown> = {}) {
  const sdk = initRevTurbine({
    tenantId: 't', runtimeMode: 'local_only', anonymousTelemetry: false,
    localRuntime: { playbook: PLAYBOOK },
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...extra,
  } as never);
  sdk.setUserContext({ id: 'u1', plan: { handle: plan, name: plan }, ...userExtra } as never);
  return sdk;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('D-61 — one effective entitlement answer in the browser', () => {
  it('evaluates the Playbook rules for the user context', async () => {
    expect((await sdkFor('free').checkEntitlement('exports')).status).toBe('denied');
    expect((await sdkFor('pro').checkEntitlement('exports')).status).toBe('allowed');
  });

  it('a mirrored user-context grant wins by default', async () => {
    const result = await sdkFor('free', {}, { entitlements: { exports: true } }).checkEntitlement('exports');
    expect(result).toMatchObject({ status: 'allowed', reason: 'entitlement_mirrored' });
  });

  it('entitlementMerge can make the Playbook win, or mix per field', async () => {
    const playbookWins = sdkFor('free', { entitlementMerge: { precedence: 'playbook' } }, { entitlements: { exports: true } });
    expect((await playbookWins.checkEntitlement('exports')).status).toBe('denied');
    const mixed = sdkFor('pro', { entitlementMerge: { fields: { status: 'playbook' } } }, {
      entitlements: { exports: { status: 'denied', used: 7, limit: 10 } },
    });
    expect(await mixed.checkEntitlement('exports')).toMatchObject({ status: 'allowed', used: 7, limit: 10 });
  });

  it('honours reverse-trial grants through the shared core helper', async () => {
    const sdk = sdkFor('free', {}, { trial: { in_trial: true, trial_type: 'reverse', plan_handle: 'free' } });
    expect((await sdk.checkEntitlement('exports')).status).toBe('allowed');
  });

  it('denies an unknown handle and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sdk = sdkFor('pro');
    expect(await sdk.checkEntitlement('never_defined')).toMatchObject({ status: 'denied', reason: 'entitlement_not_in_playbook' });
    await sdk.checkEntitlement('never_defined');
    expect(warn.mock.calls.filter(([m]) => String(m).includes('never_defined'))).toHaveLength(1);
  });

  it('an app-only entitlement the Playbook does not define is valid when mirrored', async () => {
    const result = await sdkFor('free', {}, { entitlements: { custom_seats: { status: 'allowed', limit: 5 } } }).checkEntitlement('custom_seats');
    expect(result).toMatchObject({ status: 'allowed', limit: 5 });
  });
});

describe('D-61 — app provides BOTH plan and entitlements (browser, same scenario as the server test)', () => {
  const MIXED = {
    ...PLAYBOOK,
    entitlements: [
      { unique_handle: 'exports', name: 'Exports', type: 'feature' },
      { unique_handle: 'api_calls', name: 'API calls', type: 'usage_limit' },
    ],
    entitlement_rules: [
      { id: 'r_exports_pro', entitlement_id: 'exports', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'feature', enabled: true } },
      { id: 'r_api_pro', entitlement_id: 'api_calls', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 1000, enforcement: 'hard_block' } },
    ],
  } as unknown as ConfigArtifact;
  const domainProviders = [
    { domain: 'plan', resolve: () => ({ currentPlanHandle: 'pro' }) },
    {
      domain: 'entitlements',
      resolve: () => ({
        entries: {
          api_calls: { status: 'denied', allowed: false, reason: 'billing_hold' },
          custom_seats: { status: 'allowed', allowed: true, limit: 5 },
        },
        usage: { api_calls: { used: 10, limit: 1000, remaining: 990 } },
      }),
    },
  ];
  const sdk = (merge?: Record<string, unknown>) => {
    const instance = initRevTurbine({
      tenantId: 't', runtimeMode: 'local_only', anonymousTelemetry: false,
      localRuntime: { playbook: MIXED }, domainProviders,
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      ...(merge ? { entitlementMerge: merge } : {}),
    } as never);
    // The user context says Free; the app's plan provider says Pro.
    instance.setUserContext({ id: 'u1', plan: { handle: 'free', name: 'Free' } } as never);
    return instance;
  };

  it('Playbook-only handle evaluates against the app-provided plan', async () => {
    expect(await sdk().checkEntitlement('exports')).toMatchObject({ status: 'allowed', rule_handle: 'r_exports_pro' });
  });

  it('overlapping handle: app entry wins by default; Playbook numbers fill the gaps', async () => {
    expect(await sdk().checkEntitlement('api_calls')).toMatchObject({
      status: 'denied', allowed: false, reason: 'billing_hold', limit: 1000, used: 10, remaining: 990,
    });
  });

  it('overlapping handle: precedence playbook / field-level status from the Playbook', async () => {
    expect(await sdk({ precedence: 'playbook' }).checkEntitlement('api_calls')).toMatchObject({ status: 'allowed', used: 10 });
    expect(await sdk({ fields: { status: 'playbook' } }).checkEntitlement('api_calls')).toMatchObject({ status: 'allowed', used: 10, limit: 1000 });
  });

  it('app-only handle comes from the app provider', async () => {
    expect(await sdk().checkEntitlement('custom_seats')).toMatchObject({ status: 'allowed', limit: 5, reason: 'entitlement_mirrored' });
  });
});

describe('D-61 — app segment provider membership reaches entitlement evaluation', () => {
  it('a segment-targeted rule matches membership the app provider reports', async () => {
    const playbook = {
      ...PLAYBOOK,
      entitlements: [{ unique_handle: 'beta_feature', name: 'Beta', type: 'feature' }],
      entitlement_rules: [{ id: 'r_beta', entitlement_id: 'beta_feature', targets: [{ kind: 'plan', id: 'free' }], segment_ids: ['beta_testers'], type_fields: { kind: 'feature', enabled: true } }],
      segments: [{ handle: 'beta_testers', name: 'Beta testers', predicates: [] }],
    } as unknown as ConfigArtifact;
    const sdk = initRevTurbine({
      tenantId: 't', runtimeMode: 'local_only', anonymousTelemetry: false, localRuntime: { playbook },
      domainProviders: [{ domain: 'segments', resolve: () => ({ segmentIds: ['beta_testers'], segmentSlugs: ['beta_testers'] }) }],
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    } as never);
    sdk.setUserContext({ id: 'u', plan: { handle: 'free', name: 'Free' } } as never);
    expect((await sdk.checkEntitlement('beta_feature')).status).toBe('allowed');
  });
});
