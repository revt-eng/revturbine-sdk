/**
 * Plan 84 TASK-1/TASK-2: the advertised hero-API aliases delegate to the
 * canonical methods, and `<RTSlot>` is the `SurfaceSlotComponent`. These assert
 * the alias *contract* (delegation + return), not the underlying behavior the
 * canonical methods already test elsewhere.
 */
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { RevTurbineCustomerSdk, RECOGNIZED_UPDATE_KEYS } from './customer-side';
import type { EntitlementResult, RevTurbineInitOptions, RevTurbineUpdateInput } from './customer-side';
import { RTSlot, Slot, Gate, BannerComponent, BannerSlot, ModalComponent, ModalSlot } from './index';
import { SurfaceSlotComponent } from './placements/SurfaceSlotComponent';
import { AccessGateSurfaceSlot } from './placements/AccessGateSurfaceSlot';

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_alias_test',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    environmentId: 'staging',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

const allowed: EntitlementResult = { status: 'allowed', allowed: true, reason: 'test' };
const denied: EntitlementResult = { status: 'denied', allowed: false, reason: 'test' };

describe('advertised hero-API aliases (plan 84)', () => {
  it('can() delegates to checkEntitlement and returns its result', async () => {
    const sdk = makeSdk();
    const spy = vi.spyOn(sdk, 'checkEntitlement').mockResolvedValue(allowed);
    const result = await sdk.can('generate_image');
    expect(spy).toHaveBeenCalledWith('generate_image', undefined);
    expect(result).toBe(allowed);
  });

  it('gate() runs fn and returns its result when allowed', async () => {
    const sdk = makeSdk();
    vi.spyOn(sdk, 'checkEntitlement').mockResolvedValue(allowed);
    const fn = vi.fn(() => 'ran');
    const out = await sdk.gate('export_pdf', fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(out).toEqual({ ran: true, result: 'ran', entitlement: allowed });
  });

  it('gate() does NOT run fn and surfaces the entitlement when denied', async () => {
    const sdk = makeSdk();
    vi.spyOn(sdk, 'checkEntitlement').mockResolvedValue(denied);
    const fn = vi.fn(() => 'ran');
    const out = await sdk.gate('export_pdf', fn);
    expect(fn).not.toHaveBeenCalled();
    expect(out).toEqual({ ran: false, entitlement: denied });
  });

  it('track() delegates to trackEvent', async () => {
    const sdk = makeSdk();
    const spy = vi.spyOn(sdk, 'trackEvent').mockResolvedValue(undefined);
    await sdk.track('ai_generation_completed', { credits: 3 });
    expect(spy).toHaveBeenCalledWith('ai_generation_completed', { credits: 3 });
  });

  it('update({ usage }) delegates to updateUsage and does NOT touch setUserContext', () => {
    const sdk = makeSdk();
    const usageSpy = vi.spyOn(sdk, 'updateUsage').mockImplementation(() => undefined);
    const ctxSpy = vi.spyOn(sdk, 'setUserContext').mockImplementation(() => undefined);
    sdk.update({ usage: { generations: 25 } });
    expect(usageSpy).toHaveBeenCalledWith({ generations: 25 });
    expect(ctxSpy).not.toHaveBeenCalled();
  });

  it('update({}) is a no-op — neither usage nor context path fires', () => {
    const sdk = makeSdk();
    const usageSpy = vi.spyOn(sdk, 'updateUsage').mockImplementation(() => undefined);
    const ctxSpy = vi.spyOn(sdk, 'setUserContext').mockImplementation(() => undefined);
    sdk.update({});
    expect(usageSpy).not.toHaveBeenCalled();
    expect(ctxSpy).not.toHaveBeenCalled();
  });

  it('update() routes non-usage session fields to setUserContext', () => {
    const sdk = makeSdk();
    const usageSpy = vi.spyOn(sdk, 'updateUsage').mockImplementation(() => undefined);
    const ctxSpy = vi.spyOn(sdk, 'setUserContext').mockImplementation(() => undefined);
    sdk.update({ plan: { handle: 'pro', name: 'Pro' }, custom: { role: 'admin' } });
    expect(ctxSpy).toHaveBeenCalledWith({ plan: { handle: 'pro', name: 'Pro' }, custom: { role: 'admin' } });
    expect(usageSpy).not.toHaveBeenCalled();
  });

  it('update() splits a combined patch across updateUsage and setUserContext', () => {
    const sdk = makeSdk();
    const usageSpy = vi.spyOn(sdk, 'updateUsage').mockImplementation(() => undefined);
    const ctxSpy = vi.spyOn(sdk, 'setUserContext').mockImplementation(() => undefined);
    sdk.update({ plan: { handle: 'pro', name: 'Pro' }, usage: { generations: 3 } });
    expect(ctxSpy).toHaveBeenCalledWith({ plan: { handle: 'pro', name: 'Pro' } });
    expect(usageSpy).toHaveBeenCalledWith({ generations: 3 });
  });

  it('update() merges context without clobbering identity or unset fields', () => {
    const sdk = makeSdk();
    sdk.identify('user_alias', { plan: { handle: 'free', name: 'Free' }, custom: { role: 'viewer' } });
    sdk.update({ email: 'jane@acme.com' });
    const ctx = sdk.getUserContext();
    expect(ctx.user_id).toBe('user_alias'); // identity preserved
    expect(ctx.email).toBe('jane@acme.com'); // new field applied
    expect(ctx.plan).toEqual({ handle: 'free', name: 'Free' }); // prior field untouched
    expect(ctx.custom).toMatchObject({ role: 'viewer' });
  });

  it('update() warns and drops unrecognized keys instead of polluting the context', () => {
    const sdk = makeSdk();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctxSpy = vi.spyOn(sdk, 'setUserContext').mockImplementation(() => undefined);
    const usageSpy = vi.spyOn(sdk, 'updateUsage').mockImplementation(() => undefined);
    sdk.update({ credits: 800 } as unknown as RevTurbineUpdateInput);
    expect(ctxSpy).not.toHaveBeenCalled();
    expect(usageSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('credits');
    warnSpy.mockRestore();
  });

  it('RECOGNIZED_UPDATE_KEYS is exhaustive over RevTurbineUpdateInput', () => {
    // `satisfies` in-source guards each entry against typos; this guards the
    // reverse direction — a schema-added context field fails here until the
    // runtime list acknowledges it.
    expectTypeOf<Exclude<keyof RevTurbineUpdateInput, (typeof RECOGNIZED_UPDATE_KEYS)[number]>>()
      .toEqualTypeOf<never>();
    expect(new Set(RECOGNIZED_UPDATE_KEYS).size).toBe(RECOGNIZED_UPDATE_KEYS.length);
  });

  it('reset() delegates to resetIdentity', () => {
    const sdk = makeSdk();
    const spy = vi.spyOn(sdk, 'resetIdentity').mockImplementation(() => undefined);
    sdk.reset();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('RTSlot is the SurfaceSlotComponent (deprecated alias)', () => {
    expect(RTSlot).toBe(SurfaceSlotComponent);
  });

  // Plan 105 Q-4: the two customer-facing components are <Slot> and <Gate>.
  it('Slot is the SurfaceSlotComponent (advertised name)', () => {
    expect(Slot).toBe(SurfaceSlotComponent);
  });

  it('Gate is the AccessGateSurfaceSlot (advertised name)', () => {
    expect(Gate).toBe(AccessGateSurfaceSlot);
  });

  it('exports *Component names with working deprecated *Slot aliases', () => {
    expect(BannerComponent).toBe(BannerSlot);
    expect(ModalComponent).toBe(ModalSlot);
  });
});
