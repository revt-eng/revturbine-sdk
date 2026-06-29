import { describe, expect, it, vi } from 'vitest';
import { RevTurbineConfigSchema } from '@revt-eng/schema';
import rawConfig from '../config/prism-export-config.json';
import { authoredCta, CREDIT_PACK_SIZE, dispatchCta, isPurchaseCta, type DemoActions } from './cta-actions';

const PRISM_CONFIG = RevTurbineConfigSchema.parse(rawConfig);

function mockActions(): DemoActions & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const rec = (k: string) => (...args: unknown[]) => {
    calls[k] = args;
  };
  return {
    upgradeTo: vi.fn(rec('upgradeTo')),
    topUpCredits: vi.fn(rec('topUpCredits')),
    switchBillingPeriod: vi.fn(rec('switchBillingPeriod')),
    openPlans: vi.fn(rec('openPlans')),
    contactSales: vi.fn(rec('contactSales')),
    contactAdmin: vi.fn(rec('contactAdmin')),
    fixPayment: vi.fn(rec('fixPayment')),
    note: vi.fn(rec('note')),
    calls,
  };
}

describe('isPurchaseCta (non-buyer admin gate)', () => {
  it('flags purchases (upgrade / top-up / switch-to-annual) but not browsing or sales', () => {
    expect(isPurchaseCta({ type: 'open_checkout', params: {} })).toBe(true);
    expect(isPurchaseCta({ type: 'open_checkout_modal', params: {} })).toBe(true);
    expect(isPurchaseCta({ type: 'switch_billing_period', params: {} })).toBe(true);
    // Browsing plans, contacting sales, and dismissing are not purchases.
    expect(isPurchaseCta({ type: 'view_plans', params: {} })).toBe(false);
    expect(isPurchaseCta({ type: 'navigate_to_plans', params: {} })).toBe(false);
    expect(isPurchaseCta({ type: 'contact_sales', params: {} })).toBe(false);
    expect(isPurchaseCta({ type: 'dismiss', params: {} })).toBe(false);
  });

  it('routes a contact_admin CTA to the admin gate', () => {
    const a = mockActions();
    dispatchCta({ type: 'contact_admin', params: {} }, a);
    expect(a.contactAdmin).toHaveBeenCalled();
  });
});

describe('dispatchCta', () => {
  it('open_checkout (pro) upgrades to Pro', () => {
    const a = mockActions();
    dispatchCta({ type: 'open_checkout', params: { purchase: 'pro' } }, a);
    expect(a.calls.upgradeTo).toEqual(['pro']);
  });

  it('open_checkout (credit_pack) tops up credits', () => {
    const a = mockActions();
    dispatchCta({ type: 'open_checkout', params: { purchase: 'credit_pack' } }, a);
    expect(a.calls.topUpCredits).toEqual([CREDIT_PACK_SIZE]);
    expect(a.upgradeTo).not.toHaveBeenCalled();
  });

  it('switch_billing_period switches to annual', () => {
    const a = mockActions();
    dispatchCta({ type: 'switch_billing_period', params: { target_billing_period: 'annual' } }, a);
    expect(a.calls.switchBillingPeriod).toEqual(['annual']);
  });

  it('view_plans / navigate_to_plans open the plans surface', () => {
    const a = mockActions();
    dispatchCta({ type: 'view_plans', params: {} }, a);
    dispatchCta({ type: 'navigate_to_plans', params: {} }, a);
    expect(a.openPlans).toHaveBeenCalledTimes(2);
  });

  it('contact_sales opens the contact surface', () => {
    const a = mockActions();
    dispatchCta({ type: 'contact_sales', params: {} }, a);
    expect(a.contactSales).toHaveBeenCalledOnce();
  });

  it('dismiss does nothing', () => {
    const a = mockActions();
    dispatchCta({ type: 'dismiss', params: {} }, a);
    expect(a.upgradeTo).not.toHaveBeenCalled();
    expect(a.openPlans).not.toHaveBeenCalled();
    expect(a.note).not.toHaveBeenCalled();
  });
});

describe('authoredCta', () => {
  it('reads the primary + secondary CTA of a modal placement', () => {
    // pl_usage_100: primary "Upgrade to Pro" (open_checkout pro), secondary "Buy a top-up pack" (credit_pack).
    const primary = authoredCta(PRISM_CONFIG, 'pl_usage_100', 0);
    const secondary = authoredCta(PRISM_CONFIG, 'pl_usage_100', 1);
    expect(primary?.type).toBe('open_checkout');
    expect(primary?.params.purchase).toBe('pro');
    expect(secondary?.params.purchase).toBe('credit_pack');
  });

  it('returns null for an unknown placement', () => {
    expect(authoredCta(PRISM_CONFIG, 'nope', 0)).toBeNull();
  });

  it('drives the upgrade loop end to end (authored CTA → dispatch)', () => {
    const a = mockActions();
    const cta = authoredCta(PRISM_CONFIG, 'pl_nav_upgrade', 0);
    expect(cta).not.toBeNull();
    if (cta) dispatchCta(cta, a);
    expect(a.calls.upgradeTo).toEqual(['pro']);
  });
});
