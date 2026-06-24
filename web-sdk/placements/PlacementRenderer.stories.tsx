import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { PlacementRenderer } from './PlacementRenderer';
import { CtaResolverRegistry } from './cta-resolvers';
import type { PlacementOutput } from '../customer-side';

/**
 * A placement whose CTA uses a tenant-defined custom action (`connect_crm`)
 * carrying a `url` and a custom `org` param. The engine passes the authored
 * config straight through to `cta_path`; the SDK preserves the action name and
 * exposes the extra keys on `uiPath.params`.
 */
const customCtaPlacement: PlacementOutput = {
  output_id: 'story_custom_cta_01',
  category: 'fixed',
  surface: { template: 'banner_placement', type: 'banner', slot_id: 'top_banner' },
  content: {
    header: 'Connect your CRM',
    body: 'Sync deals to RevTurbine automatically.',
    cta_label: 'Connect',
    position: 'top',
    dismissible: true,
  },
  cta_path: { type: 'connect_crm', url: '/integrations/crm', org: 'acme' },
  rule_id: 'rule_custom_cta',
  decision_id: 'dec_custom_cta',
  config_version: 'v1',
  present_upsell: true,
};

/**
 * Demonstrates registering a {@link CtaResolver} for a custom action type. The
 * resolver is registered on a local `CtaResolverRegistry` passed via the
 * `ctaResolvers` prop, so clicking the CTA dispatches to it (rather than the
 * generic `onCtaClick` fallback) and reads the custom `params`.
 */
function CustomCtaResolverDemo() {
  const [log, setLog] = useState('Click “Connect” to fire the registered resolver.');

  const ctaResolvers = useMemo(() => {
    const registry = new CtaResolverRegistry();
    registry.register('connect_crm', (uiPath) => {
      setLog(`Resolver handled "${uiPath.type}" → url=${uiPath.url}, org=${String(uiPath.params?.org)}`);
    });
    return registry;
  }, []);

  return (
    <div style={{ maxWidth: 480 }}>
      <PlacementRenderer
        placement={customCtaPlacement}
        ctaResolvers={ctaResolvers}
        onCtaClick={() => setLog('Fallback onCtaClick fired — no resolver was registered for this action.')}
      />
      <p style={{ marginTop: 12, fontFamily: 'monospace', fontSize: 13 }} data-testid="cta-log">
        {log}
      </p>
    </div>
  );
}

const meta = {
  title: 'SDK/Placements/CustomCtaResolver',
  component: CustomCtaResolverDemo,
} satisfies Meta<typeof CustomCtaResolverDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Registered resolver handles the custom `connect_crm` CTA. */
export const ResolvedCustomCta: Story = {};
