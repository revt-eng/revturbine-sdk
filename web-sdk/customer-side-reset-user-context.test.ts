/**
 * `resetUserContext()` — hard-reset the user context to a blank slate (no
 * anonymous inference). Mostly for demo / fixture flows that swap personas
 * cleanly between scenarios. Distinct from `resetIdentity()`, which is a
 * sign-out that may re-infer anonymous context when `inferUser` is on.
 */
import { describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_reset_test',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

describe('resetUserContext() (hard reset for demos)', () => {
  it('removes every user-context value', () => {
    const sdk = makeSdk();
    sdk.identify('u_demo', {
      account_id: 'acct_1',
      email: 'demo@example.com',
      plan: { id: 'pro', name: 'Pro' },
      custom: { region: 'us' },
    });
    sdk.updateUsage({ generations: 25 });

    sdk.resetUserContext();

    const ctx = sdk.getUserContext();
    expect(ctx.account_id).toBeUndefined();
    expect(ctx.email).toBeUndefined();
    expect(ctx.plan).toBeUndefined();
    expect(ctx.custom).toEqual({});
    expect(ctx.entitlements).toEqual({});
    // personalization holds DERIVED tokens (recomputed on reset); no user-set
    // value lingers — every remaining token is the empty default.
    expect(Object.values(ctx.personalization).every((v) => v === '')).toBe(true);
    expect(ctx.usage).toEqual({});
    // id falls back to the anonymous id once the user is cleared.
    expect(ctx.id).toBe(ctx.user_id);
    // usage balances are gone too.
    expect(sdk.getUsage()).toEqual({});
  });

  it('does NOT re-infer anonymous context even when inferUser is on', () => {
    const sdk = makeSdk({ contextPolicy: { inferUser: true, inferPage: false, routerAutoTrack: false } });
    sdk.identify('u', { plan: { id: 'pro', name: 'Pro' }, custom: { seat: 'admin' } });

    sdk.resetUserContext();

    const ctx = sdk.getUserContext();
    expect(ctx.plan).toBeUndefined();
    expect(ctx.custom).toEqual({});
  });

  it('leaves the SDK usable — identify after reset re-establishes the user', () => {
    const sdk = makeSdk();
    sdk.identify('u_old', { plan: { id: 'free', name: 'Free' } });
    sdk.resetUserContext();

    sdk.identify('u_new', { plan: { id: 'enterprise', name: 'Enterprise' }, email: 'new@example.com' });

    const ctx = sdk.getUserContext();
    expect(ctx.email).toBe('new@example.com');
    expect(ctx.plan).toEqual({ id: 'enterprise', name: 'Enterprise' });
  });

  it('resetIdentity() still works (shared teardown is intact)', () => {
    const sdk = makeSdk();
    const spy = vi.spyOn(sdk, 'resetUserContext');
    sdk.identify('u', { email: 'x@y.com' });
    sdk.resetIdentity();
    // resetIdentity is its own entrypoint — not routed through resetUserContext.
    expect(spy).not.toHaveBeenCalled();
    expect(sdk.getUserContext().email).toBeUndefined();
  });
});
