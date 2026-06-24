import type { Meta, StoryObj } from '@storybook/react-vite';
import { TooltipSlot } from './TooltipSlot';
import type { PlacementSlotProps } from '../types';

const basePlacement: PlacementSlotProps['placement'] = {
  output_id: 'story_tooltip_01',
  category: 'discretionary',
  surface: { template: 'tooltip', type: 'toast', slot_id: 'feature_tooltip' },
  content: {},
  ui_path: { type: 'open_feature_tour' },
  rule_id: 'rule_tooltip_1',
  decision_id: 'dec_tooltip_1',
  config_version: 'v1',
  present_upsell: false,
};

const meta = {
  title: 'SDK/Placements/TooltipSlot',
  component: TooltipSlot,
  args: {
    placement: basePlacement,
    content: {
      message: 'Try bulk actions to save time on repetitive tasks.',
      cta_label: 'Show me',
      position: 'top',
      anchor_gap: 10,
    },
    uiPath: { type: 'open_feature_tour' as const },
    onCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof TooltipSlot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FloatingFallback: Story = {
  args: {
    content: {
      message: 'This is a floating tooltip fallback when no anchor is found.',
      cta_label: 'Learn more',
      position: 'top',
    },
  },
};

export const AnchoredRight: Story = {
  render: (args) => (
    <div style={{ padding: '120px 180px' }}>
      <button
        id="tooltip-anchor-target"
        type="button"
        style={{
          border: '1px solid #d1d5db',
          background: '#ffffff',
          borderRadius: '8px',
          padding: '10px 14px',
          fontSize: '14px',
        }}
      >
        Feature Target
      </button>
      <TooltipSlot
        {...args}
        content={{
          ...args.content,
          anchor_selector: '#tooltip-anchor-target',
          position: 'right',
          message: 'You can configure automation from this control.',
        }}
      />
    </div>
  ),
};