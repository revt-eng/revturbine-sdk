import type { Meta, StoryObj } from '@storybook/react-vite';
import { Track } from './Track';

/**
 * Plan 144 AC-14 — the story half of the `Track asChild` contract. The a11y
 * addon runs axe on every story; `test: 'error'` makes any violation FAIL the
 * story test run — the story-side axe assertion AC-14 names. The behavioral
 * halves (composed `onClick`, `preventDefault` suppression, unchanged
 * accessible name and disabled state) are asserted in `Track.test.tsx`.
 *
 * Provider-less by design (AC-13): without a `RevTurbineProvider` the tracker
 * is a safe no-op, so the stories render real composition behavior with zero
 * setup and no emitted traffic.
 */
const meta = {
  title: 'SDK/Telemetry/Track',
  component: Track,
  parameters: { a11y: { test: 'error' } },
  args: { event: 'story_cta_clicked' },
} satisfies Meta<typeof Track>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultSpanHost: Story = {
  args: { children: 'Wraps a span host by default' },
};

export const AsChildButton: Story = {
  args: {
    asChild: true,
    children: (
      <button type="button" onClick={() => {}}>
        Composed onto the child&apos;s own onClick — no wrapper element
      </button>
    ),
  },
};

export const AsChildPreventDefault: Story = {
  args: {
    asChild: true,
    children: (
      <button type="button" onClick={(e) => e.preventDefault()}>
        preventDefault in the child suppresses the telemetry
      </button>
    ),
  },
};

export const AsChildDisabledChild: Story = {
  args: {
    asChild: true,
    children: (
      <button type="button" disabled>
        Disabled state and accessible name pass through unchanged
      </button>
    ),
  },
};

export const CustomHostWithScope: Story = {
  args: {
    as: 'div',
    data: { plan: 'pro' },
    options: { area: 'stories', action: 'select' },
    children: 'Custom div host carrying data and a scope override',
  },
};
