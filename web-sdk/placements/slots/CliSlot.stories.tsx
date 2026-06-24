import type { Meta, StoryObj } from '@storybook/react-vite';
import { CliSlot } from './CliSlot';
import type { PlacementSlotProps } from '../types';

const basePlacement: PlacementSlotProps['placement'] = {
  output_id: 'story_cli_01',
  category: 'usage_limit',
  surface: { template: 'cli', type: 'cli' },
  content: {},
  ui_path: { type: 'custom_url', url: 'https://app.example.com/upgrade' },
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  present_upsell: true,
};

const meta = {
  title: 'SDK/Placements/CliSlot',
  component: CliSlot,
  args: {
    placement: basePlacement,
    content: {
      message: '⚠ You have used 95% of your API quota (9,500 / 10,000 calls).\nUpgrade your plan to avoid rate limiting.',
      cta_label: 'Upgrade',
    },
    uiPath: { type: 'custom_url' as const, url: 'https://app.example.com/upgrade' },
    onCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
  argTypes: {
    visible: { control: 'boolean' },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 600, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CliSlot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithActionLinks: Story = {
  args: {
    content: {
      message: 'Your free trial expires in 3 days.',
      action_links: ['Upgrade', 'Learn more'],
    },
  },
};
