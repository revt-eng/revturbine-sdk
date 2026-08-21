/**
 * Plan 194 REQ-2 / REQ-5 (AC-2) — reported usage that goes nowhere is reported.
 *
 * Two silent failures, both generous:
 *
 *  - **A mis-keyed usage report** (`generatons` for `generations`) reads as
 *    zero consumed at any real consumption, so the limit never bites and the
 *    check grants forever. Nothing on the path noticed, and the mistake
 *    survives review because the correctly-keyed entitlement works in the same
 *    session.
 *  - **A mis-shaped usage value** — the entry object `init` accepts, passed to
 *    `update()`, which types usage as `Record<string, number>` — used to be
 *    worse than passing nothing: `getUsage()` skipped the non-finite value so
 *    the meter read empty, while the decision kept evaluating the OLD balance.
 *    Meter and gate silently disagreeing.
 *
 * Warn-only by ruling (Q-2): usage reporting is optional, so the SDK cannot
 * distinguish `used: 0` from "never reported", and denying on an unmatched key
 * would break every legitimately-zero user. These tests pin the warning, not a
 * denial.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';

const PLAYBOOK = {
  version: '1.0.0',
  plans: [{ unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 0 }],
  entitlements: [
    { unique_handle: 'generations', name: 'Generations', type: 'usage_limit', unit: 'runs' },
    { unique_handle: 'seats', name: 'Seats', type: 'seat' },
  ],
  entitlement_rules: [
    {
      id: 'r_gen',
      entitlement_id: 'generations',
      targets: [{ kind: 'plan', id: 'pro' }],
      segment_ids: [],
      kind: 'usage_limit',
      limit_value: 10,
      enforcement: 'hard_block',
    },
  ],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [],
};

function localSdk(): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    tenantId: 'tenant_usage',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    localRuntime: { playbook: PLAYBOOK as never },
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
  });
  sdk.setUserContext({ id: 'user_usage', plan_handle: 'pro' });
  return sdk;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

describe('a usage key matching no entitlement handle is reported', () => {
  it('warns, naming the unmatched key and the handles it could have meant', () => {
    localSdk().updateUsage({ generatons: 999 });

    const warned = warnings().filter((m) => m.includes('matching no entitlement'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('generatons');
    // The known handles are listed, because "check for a typo" is only
    // actionable next to the list you were meant to type from.
    expect(warned[0]).toContain('generations');
  });

  it('does not warn for a correctly-keyed entitlement', () => {
    localSdk().updateUsage({ generations: 5 });
    expect(warnings().filter((m) => m.includes('matching no entitlement'))).toHaveLength(0);
  });

  it('warns once per key set, not on every report', () => {
    const sdk = localSdk();
    sdk.updateUsage({ generatons: 1 });
    sdk.updateUsage({ generatons: 2 });
    sdk.updateUsage({ generatons: 3 });
    expect(warnings().filter((m) => m.includes('matching no entitlement'))).toHaveLength(1);
  });

  it('still stores the balance — the ruling is warn, never deny', () => {
    const sdk = localSdk();
    sdk.updateUsage({ generatons: 42 });
    // The mis-keyed entry remains visible in getUsage(), which is the one
    // symptom a developer can see without reading the console.
    expect(Object.keys(sdk.getUsage())).toContain('generatons');
  });

  it('stays silent when no Playbook has loaded', () => {
    const sdk = new RevTurbineCustomerSdk({
      tenantId: 'tenant_usage',
      apiKey: 'sk_test',
      ingestPublicKey: 'pub_test',
      endpoint: 'https://edge.example.com',
      mode: 'snippet',
      runtimeMode: 'revturbine_server',
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    });
    sdk.setUserContext({ id: 'user_usage', plan_handle: 'pro' });
    sdk.updateUsage({ anything_at_all: 1 });

    // Validating against a config we do not have would warn on every correct
    // key during Server mode's startup window, which trains people to ignore
    // the warning.
    expect(warnings().filter((m) => m.includes('matching no entitlement'))).toHaveLength(0);
  });
});

describe('a usage value the SDK cannot read is reported, not dropped', () => {
  it('accepts the init entry-object shape rather than silently discarding it', () => {
    const sdk = localSdk();
    sdk.updateUsage({
      generations: { entitlement_handle: 'generations', unit: 'runs', amount: 7 },
    } as never);

    // The meter reflects the reported balance instead of reading empty.
    expect(sdk.getUsage().generations?.current).toBe(7);
    expect(warnings().filter((m) => m.includes('could not read'))).toHaveLength(0);
  });

  it('warns when a value is neither a number nor an entry object', () => {
    localSdk().updateUsage({ generations: 'lots' } as never);

    const warned = warnings().filter((m) => m.includes('could not read'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('generations');
    // The consequence is what makes this actionable: the limit is still
    // evaluating the previous value, not the one just reported.
    expect(warned[0]).toContain('still evaluating the previous value');
  });

  it('leaves the meter and the decision agreeing after a mis-shaped report', async () => {
    const sdk = localSdk();
    sdk.updateUsage({ generations: 9 });
    const before = await sdk.checkEntitlement('generations');
    expect(before.allowed).toBe(true);

    // A mis-shaped report must not wipe the meter while the gate keeps the old
    // balance — the two must never disagree.
    sdk.updateUsage({ generations: { bogus: true } } as never);
    const after = await sdk.checkEntitlement('generations');

    expect(sdk.getUsage().generations?.current).toBe(9);
    expect(after.allowed).toBe(before.allowed);
  });
});
