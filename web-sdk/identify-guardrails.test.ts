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

describe('identify() plan identity is handle-based (plan 191 REQ-1/REQ-2)', () => {
  // The resolver is asserted through the public targeting snapshot (the same
  // resolution the entitlement path consumes). Plan 191 retired the plan-168
  // three-spellings convergence: `plan_handle` is THE matching identity, the
  // `plan` object is display metadata, and `custom` never drives the SDK's
  // own plan semantics.
  it('{ plan_handle } resolves the plan and matches the rule', async () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { plan_handle: 'starter' });
    expect(sdk.getTargeting().plan?.toLowerCase()).toBe('starter');
    const res = await sdk.checkEntitlement('generations');
    expect(res.status).not.toBe('denied');
    expect(res.limit).toBe(30);
    expect(warnings().join('\n')).not.toContain('unrecognized');
  });

  it('plan.id (DB-internal) never participates in matching (REQ-1)', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { plan: { id: 'starter', name: 'Starter' } });
    expect(sdk.getTargeting().plan).toBeUndefined();
  });

  // The removed key is REJECTED, not silently tolerated: TypeScript stops it
  // at compile time, but a plain-JS caller would otherwise get a user with no
  // plan and every plan-targeted rule quietly failing closed.
  it('rejects a removed plan.id: strips it, errors loudly, and says matching is broken', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { plan: { id: 'starter', name: 'Starter' } } as never);

    const errors = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(errors.some((m) => m.includes('plan.id'))).toBe(true);
    expect(errors.some((m) => m.includes('unique_handle'))).toBe(true);
    // Names the consequence, so the integrator knows this is not cosmetic.
    expect(errors.some((m) => m.includes('plan-targeted rules will not match'))).toBe(true);
    // The legacy key never reaches the stored context.
    expect(sdk.getUserContext().plan).toEqual({ name: 'Starter' });
  });

  it('keeps the handle when both handle and legacy id are supplied', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { plan: { handle: 'starter', id: 'pl_123', name: 'Starter' } } as never);

    expect(sdk.getUserContext().plan).toEqual({ handle: 'starter', name: 'Starter' });
    expect(errorSpy.mock.calls.map((c) => String(c[0]))
      .some((m) => m.includes('plan matching is unaffected'))).toBe(true);
  });

  it('reports the removed plan.id once per session, not on every call', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { plan: { id: 'starter', name: 'Starter' } } as never);
    sdk.identify('user_1', { plan: { id: 'starter', name: 'Starter' } } as never);

    const planIdErrors = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('plan.id'));
    expect(planIdErrors).toHaveLength(1);
  });

  it('rejects the removed plan.id through setUserContext too', () => {
    const sdk = makeLocalSdk();
    sdk.setUserContext({ id: 'user_1', plan: { id: 'starter', name: 'Starter' } } as never);

    expect(errorSpy.mock.calls.map((c) => String(c[0]))
      .some((m) => m.includes('setUserContext()'))).toBe(true);
    expect(sdk.getUserContext().plan).toEqual({ name: 'Starter' });
  });

  it('custom never drives plan resolution (REQ-2)', () => {
    const viaHandleKey = makeLocalSdk();
    viaHandleKey.identify('user_1', { custom: { plan_handle: 'starter' } });
    expect(viaHandleKey.getTargeting().plan).toBeUndefined();

    const viaPlanKey = makeLocalSdk();
    viaPlanKey.identify('user_1', { custom: { plan: 'starter' } });
    expect(viaPlanKey.getTargeting().plan).toBeUndefined();
  });

  it('identify() writes nothing into custom for its own semantics (AC-2)', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { plan_handle: 'starter', custom: { role: 'editor' } });
    expect(sdk.getUserContext().custom).toEqual({ role: 'editor' });
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

describe('identify() unrecognized keys are dropped and reported (plan 191 REQ-3 / Q-5)', () => {
  // Plan 191 Q-2 retired the legacy plain-traits overload: a bare trait no
  // longer routes into `custom` silently. TypeScript rejects it at compile
  // time (see user-context-exactness.test-d.ts); these pin the runtime half
  // for plain-JS callers, which is where the original trap actually shipped.
  it('drops an unrecognized top-level key instead of routing it into custom', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { favorite_color: 'red' } as never);
    expect(sdk.getUserContext().id).toBe('user_1');
    expect(sdk.getUserContext().custom?.favorite_color).toBeUndefined();
  });

  it('reports the dropped keys prod-visibly, once per session, without their values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sdk = makeLocalSdk();
      sdk.identify('user_1', { context: { plan_handle: 'starter' } } as never);
      sdk.identify('user_2', { context: { plan_handle: 'starter' } } as never);

      const reports = warn.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('unrecognized user-context key'));
      expect(reports).toHaveLength(1); // deduped for the session
      expect(reports[0]).toContain('context');
      expect(reports[0]).toContain('custom'); // points at the right home
      expect(reports[0]).not.toContain('starter'); // key names only, never values
    } finally {
      warn.mockRestore();
    }
  });

  it('still records the customer-supplied custom map', () => {
    const sdk = makeLocalSdk();
    sdk.identify('user_1', { custom: { favorite_color: 'red' } });
    expect(sdk.getUserContext()).toMatchObject({ id: 'user_1', custom: { favorite_color: 'red' } });
  });
});

describe('identify() id guardrails (AC-5)', () => {
  it('rejects an empty id — the call is ignored', () => {
    const sdk = makeLocalSdk();
    // Seeded with the CURRENT plan shape: the legacy `plan.id` now raises its
    // own rejection error, which would make this exact-count assertion about
    // something other than the empty id it is testing.
    sdk.identify('user_1', { plan_handle: 'starter' });
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
