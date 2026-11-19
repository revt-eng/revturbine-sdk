import type { Meta, StoryObj } from '@storybook/react-vite';
import { CtaActions } from './CtaActions';
import type { PlacementCta } from './types';

const fiveCtas: PlacementCta[] = [
  { label: 'Switch down', path: { type: 'downgrade' }, role: 'downgrade', role_overridden: false, emphasis: 'secondary' },
  { label: 'Pause for a month', path: { type: 'pause' }, role: 'pause', role_overridden: true, emphasis: 'secondary' },
  { label: 'Keep my plan', path: { type: 'open_checkout' }, role: 'purchase', role_overridden: false, emphasis: 'primary' },
  { label: 'Continue to cancel', path: { type: 'manage_subscription' }, role: 'continue', role_overridden: false, emphasis: 'link' },
  { label: 'Not now', path: { type: 'dismiss' }, role: 'not_now', role_overridden: false, emphasis: 'link' },
];
const meta = {
  title: 'SDK/Placements/CtaActions', component: CtaActions,
  args: { ctas: fiveCtas, onCtaClickIndex: index => console.info('Authored CTA index:', index) },
} satisfies Meta<typeof CtaActions>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A primary CTA authored third displays first without changing interaction indices. */
export const FiveActions: Story = {};
/** The retention flow keeps its semantic continue exit visible below the offers. */
export const CancelSave: Story = { args: { ctas: [fiveCtas[0], fiveCtas[1], fiveCtas[3]] } };
/** Notification dismiss is a semantic role independent of its path. */
export const Notification: Story = { args: { ctas: [fiveCtas[2], { ...fiveCtas[4], role: 'dismiss' }] } };
/** One action needs no empty second button. */
export const SingleAction: Story = { args: { ctas: [fiveCtas[2]] } };
/** Three buttons stack inside a narrow host; text actions remain underneath. */
export const Narrow: Story = { render: args => <div style={{ width: 220 }}><CtaActions {...args} /></div> };
