/**
 * Plan 168 TASK-2/3/4 (+ plan 170 TASK-1's optional rider) — identity contract
 * guardrails:
 *   - AC-3: unrecognized top-level context keys warn in dev (naming the keys
 *     and the recognized set) instead of routing silently to legacy traits.
 *   - AC-4: `{ plan_handle }` resolves the plan identically to
 *     `{ plan: { id, name } }`, and the entitlement path reads all three plan
 *     spellings (`plan.id`, `custom.plan`, `custom.plan_handle`) through one
 *     resolver (REQ-4).
 *   - AC-5: an empty id is rejected; an email-shaped id warns.
 *   - AC-6: legacy-traits integrations behave identically (warning aside).
 *   - update() rider: non-`usage` keys warn instead of silently no-oping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions, RevTurbineUpdateInput } from './customer-side';

// A local Playbook granting `generations` (usage_limit, under limit) only to
// the `starter` plan — mirrors the known-good usage-limit fixture shape. A
// user resolved to `starter` gets allowed; an unresolved plan fails closed.
const LOCAL_CONFIG = {
  version: '1.0.0',
  plans: [{ unique_handle: 'starter', name: 'Starter', tier_position: 0, sort_order: 0 }],
  entitlements: [{ unique_handle: 'generations', name: 'Generations', type: 'usage_limit', unit: 'images' }],
  entitlement_rules: [
    {
      id: 'r_starter', entitlement_id: 'generations', targets: [{ kind: 'plan', id: 'starter' }], segment_ids: [],
      kind: 'usage_limit', limit_value: 30, unit: 'images', period_scope: 'per_month', enforcement: 'hard_block',
    },
  ],
  segments: [], content_ui_paths: [], surface_templates: [], placements: [],
} as never;

function makeLocalSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_identity',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: LOCAL_CONFIG },
    ...over,
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

describe('identify() plan spellings converge (AC-4 / REQ-4)', () => {
  // The resolver is asserted through the public targeting snapshot (the same
  // resolution the entitlement path consumes) — core's unknown-plan fallback
  // semantics stay out of the assertion. Canonical-vs-alias additionally
  // asserts identical end-to-end entitlement results (AC-4 verbatim).
  it('canonical { plan: { id, name } } resolves the plan and matches the rule', async () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { plan: { id: 'starter', name: 'Starter' } });
    expect(sdk.getTargeting().plan?.toLowerCase()).toBe('starter');
    const res = await sdk.checkEntitlement('generations');
    expect(res.status).not.toBe('denied');
    expect(res.limit).toBe(30);
  });

  it('{ plan_handle } aliases to plan and resolves identically (AC-4)', async () => {
    const canonical = makeLocalSdk();
    canonical.identify('user_1', { plan: { id: 'starter', name: 'starter' } });
    const canonicalRes = await canonical.checkEntitlement('generations');

    const aliased = makeLocalSdk();
    aliased.identify('user_1', { plan_handle: 'starter' });
    expect(aliased.getTargeting().plan?.toLowerCase()).toBe('starter');
    const aliasRes = await aliased.checkEntitlement('generations');

    expect(aliasRes).toEqual(canonicalRes);
    expect(warnings().join('\n')).not.toContain('unrecognized');
  });

  it('{ custom: { plan_handle } } is read by the plan resolver (REQ-4 leg 3)', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { custom: { plan_handle: 'starter' } });
    expect(sdk.getTargeting().plan?.toLowerCase()).toBe('starter');
  });

  it('{ custom: { plan } } (legacy spelling) still resolves', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { custom: { plan: 'starter' } });
    expect(sdk.getTargeting().plan?.toLowerCase()).toBe('starter');
  });

  it('an unrecognized wrapper shape never resolves the plan (the documented trap)', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { context: { plan_handle: 'starter' } } as never);
    expect(sdk.getUserContext().plan).toBeUndefined();
    expect(sdk.getTargeting().plan).toBeUndefined();
  });
});

describe('identify() unrecognized-key warning (AC-3)', () => {
  it('warns naming the unrecognized key and listing the recognized set', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { context: { plan_handle: 'starter' } } as never);
    const all = warnings().join('\n');
    expect(all).toContain('context');
    expect(all).toContain('plan_handle');
    expect(all).toContain('custom');
  });

  it('warns on an unrecognized key riding a canonical input', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { plan: { id: 'starter', name: 'Starter' }, favourite: 'blue' } as never);
    expect(warnings().join('\n')).toContain('favourite');
  });

  it('stays silent for a fully canonical input', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { plan: { id: 'starter', name: 'Starter' }, custom: { role: 'editor' } });
    expect(warnings().join('\n')).not.toContain('unrecognized');
  });
});

describe('identify() legacy traits stay compatible (AC-6)', () => {
  it('routes a plain traits object into custom exactly as before (plus a dev diagnostic)', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { favorite_color: 'red' });
    expect(sdk.getUserContext()).toMatchObject({ id: 'user_1', custom: { favorite_color: 'red' } });
    expect(warnings().join('\n')).toContain('legacy');
  });
});

describe('identify() id guardrails (AC-5)', () => {
  it('rejects an empty id — the call is ignored', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { plan: { id: 'starter', name: 'Starter' } });
    sdk.identify('   ');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(sdk.getUserContext().id).toBe('user_1');
  });

  it('warns on an email-shaped id but proceeds', () => {
    const sdk = makeLocalSdk();
    sdk.identify('kent@example.com');
    expect(warnings().join('\n')).toContain('email-shaped');
    expect(sdk.getUserContext().id).toBe('kent@example.com');
  });
});

describe('update() unknown-key warning (plan 170 TASK-1 rider)', () => {
  it('warns and does not apply usage for the legacy bare-handle shape', () => {
    const sdk = makeLocalSdk();
    sdk.update({ credits: 800 } as unknown as RevTurbineUpdateInput);
    expect(warnings().join('\n')).toContain('credits');
  });

  it('stays silent for the supported { usage } shape', () => {
    const sdk = makeLocalSdk();
    sdk.update({ usage: { generations: 5 } });
    expect(warnings().join('\n')).not.toContain('update()');
  });
});
