/**
 * Plan 84 TASK-1/TASK-2: the advertised hero-API aliases delegate to the
 * canonical methods, and `<RTSlot>` is the `SurfaceSlotComponent`. These assert
 * the alias *contract* (delegation + return), not the underlying behavior the
 * canonical methods already test elsewhere.
 */
import { describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { EntitlementResult, RevTurbineInitOptions } from './customer-side';
import { RTSlot } from './index';
import { SurfaceSlotComponent } from './placements/SurfaceSlotComponent';

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

  it('update({ usage }) delegates to updateUsage', () => {
    const sdk = makeSdk();
    const spy = vi.spyOn(sdk, 'updateUsage').mockImplementation(() => undefined);
    sdk.update({ usage: { generations: 25 } });
    expect(spy).toHaveBeenCalledWith({ generations: 25 });
  });

  it('update({}) with no usage is a no-op', () => {
    const sdk = makeSdk();
    const spy = vi.spyOn(sdk, 'updateUsage').mockImplementation(() => undefined);
    sdk.update({});
    expect(spy).not.toHaveBeenCalled();
  });

  it('reset() delegates to resetIdentity', () => {
    const sdk = makeSdk();
    const spy = vi.spyOn(sdk, 'resetIdentity').mockImplementation(() => undefined);
    sdk.reset();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('RTSlot is the SurfaceSlotComponent (advertised alias)', () => {
    expect(RTSlot).toBe(SurfaceSlotComponent);
  });
});
