/**
 * Plan 194 REQ-10 (AC-8), superseded by ST-1416 — a blank or missing user id
 * at init disables the SDK and is reported ONCE, by name.
 *
 * Plan 194 only warned when a `user` object was supplied with a blank id, and
 * then fell back to an anonymous id and evaluated normally. ST-1416 (Kent,
 * 2026-11-01: "the playbook can't actually do anything without a UserContext
 * to evaluate against") removed the anonymous fallback: every shape of
 * "no usable id" — blank, whitespace, missing, omitted `user` — leaves the SDK
 * disabled with one typed `user_id_required` diagnostic, and never throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_blank',
    apiKey: 'sk_test',
    publicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  } as RevTurbineInitOptions);
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

const errors = (): string[] => errorSpy.mock.calls.map((c) => String(c[0]));
const userRequiredErrors = (): string[] => errors().filter((m) => m.includes('user_id_required'));

describe('a missing or blank user id at init is reported once and disables the SDK', () => {
  it.each([['empty string', ''], ['whitespace', '   '], ['a number', 42]])(
    'reports a supplied id that is %s',
    (_label, id) => {
      const sdk = makeSdk({ user: { id } as never });
      expect(userRequiredErrors()).toHaveLength(1);
      expect(userRequiredErrors()[0]).toContain('user: { id }');
      expect(sdk.getUserRequiredDiagnostic()).toMatchObject({ code: 'user_id_required', entryPoint: 'init' });
    },
  );

  it('reports a supplied user whose id is missing entirely', () => {
    const sdk = makeSdk({ user: { id: undefined } as never });
    expect(userRequiredErrors()).toHaveLength(1);
    expect(sdk.getUserRequiredDiagnostic()?.code).toBe('user_id_required');
  });

  it('reports an init with no user at all — there is no signed-out visitor mode', () => {
    const sdk = makeSdk();
    expect(userRequiredErrors()).toHaveLength(1);
    expect(sdk.getUserRequiredDiagnostic()?.entryPoint).toBe('init');
  });

  it.each([['null', null], ['a string', 'user_1']])('does not throw for a plain-JS user that is %s', (_l, user) => {
    expect(() => makeSdk({ user: user as never })).not.toThrow();
    expect(userRequiredErrors()).toHaveLength(1);
  });

  it('stays silent for a real id', () => {
    const sdk = makeSdk({ user: { id: 'user_1' } });
    expect(userRequiredErrors()).toHaveLength(0);
    expect(sdk.getUserRequiredDiagnostic()).toBeUndefined();
  });

  it('still initialises — the SDK never refuses to start over a bad id, and holds no user', () => {
    // The fallback guarantee: a monetization SDK must not take down the host
    // app. It reports and sits disabled; the held context has no identity.
    const sdk = makeSdk({ user: { id: '' } });
    expect(sdk.getUserContext().user_id).toBe('');
  });

  it('logs the init diagnostic once however many checks follow', async () => {
    const sdk = makeSdk({ user: { id: '' } });
    await sdk.checkEntitlement('a');
    await sdk.checkEntitlement('b');
    expect(userRequiredErrors()).toHaveLength(1);
  });
});
