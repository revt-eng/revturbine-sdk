import type { Meta, StoryObj } from '@storybook/react-vite';
import { RevTurbineProvider } from './RevTurbineProvider';
import { useAddons } from './useAddons';
import { usePlans } from './usePlans';

const PLAYBOOK = {
  version: '1.0.0',
  plans: [
    { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0, visibility: 'public' },
    { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 0, visibility: 'public' },
  ],
  addons: [{ unique_handle: 'support', name: 'Priority support', sort_order: 0, visibility: 'public' }],
  plan_variations: [
    { handle: 'free_monthly', plan_handle: 'free', billing_period: 'monthly', segment_handle: null, price_amount: 0, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
    { handle: 'pro_monthly', plan_handle: 'pro', billing_period: 'monthly', segment_handle: null, price_amount: 4900, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
  ],
  addon_variations: [
    { handle: 'support_monthly', addon_handle: 'support', billing_period: 'monthly', segment_handle: null, price_amount: 1000, currency: 'usd', pricing_model: 'flat', visibility: 'public', stripe_price_id: null, price_source: 'static' },
  ],
  entitlements: [], entitlement_rules: [], segments: [], content_ui_paths: [], surface_templates: [], placements: [],
};

function CatalogDemo() {
  const { plans, isLoading: plansLoading } = usePlans();
  const { addons, isLoading: addonsLoading } = useAddons();
  if (plansLoading || addonsLoading) return <p>Loading catalog…</p>;
  return (
    <section aria-label="Eligible catalog">
      <h2>Eligible plans</h2>
      <ul>{plans.map((plan) => <li key={plan.variationHandle}>{plan.name}: {plan.price.currency.toUpperCase()} {plan.price.price / 100}</li>)}</ul>
      <h2>Eligible add-ons</h2>
      <ul>{addons.map((addon) => <li key={addon.variationHandle}>{addon.name}: {addon.price.currency.toUpperCase()} {addon.price.price / 100}</li>)}</ul>
    </section>
  );
}

function LocalPlaybookCatalog() {
  return (
    <RevTurbineProvider options={{
      tenantId: 'storybook',
      apiKey: 'local',
      endpoint: 'https://example.invalid',
      mode: 'react',
      runtimeMode: 'local_only',
      anonymousTelemetry: false,
      localRuntime: { playbook: PLAYBOOK as never },
      user: { id: 'story-user', plan_handle: 'free' },
    }}>
      <CatalogDemo />
    </RevTurbineProvider>
  );
}

const meta = {
  title: 'SDK/Catalog/Eligible plans and add-ons',
  component: LocalPlaybookCatalog,
  parameters: { a11y: { test: 'error' } },
} satisfies Meta<typeof LocalPlaybookCatalog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FromLocalPlaybook: Story = {};
