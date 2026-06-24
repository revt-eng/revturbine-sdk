import type { Meta, StoryObj } from '@storybook/react-vite';
import { CreditBalanceSlot } from './CreditBalanceSlot';
import type { PlacementSlotProps } from '../types';

const basePlacement: PlacementSlotProps['placement'] = {
  output_id: 'story_credits_01',
  category: 'usage_limit',
  surface: { template: 'credit_balance_counter', type: 'in_page', slot_id: 'credits_widget' },
  content: {},
  ui_path: { type: 'open_checkout_modal', plan_handle: 'pro' },
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  present_upsell: true,
};

const meta = {
  title: 'SDK/Placements/CreditBalanceSlot',
  component: CreditBalanceSlot,
  args: {
    placement: basePlacement,
    content: {
      header: 'AI Credits',
      credits_remaining: 42,
      credits_total: 500,
      cta_label: 'Buy More Credits',
      display_style: 'numeric_balance',
    },
    uiPath: { type: 'open_checkout_modal' as const, plan_handle: 'pro' },
    onCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
  argTypes: {
    visible: { control: 'boolean' },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 320, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CreditBalanceSlot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NumericBalance: Story = {};

export const BalanceBar: Story = {
  args: {
    content: {
      header: 'AI Credits',
      credits_remaining: 42,
      credits_total: 500,
      cta_label: 'Buy More Credits',
      display_style: 'balance_bar',
    },
  },
};

export const LowBalance: Story = {
  args: {
    content: {
      header: 'AI Credits',
      credits_remaining: 8,
      credits_total: 500,
      cta_label: 'Buy More Credits',
      display_style: 'balance_bar',
    },
  },
};

export const WithBurnRate: Story = {
  args: {
    content: {
      header: 'AI Credits',
      credits_remaining: 120,
      credits_total: 500,
      cta_label: 'Upgrade Plan',
      display_style: 'balance_burn_rate',
      show_burn_rate: true,
      burn_rate_label: 'At current rate, depletes in ~6 days',
    },
  },
};
