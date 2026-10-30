import type { Meta, StoryObj } from '@storybook/react-vite';
import { EngagementArea } from './EngagementArea';
import { TelemetryScope } from './TelemetryScope';

/**
 * ST-1344 — the area → feature → action telemetry hierarchy. `EngagementArea`
 * takes an `area`, a `feature`, or both; a `TelemetryScope` `area` above it
 * survives when only `feature` is given. Provider-less by design (AC-13): without
 * a `RevTurbineProvider` the tracker is a safe no-op, so the stories render with
 * zero setup and no emitted traffic. The a11y addon runs axe on every story;
 * `test: 'error'` fails the story run on any violation.
 */
const meta = {
  title: 'SDK/Telemetry/EngagementArea',
  component: EngagementArea,
  parameters: { a11y: { test: 'error' } },
} satisfies Meta<typeof EngagementArea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AreaOnly: Story = {
  args: { area: 'pricing', children: 'Area only — events carry area, no feature' },
};

export const AreaAndFeature: Story = {
  args: {
    area: 'editor',
    feature: 'timeline',
    children: 'Area and feature — events carry both',
  },
};

export const FeatureInsideScopeArea: Story = {
  args: { feature: 'timeline', children: 'Feature inside a TelemetryScope area' },
  render: (args) => (
    <TelemetryScope area="editor">
      <EngagementArea {...args} />
    </TelemetryScope>
  ),
};

export const FeatureInheritsOuterArea: Story = {
  args: { feature: 'export', children: 'Feature only — inherits the outer area' },
  render: (args) => (
    <TelemetryScope area="billing">
      <EngagementArea {...args} />
    </TelemetryScope>
  ),
};
