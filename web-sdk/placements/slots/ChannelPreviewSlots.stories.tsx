import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmailPreviewSlot, SmsPreviewSlot, PushPreviewSlot } from './ChannelPreviewSlots';
import type { PlacementSlotProps } from '../types';

const placementFor = (
  type: 'email' | 'sms' | 'push',
): PlacementSlotProps['placement'] => ({
  output_id: `story_${type}_01`,
  category: 'conversion',
  surface: { type },
  content: {},
  ui_path: { type: 'navigate_to_plans' },
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  present_upsell: false,
});

// ── Email ────────────────────────────────────────────────────────────────────

const emailMeta = {
  title: 'SDK/Placements/ChannelPreview/Email',
  component: EmailPreviewSlot,
  args: {
    placement: placementFor('email'),
    content: {
      subject: "You're close to your storage limit",
      body: 'Hi there,\n\nYou have used 90% of your plan storage. Upgrade to keep your uploads flowing.',
      cta_label: 'Upgrade now',
      secondary_cta_label: 'See plans',
    },
    uiPath: { type: 'navigate_to_plans' as const },
    onCtaClick: () => {},
    onSecondaryCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
  argTypes: { visible: { control: 'boolean' } },
} satisfies Meta<typeof EmailPreviewSlot>;

export default emailMeta;
type EmailStory = StoryObj<typeof emailMeta>;

export const Email: EmailStory = {};

export const EmailPrimaryOnly: EmailStory = {
  args: {
    content: {
      subject: 'Your trial ends in 3 days',
      body: 'Convert now to keep your projects active.',
      cta_label: 'Convert to Pro',
    },
  },
};

// ── SMS ──────────────────────────────────────────────────────────────────────

type SmsStory = StoryObj<typeof SmsPreviewSlot>;

export const Sms: SmsStory = {
  render: (args) => <SmsPreviewSlot {...args} />,
  args: {
    placement: placementFor('sms'),
    content: {
      body: 'You have 2 days left on your free trial. Upgrade: rev.tb/up',
      cta_label: 'Upgrade',
    },
    uiPath: { type: 'navigate_to_plans' as const },
    onCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
};

// ── Push ─────────────────────────────────────────────────────────────────────

type PushStory = StoryObj<typeof PushPreviewSlot>;

export const Push: PushStory = {
  render: (args) => <PushPreviewSlot {...args} />,
  args: {
    placement: placementFor('push'),
    content: {
      header: 'Storage almost full',
      body: "You've used 90% of your plan. Tap to upgrade.",
      cta_label: 'Upgrade',
      secondary_cta_label: 'Dismiss',
    },
    uiPath: { type: 'navigate_to_plans' as const },
    onCtaClick: () => {},
    onSecondaryCtaClick: () => {},
    onDismiss: () => {},
    visible: true,
  },
};
