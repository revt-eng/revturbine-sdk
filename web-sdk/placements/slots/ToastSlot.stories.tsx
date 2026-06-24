import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToastSlot } from './ToastSlot';
import type { PlacementSlotProps } from '../types';

const basePlacement: PlacementSlotProps['placement'] = {
  output_id: 'story_toast_01',
  category: 'usage_limit',
  surface: { template: 'toast_ephemeral', type: 'toast' },
  content: {},
  ui_path: { type: 'navigate_to_plans' },
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  present_upsell: false,
};

const meta = {
  title: 'SDK/Placements/ToastSlot',
  component: ToastSlot,
  args: {
    placement: basePlacement,
    content: {
      message: "You've used 90% of your storage.",
      cta_label: 'Upgrade',
      position: 'bottom-right',
      duration: 0, // disable auto-dismiss for stories
    },
    uiPath: { type: 'navigate_to_plans' as const },
    onCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
  argTypes: {
    visible: { control: 'boolean' },
  },
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof ToastSlot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BottomRight: Story = {};

export const TopRight: Story = {
  args: {
    content: {
      message: 'New feature available: Team Spaces',
      cta_label: 'Try it',
      position: 'top-right',
      duration: 0,
    },
  },
};

export const BottomCenter: Story = {
  args: {
    content: {
      message: 'Your export is complete.',
      position: 'bottom-center',
      duration: 0,
    },
  },
};

export const NoCta: Story = {
  args: {
    content: {
      message: 'Settings saved successfully.',
      position: 'bottom-right',
      duration: 0,
    },
  },
};
