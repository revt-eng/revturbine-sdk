import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonSlot } from './ButtonSlot';
import type { PlacementSlotProps } from '../types';

const basePlacement: PlacementSlotProps['placement'] = {
  output_id: 'story_button_01',
  category: 'fixed',
  surface: { template: 'nav_bar_button', type: 'button', slot_id: 'header_upgrade_cta' },
  content: {},
  ui_path: { type: 'navigate_to_plans' },
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  present_upsell: true,
};

const meta = {
  title: 'SDK/Placements/ButtonSlot',
  component: ButtonSlot,
  args: {
    placement: basePlacement,
    content: {
      cta_label: 'Upgrade',
      style: 'primary',
    },
    uiPath: { type: 'navigate_to_plans' as const },
    onCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
  argTypes: {
    visible: { control: 'boolean' },
  },
} satisfies Meta<typeof ButtonSlot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};

export const Secondary: Story = {
  args: {
    content: { cta_label: 'See Plans', style: 'secondary' },
  },
};

export const Accent: Story = {
  args: {
    content: { cta_label: 'Go Pro', style: 'accent' },
  },
};
