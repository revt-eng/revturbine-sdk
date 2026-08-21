/**
 * Plan 194 REQ-10 (AC-8) — a blank user id at init is reported.
 *
 * `identify('')` has always been refused loudly. `init` was not: an app that
 * meant to supply an id and had none fell through to an anonymous id and
 * evaluated normally, so caps, usage attribution and analytics identity all
 * keyed to a user that does not exist — silently.
 *
 * The check is deliberately narrow. Omitting `user` entirely is legitimate: a
 * signed-out visitor is exactly what the anonymous id is for, and warning on
 * that would be noise people learn to ignore. It fires only when a `user`
 * object IS supplied and its id is blank — the caller intended identity and
 * did not get it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_blank',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

const errors = (): string[] => errorSpy.mock.calls.map((c) => String(c[0]));
const blankIdErrors = (): string[] => errors().filter((m) => m.includes('blank id'));

describe('a blank user id at init is reported', () => {
  it.each([['empty string', ''], ['whitespace', '   ']])(
    'reports a supplied id that is %s',
    (_label, id) => {
      makeSdk({ user: { id } as never });
      expect(blankIdErrors()).toHaveLength(1);
      expect(blankIdErrors()[0]).toContain('anonymous id');
    },
  );

  it('reports a supplied user whose id is missing entirely', () => {
    makeSdk({ user: { id: undefined } as never });
    expect(blankIdErrors()).toHaveLength(1);
  });

  it('stays silent when no user is supplied — a signed-out visitor is legitimate', () => {
    makeSdk();
    expect(blankIdErrors()).toHaveLength(0);
  });

  it('stays silent for a real id', () => {
    makeSdk({ user: { id: 'user_1' } as never });
    expect(blankIdErrors()).toHaveLength(0);
  });

  it('still initialises — the SDK never refuses to start over a bad id', () => {
    // The fallback guarantee: a monetization SDK must not take down the host
    // app. It reports and carries on with the anonymous id.
    const sdk = makeSdk({ user: { id: '' } as never });
    expect(sdk.getUserContext().user_id).toBeTruthy();
  });
});
