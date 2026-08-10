/**
 * @vitest-environment jsdom
 *
 * Plan 174 TASK-15 (plan 170 Q-3 / plan 144 REQ-18 slot half) — the renderer
 * populates `PlacementSlotProps.exposureRef`.
 *
 * The prop was declared on the slot contract (plan 144 TASK-9) but the
 * renderer never passed it, so a slot component that dutifully attached
 * `props.exposureRef` got `undefined` and slot-rendered placements never got
 * viewport-qualified exposure — while `events.md` documented the prop as
 * working. These tests pin the threading: a renderer-supplied callback
 * reaches the slot component and fires with the attached element; omitting
 * it leaves slots exactly as before. The exposure *basis* mechanics
 * (viewport / render_fallback / default-mode impression timing) are pinned
 * by the plan-144 controller and hook suites — this change does not touch
 * the controller.
 *
 * Plan: docs/dev-lifecycle/inprogress/174-spec-check-remediation-batch.md
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlacementRenderer } from './PlacementRenderer';
import { PlacementTypeRegistry } from './registry';
import type { PlacementSlotProps } from './types';
import type { PlacementOutput } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

const received: { props: PlacementSlotProps | null } = { props: null };

function ExposureProbeSlot(props: PlacementSlotProps): React.ReactElement {
  received.props = props;
  return (
    <div data-testid="probe-root" ref={(el) => props.exposureRef?.(el)}>
      probe
    </div>
  );
}

function makeRegistry(): PlacementTypeRegistry {
  const registry = new PlacementTypeRegistry();
  registry.register({
    id: 'exposure_probe',
    label: 'Exposure probe',
    description: 'Test slot that attaches the exposure ref to its root.',
    surfaceType: 'banner',
    component: ExposureProbeSlot,
  });
  return registry;
}

const placement: PlacementOutput = {
  output_id: 'out_exp_1',
  rule_id: 'rule_1',
  decision_id: 'dec_1',
  config_version: 'v1',
  category: 'fixed',
  surface: { type: 'banner', template: 'banner_placement', slot_id: 'slot_1' },
  content: {},
  cta_path: {},
  present_upsell: false,
};

async function mount(exposureRef?: (element: Element | null) => void): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <PlacementRenderer
        placement={placement}
        registry={makeRegistry()}
        {...(exposureRef ? { exposureRef } : {})}
      />,
    );
  });
}

describe('PlacementRenderer exposureRef threading (AC-15)', () => {
  it('passes a renderer-supplied exposureRef into slot props and it fires with the attached root', async () => {
    const exposureRef = vi.fn();
    await mount(exposureRef);

    expect(typeof received.props?.exposureRef).toBe('function');
    expect(exposureRef).toHaveBeenCalledTimes(1);
    const element = exposureRef.mock.calls[0]?.[0] as Element;
    expect(element).toBeInstanceOf(Element);
    expect(element.getAttribute('data-testid')).toBe('probe-root');
  });

  it('omitting the prop leaves slot props without exposureRef — behavior unchanged', async () => {
    await mount(undefined);
    expect(received.props?.exposureRef).toBeUndefined();
    expect(container?.textContent).toContain('probe');
  });
});
