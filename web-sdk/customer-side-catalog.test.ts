import { describe, expect, it } from 'vitest';
import type { RevTurbineConfig } from '@revt-eng/schema';
import { RevTurbineCustomerSdk } from './customer-side';

function config(): RevTurbineConfig {
  return {
    version: '1.0.0',
    plans: [
      { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0, visibility: 'public' },
      { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 0, visibility: 'public' },
      { unique_handle: 'secret', name: 'Secret', tier_position: 2, sort_order: 0, visibility: 'unlisted' },
    ],
    addons: [
      { unique_handle: 'support', name: 'Support', sort_order: 0, visibility: 'public' },
    ],
    plan_variations: [
      { handle: 'free_default', plan_handle: 'free', billing_period: 'monthly', segment_handle: null, price_amount: 0, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
      { handle: 'pro_default', plan_handle: 'pro', billing_period: 'monthly', segment_handle: null, price_amount: 4900, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
      { handle: 'pro_startup', plan_handle: 'pro', billing_period: 'monthly', segment_handle: 'startup', price_amount: 2900, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
      { handle: 'secret_default', plan_handle: 'secret', billing_period: 'monthly', segment_handle: null, price_amount: 9900, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
    ],
    addon_variations: [
      { handle: 'support_default', addon_handle: 'support', billing_period: 'monthly', segment_handle: null, price_amount: 1000, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
    ],
    entitlements: [],
    entitlement_rules: [],
    segments: [
      { handle: 'startup', name: 'Startup', dimension_id: 'company_stage', predicates: [{ field: 'stage', operator: 'eq', value: 'startup' }] },
    ],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as RevTurbineConfig;
}

function sdk(): RevTurbineCustomerSdk {
  const instance = new RevTurbineCustomerSdk({
    tenantId: 'tenant_catalog',
    apiKey: 'test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: 'local_only',
    locale: 'en-US',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { exportedConfig: config() },
  });
  instance.identify('user_1', { plan_handle: 'free', custom: { stage: 'startup' } });
  return instance;
}

describe('Plan 161 catalog eligibility and price tokens', () => {
  it('returns public plans with segment-specific variation precedence', async () => {
    const plans = await sdk().getEligiblePlans();
    expect(plans.map((plan) => plan.variationHandle)).toEqual(['free_default', 'pro_startup']);
    expect(plans[1]?.price).toEqual({
      price: 2900,
      currency: 'usd',
      pricingModel: 'flat',
      billingPeriod: 'monthly',
    });
  });

  it('returns eligible add-ons and formats Playbook prices without a provider', async () => {
    const instance = sdk();
    expect((await instance.getEligibleAddons())[0]?.variationHandle).toBe('support_default');
    expect(instance.getPersonalizationTokens()).toMatchObject({
      plan_price: '$0.00',
      upgrade_plan_price: '$29.00',
    });
  });
});
