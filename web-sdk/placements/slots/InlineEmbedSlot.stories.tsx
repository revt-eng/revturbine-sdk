import type { Meta, StoryObj } from '@storybook/react-vite';
import { InlineEmbedSlot } from './InlineEmbedSlot';
import type { PlacementSlotProps } from '../types';

const basePlacement: PlacementSlotProps['placement'] = {
  output_id: 'story_inline_01',
  category: 'gated_feature',
  surface: { template: 'inline_feature_gate', type: 'in_page', slot_id: 'feature_gate_inline' },
  content: {},
  ui_path: { type: 'open_upgrade_modal' },
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  present_upsell: true,
};

const meta = {
  title: 'SDK/Placements/InlineEmbedSlot',
  component: InlineEmbedSlot,
  args: {
    placement: basePlacement,
    content: {
      header: 'Advanced Reporting',
      body: 'Unlock detailed analytics and custom reports with the Pro plan.',
      cta_label: 'Upgrade to Pro',
    },
    uiPath: { type: 'open_upgrade_modal' as const },
    onCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
  argTypes: {
    visible: { control: 'boolean' },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 400, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InlineEmbedSlot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithImage: Story = {
  args: {
    content: {
      header: 'Team Collaboration',
      body: 'Invite your team and work together in real time.',
      cta_label: 'Add Team Members',
      image_url: 'https://placehold.co/400x180/e2e8f0/475569?text=Collaboration',
    },
  },
};

export const MessageOnly: Story = {
  args: {
    content: {
      message: 'This feature requires a Pro plan. Upgrade to unlock.',
      cta_label: 'Upgrade',
    },
  },
};
