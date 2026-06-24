import type { Meta, StoryObj } from '@storybook/react-vite';
import { FullPageSlot } from './FullPageSlot';
import type { PlacementSlotProps } from '../types';

const basePlacement: PlacementSlotProps['placement'] = {
  output_id: 'story_fullpage_01',
  category: 'fixed',
  surface: { template: 'full_page', type: 'full_page', slot_id: 'plans_page' },
  content: {},
  ui_path: { type: 'open_checkout_modal', plan_handle: 'pro' },
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  present_upsell: true,
};

const meta = {
  title: 'SDK/Placements/FullPageSlot',
  component: FullPageSlot,
  args: {
    placement: basePlacement,
    content: {
      header: 'Choose the right plan for your team',
      body: 'All plans include a 14-day free trial. No credit card required.',
      cta_label: 'Get Started',
      secondary_cta_label: 'Compare Plans',
    },
    uiPath: { type: 'open_checkout_modal' as const, plan_handle: 'pro' },
    onCtaClick: () => {},
    onSecondaryCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
  argTypes: {
    visible: { control: 'boolean' },
  },
} satisfies Meta<typeof FullPageSlot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SingleCta: Story = {
  args: {
    content: {
      header: 'Upgrade to Enterprise',
      body: 'Get dedicated support, unlimited seats, and priority SLA.',
      cta_label: 'Contact Sales',
    },
    onSecondaryCtaClick: undefined,
  },
};
