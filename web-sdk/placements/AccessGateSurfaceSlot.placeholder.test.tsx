/**
 * @vitest-environment jsdom
 *
 * D-59 (Kent, 2026-10-06) / BL-0536 — a gate slot whose entitlement has no
 * Access Gate placement shows a default access-denied placeholder. It never
 * borrows another entitlement's gate, and an app-supplied `deniedFallback`
 * still wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AccessGateSurfaceSlot } from './AccessGateSurfaceSlot';
import { RevTurbineProvider } from '../react/RevTurbineProvider';
import type { RevTurbineInitInputOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const gateFor = (entitlement: string, header: string) => ({
  id: `pl_gate_${entitlement}`,
  name: `gate ${entitlement}`,
  category: 'gated',
  order: 0,
  trigger: { type: 'entitlement_gate', entitlement_handle: entitlement },
  payloads: [{
    id: `pay_gate_${entitlement}`,
    target: { plan_ids: [], segment_chips: [] },
    surfaces: [{ template_id: 'inline_gate_message', fields: { header, body: 'Unlock it' }, ctas: [] }],
  }],
});

const options = (placements: unknown[]) => ({
  tenantId: 't_1',
  runtimeMode: 'local_only',
  anonymousTelemetry: false,
  localRuntime: {
    playbook: {
      artifact_type: 'playbook',
      format_version: '1.0.0',
      playbook_handle: 'default',
      playbook_version_id: null,
      tenant_id: 't_1',
      environment_id: 'production',
      plans: [],
      entitlements: [],
      entitlement_rules: [],
      segments: [],
      content_ui_paths: [],
      placements,
    },
    resolvers: { checkEntitlement: async () => ({ allowed: false, status: 'denied', reason: 'test_denied' }) },
  },
}) as unknown as RevTurbineInitInputOptions;

async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

async function waitForDom(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => {});
    assertion();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('D-59 — gate slot with no gate for its entitlement', () => {
  it('shows the access-denied placeholder, not another entitlement\'s gate', async () => {
    await mount(
      <RevTurbineProvider options={options([gateFor('seats_pro', 'Add more seats')])}>
        <AccessGateSurfaceSlot id="exports_gate" can="exports_pro">
          <span>PAID FEATURE</span>
        </AccessGateSurfaceSlot>
      </RevTurbineProvider>,
    );
    await waitForDom(() => expect(container?.querySelector('[data-rt-access-denied]')).not.toBeNull());
    expect(container?.querySelector('[data-rt-entitlement="exports_pro"]')).not.toBeNull();
    expect(container?.textContent).not.toContain('Add more seats');
    expect(container?.textContent).not.toContain('PAID FEATURE');
  });

  it('still renders the gate authored for the slot\'s own entitlement', async () => {
    await mount(
      <RevTurbineProvider options={options([gateFor('seats_pro', 'Add more seats'), gateFor('exports_pro', 'Unlock exports')])}>
        <AccessGateSurfaceSlot id="exports_gate" can="exports_pro">
          <span>PAID FEATURE</span>
        </AccessGateSurfaceSlot>
      </RevTurbineProvider>,
    );
    await waitForDom(() => expect(container?.textContent).toContain('Unlock exports'));
    expect(container?.querySelector('[data-rt-access-denied]')).toBeNull();
  });

  it('an app-supplied deniedFallback replaces the placeholder', async () => {
    await mount(
      <RevTurbineProvider options={options([])}>
        <AccessGateSurfaceSlot id="exports_gate" can="exports_pro" deniedFallback={<span>CUSTOM DENIED</span>}>
          <span>PAID FEATURE</span>
        </AccessGateSurfaceSlot>
      </RevTurbineProvider>,
    );
    await waitForDom(() => expect(container?.textContent).toContain('CUSTOM DENIED'));
    expect(container?.querySelector('[data-rt-access-denied]')).toBeNull();
  });
});
