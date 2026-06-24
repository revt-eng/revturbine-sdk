import type { Meta, StoryObj } from '@storybook/react-vite';
import { QuotaMeterSlot } from './QuotaMeterSlot';
import type { PlacementSlotProps } from '../types';

const basePlacement: PlacementSlotProps['placement'] = {
  output_id: 'story_meter_01',
  category: 'usage_limit',
  surface: { template: 'quota_meter', type: 'in_page', slot_id: 'storage_meter' },
  content: {},
  ui_path: { type: 'navigate_to_plans' },
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  present_upsell: true,
};

const meta = {
  title: 'SDK/Placements/QuotaMeterSlot',
  component: QuotaMeterSlot,
  args: {
    placement: basePlacement,
    content: {
      header: 'Storage',
      usage_current: 8.2,
      usage_limit: 10,
      cta_label: 'Upgrade for more',
      display_style: 'progress_bar',
    },
    uiPath: { type: 'navigate_to_plans' as const },
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
} satisfies Meta<typeof QuotaMeterSlot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProgressBar: Story = {};

export const HighUsage: Story = {
  args: {
    content: {
      header: 'API Calls',
      usage_current: 9500,
      usage_limit: 10000,
      cta_label: 'Upgrade Plan',
      display_style: 'progress_bar',
    },
  },
};

export const NumericCounter: Story = {
  args: {
    content: {
      header: 'Seats',
      usage_current: 4,
      usage_limit: 5,
      cta_label: 'Add Seats',
      display_style: 'numeric_counter',
    },
  },
};

export const CircularGauge: Story = {
  args: {
    content: {
      header: 'AI Credits',
      usage_current: 72,
      usage_limit: 100,
      cta_label: 'Buy More Credits',
      display_style: 'circular_gauge',
    },
  },
};

export const CircularGaugeCritical: Story = {
  args: {
    content: {
      header: 'Storage (GB)',
      usage_current: 9.4,
      usage_limit: 10,
      cta_label: 'Upgrade Storage',
      display_style: 'circular_gauge',
    },
  },
  name: 'Circular Gauge — Critical',
};

export const WithThreshold: Story = {
  args: {
    content: {
      header: 'Storage',
      usage_current: 3,
      usage_limit: 10,
      cta_label: 'Upgrade',
      display_style: 'progress_bar',
      show_at: 50,
    },
  },
  name: 'Hidden (below threshold)',
};
