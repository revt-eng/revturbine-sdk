import type { Meta, StoryObj } from '@storybook/react-vite';
import { ModalComponent } from '.';
import type { PlacementSlotProps } from '../types';

const basePlacement: PlacementSlotProps['placement'] = {
  output_id: 'story_modal_01',
  category: 'gated_feature',
  surface: { template: 'modal_overlay_optional', type: 'modal', slot_id: 'feature_gate_modal' },
  content: {},
  ui_path: { type: 'open_checkout_modal', plan_handle: 'pro' },
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  present_upsell: true,
};

const meta = {
  title: 'SDK/Placements/ModalComponent',
  component: ModalComponent,
  args: {
    placement: basePlacement,
    content: {
      header: 'Unlock AI Export',
      body: 'Upgrade to Pro for AI-powered export enhancements. Process your files 10x faster with smart formatting.',
      cta_label: 'Upgrade to Pro',
      secondary_cta_label: 'Maybe Later',
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
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof ModalComponent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Optional: Story = {};

export const Blocking: Story = {
  args: {
    content: {
      header: 'Your trial has ended',
      body: 'Subscribe to continue using all features. Your data is safe and will be available after upgrade.',
      cta_label: 'Choose a Plan',
      style: 'blocking',
    },
  },
};

export const WithImage: Story = {
  args: {
    content: {
      header: 'Meet Advanced Analytics',
      body: 'Get deep insights into your usage patterns with our Pro analytics dashboard.',
      cta_label: 'Start Free Trial',
      secondary_cta_label: 'Learn More',
      image_url: 'https://placehold.co/480x200/e2e8f0/475569?text=Feature+Preview',
    },
  },
};

/**
 * Optional modal with the defer affordance (plan 167 REQ-7): supplying
 * `onRemindLater` renders a "Remind me later" control beside dismiss.
 */
export const WithRemindLater: Story = {
  args: {
    onRemindLater: () => {},
  },
};

/**
 * Blocking modals never render dismiss or defer controls, even when
 * `onRemindLater` is supplied — the user must act.
 */
export const BlockingHidesRemindLater: Story = {
  args: {
    content: {
      header: 'Your trial has ended',
      body: 'Subscribe to continue. Your data is safe and available after upgrade.',
      cta_label: 'Choose a Plan',
      style: 'blocking',
    },
    onRemindLater: () => {},
  },
};
