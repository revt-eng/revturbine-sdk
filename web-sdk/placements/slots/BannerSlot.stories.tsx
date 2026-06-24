import type { Meta, StoryObj } from '@storybook/react-vite';
import { BannerSlot } from './BannerSlot';
import type { PlacementSlotProps } from '../types';

const basePlacement: PlacementSlotProps['placement'] = {
  output_id: 'story_banner_01',
  category: 'fixed',
  surface: { template: 'banner_placement', type: 'banner', slot_id: 'top_banner' },
  content: {},
  ui_path: { type: 'navigate_to_plans' },
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  present_upsell: true,
};

const meta = {
  title: 'SDK/Placements/BannerSlot',
  component: BannerSlot,
  args: {
    placement: basePlacement,
    content: {
      header: 'Upgrade to Pro',
      body: 'Get unlimited access to all features.',
      cta_label: 'Upgrade Now',
      position: 'top',
      dismissible: true,
    },
    uiPath: { type: 'navigate_to_plans' as const },
    onCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
  argTypes: {
    visible: { control: 'boolean' },
  },
} satisfies Meta<typeof BannerSlot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Top: Story = {};

export const Bottom: Story = {
  args: {
    content: {
      header: "You've used 80% of your storage",
      body: 'Upgrade for more space.',
      cta_label: 'See Plans',
      position: 'bottom',
      dismissible: true,
    },
  },
};

export const NotDismissible: Story = {
  args: {
    content: {
      header: 'Trial ends in 3 days',
      body: 'Subscribe to keep your data.',
      cta_label: 'Subscribe',
      position: 'top',
      dismissible: false,
    },
  },
};

export const BodyOnly: Story = {
  args: {
    content: {
      body: 'Limited time: 20% off annual plans.',
      cta_label: 'Claim Discount',
      position: 'top',
      dismissible: true,
    },
  },
};
