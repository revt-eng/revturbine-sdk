import type { Meta, StoryObj } from '@storybook/react-vite';
import { AgentConnectorSlot } from './AgentConnectorSlot';
import type { PlacementSlotProps } from '../types';

const basePlacement: PlacementSlotProps['placement'] = {
  output_id: 'story_agent_connector_01',
  category: 'retention',
  surface: { template: 'agent_connector', type: 'agent', slot_id: 'assistant_connector' },
  content: {},
  ui_path: { type: 'open_placement', placement_handle: 'agent_connector_setup' },
  rule_id: 'rule_agent_1',
  decision_id: 'dec_agent_1',
  config_version: 'v1',
  present_upsell: true,
};

const meta = {
  title: 'SDK/Placements/AgentConnectorSlot',
  component: AgentConnectorSlot,
  args: {
    placement: basePlacement,
    content: {
      header: 'Assistant Connector',
      body: 'Connect your workspace assistant to unlock premium automation and summaries.',
      cta_label: 'Connect now',
      connection_state: 'disconnected',
    },
    uiPath: { type: 'open_placement' as const, placement_handle: 'agent_connector_setup' },
    onCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof AgentConnectorSlot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Disconnected: Story = {};

export const Pending: Story = {
  args: {
    content: {
      header: 'Assistant Connector',
      body: 'Connector authorization is in progress. We will notify you when it is ready.',
      cta_label: 'View status',
      connection_state: 'pending',
    },
  },
};

export const Connected: Story = {
  args: {
    content: {
      header: 'Assistant Connector',
      body: 'Your assistant is connected. Explore advanced workflow suggestions.',
      cta_label: 'Open assistant',
      connection_state: 'connected',
    },
  },
};