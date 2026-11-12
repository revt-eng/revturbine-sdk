/**
 * @vitest-environment jsdom
 *
 * ST-1741 (SDK 0.17.0, Kent's D-7) — usage that counts down, through the React
 * surfaces: `<Gate can cost>` (the Color42 shape: a credits rule with
 * `block_with_upsell`, the app mirroring `{ status: 'allowed', limit, used }`),
 * `useEntitlement`, `useCan` and `useGatedAction`.
 *
 *   - a cost that fits keeps the mirrored "allowed": the children render;
 *   - a cost that does not fit denies, and the Gate renders its gate placement
 *     (or `deniedFallback`) instead of the children;
 *   - a Gate without a cost is unchanged: the mirrored "allowed" stands;
 *   - a usage limit counts UP: `used + cost` against the limit;
 *   - the Gate and hooks take no new prop: the direction follows the rule kind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AccessGateSurfaceSlot as Gate } from './AccessGateSurfaceSlot';
import { RevTurbineProvider } from '../react/RevTurbineProvider';
import { useRevTurbine } from '../react/useRevTurbine';
import { useEntitlement } from '../react/useEntitlement';
import { useCan } from '../react/useCan';
import { useGatedAction } from '../react/useGatedAction';
import type { RevTurbineInitInputOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let userSeq = 0;

const gateFor = (entitlement: string, header: string) => ({
  id: `pl_gate_${entitlement}`,
  name: `gate ${entitlement}`,
  category: 'gated',
  order: 0,
  trigger: { type: 'entitlement_gate', entitlement_handle: entitlement },
  payloads: [{
    id: `pay_gate_${entitlement}`,
    target: { plan_ids: [], segment_chips: [] },
    surfaces: [{ template_id: 'inline_gate_message', fields: { header, body: 'Top up to continue' }, ctas: [] }],
  }],
});

const PLAYBOOK = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  playbook_handle: 'default',
  playbook_version_id: null,
  tenant_id: 't_1',
  environment_id: 'production',
  plans: [{ unique_handle: 'pro', name: 'Pro', tier_position: 0, sort_order: 0 }],
  entitlements: [
    { unique_handle: 'video_credits', name: 'Video credits', type: 'credits', unit: 'credits' },
    { unique_handle: 'api_calls', name: 'API calls', type: 'usage_limit', unit: 'calls' },
  ],
  entitlement_rules: [
    { id: 'r_video', entitlement_id: 'video_credits', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'credits', allowance: 1000, enforcement: 'block_with_upsell' } },
    { id: 'r_api', entitlement_id: 'api_calls', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 100, enforcement: 'hard_block' } },
  ],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [gateFor('video_credits', 'Out of video credits')],
};

const options = (entitlements: Record<string, unknown>): RevTurbineInitInputOptions => {
  userSeq += 1;
  return {
    user: { id: `u_gate_${userSeq}`, plan_handle: 'pro', entitlements },
    tenantId: 't_1',
    runtimeMode: 'local_only',
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    // A fresh copy per mount: an SDK instance may normalise the object it is given.
    localRuntime: { playbook: structuredClone(PLAYBOOK) },
  } as unknown as RevTurbineInitInputOptions;
};

async function mount(entitlements: Record<string, unknown>, node: React.ReactNode): Promise<void> {
  const opts = options(entitlements);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<RevTurbineProvider options={opts as never}>{node}</RevTurbineProvider>);
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 5); }); });
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 5); }); });
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' })));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) { await act(async () => root!.unmount()); root = null; }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const COLOR42 = { video_credits: { status: 'allowed', limit: 1000, used: 995 } };

describe('<Gate can cost> on a credits entitlement the app mirrored (the Color42 shape)', () => {
  it('a cost that fits renders the children', async () => {
    await mount(COLOR42, (
      <Gate id="g_fit" can="video_credits" cost={5}>
        <p>render video</p>
      </Gate>
    ));
    expect(container!.textContent).toContain('render video');
    expect(container!.textContent).not.toContain('Out of video credits');
  });

  it('a cost that does not fit renders the gate placement, not the children', async () => {
    await mount(COLOR42, (
      <Gate id="g_over" can="video_credits" cost={5.5}>
        <p>render video</p>
      </Gate>
    ));
    expect(container!.textContent).toContain('Out of video credits');
    expect(container!.textContent).not.toContain('render video');
  });

  it('a cost that does not fit renders deniedFallback when no placement is authored for the handle', async () => {
    // api_calls has no gate placement: a mirrored used of 99 plus a cost of 6
    // passes the limit of 100, so the Gate falls back to its own fallback.
    await mount({ api_calls: { status: 'allowed', used: 99 } }, (
      <Gate id="g_over_fb" can="api_calls" cost={6} deniedFallback={<p>buy more calls</p>}>
        <p>call the API</p>
      </Gate>
    ));
    expect(container!.textContent).toContain('buy more calls');
    expect(container!.textContent).not.toContain('call the API');
  });

  it('without a cost the Gate is unchanged: the mirrored allowed stands', async () => {
    await mount({ video_credits: { status: 'allowed', remaining: 0 } }, (
      <Gate id="g_nocost" can="video_credits">
        <p>render video</p>
      </Gate>
    ));
    expect(container!.textContent).toContain('render video');
  });

  it('cost 0 is free even when the mirrored balance is empty', async () => {
    await mount({ video_credits: { status: 'allowed', limit: 1000, used: 1000 } }, (
      <Gate id="g_free" can="video_credits" cost={0}>
        <p>render video</p>
      </Gate>
    ));
    expect(container!.textContent).toContain('render video');
  });

  it('a Gate re-decides when the app raises the mirrored balance (the SDK never decrements)', async () => {
    let setUsed: ((used: number) => void) | undefined;
    function Controls(): null {
      const { sdk } = useRevTurbine();
      setUsed = (used: number) => {
        sdk!.setUserContext({ entitlements: { video_credits: { status: 'allowed', limit: 1000, used } } } as never);
      };
      return null;
    }
    await mount(COLOR42, (
      <>
        <Controls />
        <Gate id="g_flip" can="video_credits" cost={40}>
          <p>render video</p>
        </Gate>
      </>
    ));
    expect(container!.textContent).toContain('Out of video credits');
    await act(async () => { setUsed!(900); });
    await settle();
    expect(container!.textContent).toContain('render video');
  });
});

describe('<Gate can cost> on a usage limit counts up', () => {
  it('used + cost against the limit: fits renders, does not fit denies', async () => {
    await mount({ api_calls: { status: 'allowed', used: 95 } }, (
      <Gate id="g_up_fit" can="api_calls" cost={5}><p>fits</p></Gate>
    ));
    expect(container!.textContent).toContain('fits');
    await act(async () => root!.unmount());
    container!.remove();
    await mount({ api_calls: { status: 'allowed', used: 95 } }, (
      <Gate id="g_up_over" can="api_calls" cost={6} deniedFallback={<p>limit reached</p>}><p>fits</p></Gate>
    ));
    expect(container!.textContent).toContain('limit reached');
    expect(container!.textContent).not.toContain('fits');
  });
});

describe('hooks use the same rule, with no new prop', () => {
  it('useEntitlement({ cost }), useCan(handle, { cost }) and useGatedAction on mirrored credits', async () => {
    let run: (() => Promise<{ ran: boolean }>) | undefined;
    function Probe(): React.ReactElement {
      const fits = useEntitlement({ handle: 'video_credits', cost: 5 });
      const over = useEntitlement({ handle: 'video_credits', cost: 6 });
      const can = useCan('video_credits', { cost: 5 });
      const cannot = useCan('video_credits', { cost: 6 });
      const gated = useGatedAction('video_credits', async () => 'ok', { cost: 6 });
      run = gated.run as never;
      return <p>{`fits:${String(fits.denied)} over:${String(over.denied)} can:${String(can.can)} cannot:${String(cannot.can)}`}</p>;
    }
    await mount(COLOR42, <Probe />);
    expect(container!.textContent).toContain('fits:false over:true can:true cannot:false');
    let result: { ran: boolean } | undefined;
    await act(async () => { result = await run!(); });
    expect(result?.ran).toBe(false);
  });
});
