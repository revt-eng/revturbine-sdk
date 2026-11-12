/**
 * @vitest-environment jsdom
 *
 * ST-1696 (SDK 0.16.0):
 *   - the per-call `cost` on `<Gate cost>`, `useEntitlement({ cost })`, `useCan`
 *     and `useGatedAction` reaches the entitlement check (Kent's final cost
 *     rule); a Gate on a usage-limit entitlement without a cost gets the
 *     missing-cost developer error;
 *   - BUG-1541: a Gate checks ONE entitlement. A second entitlement check
 *     fails closed (renders as denied) and logs one console.error naming the
 *     Gate id and the count; usage thresholds still combine; nesting works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AccessGateSurfaceSlot as Gate } from './AccessGateSurfaceSlot';
import { RevTurbineProvider } from '../react/RevTurbineProvider';
import { useEntitlement } from '../react/useEntitlement';
import { useCan } from '../react/useCan';
import { useGatedAction } from '../react/useGatedAction';
import type { RevTurbineInitInputOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let errorSpy: ReturnType<typeof vi.spyOn>;

const PLAYBOOK = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  playbook_handle: 'default',
  playbook_version_id: null,
  tenant_id: 't_1',
  environment_id: 'production',
  plans: [{ unique_handle: 'pro', name: 'Pro', tier_position: 0, sort_order: 0 }],
  entitlements: [
    { unique_handle: 'api_calls', name: 'API calls', type: 'usage_limit', unit: 'calls' },
    // A second usage-limit handle for the missing-cost test: core reports each
    // handle + code once per process, so it must not share a handle with a test
    // that already triggered it.
    { unique_handle: 'seats_used', name: 'Seats', type: 'usage_limit', unit: 'seats' },
    { unique_handle: 'export', name: 'Export', type: 'feature' },
    { unique_handle: 'sso', name: 'SSO', type: 'feature' },
  ],
  entitlement_rules: [
    { id: 'r_api', entitlement_id: 'api_calls', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 10, enforcement: 'hard_block' } },
    { id: 'r_seats', entitlement_id: 'seats_used', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'usage_limit', limit_value: 10, enforcement: 'hard_block' } },
    { id: 'r_ex', entitlement_id: 'export', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'feature', enabled: true } },
    { id: 'r_sso', entitlement_id: 'sso', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], type_fields: { kind: 'feature', enabled: false } },
  ],
  segments: [],
  content_ui_paths: [],
  surface_templates: [],
  placements: [],
};

const options = (): RevTurbineInitInputOptions => ({
  user: { id: 'u1', plan_handle: 'pro' },
  tenantId: 't_1',
  runtimeMode: 'local_only',
  anonymousTelemetry: false,
  contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
  // A fresh copy per mount: an SDK instance may normalise the object it is given.
  localRuntime: { playbook: structuredClone(PLAYBOOK) },
}) as unknown as RevTurbineInitInputOptions;

async function mount(node: React.ReactNode): Promise<void> {
  const opts = options();
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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => '' })));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) { await act(async () => root!.unmount()); root = null; }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const errors = (needle: string): string[] =>
  errorSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(needle));

describe('<Gate cost>', () => {
  it('forwards the cost: it fits, so the children render', async () => {
    await mount(
      <Gate id="g_fit" check={{ entitlement: 'api_calls', context: { used: 7 } }} cost={3} deniedFallback={<p>denied</p>}>
        <p>paid</p>
      </Gate>,
    );
    expect(container!.textContent).toContain('paid');
    expect(errors('without a cost')).toHaveLength(0);
  });

  it('forwards the cost: it does not fit, so the Gate is denied', async () => {
    await mount(
      <Gate id="g_over" check={{ entitlement: 'api_calls', context: { used: 7 } }} cost={3.5} deniedFallback={<p>denied</p>}>
        <p>paid</p>
      </Gate>,
    );
    expect(container!.textContent).toContain('denied');
    expect(container!.textContent).not.toContain('paid');
    // A denied Gate loads its gate placement, which reads every entitlement in
    // bulk: that must not report a missing cost for handles nobody checked.
    expect(errors('seats_used')).toHaveLength(0);
  });

  it('cost 0 is free even past the limit', async () => {
    await mount(
      <Gate id="g_free" check={{ entitlement: 'api_calls', context: { used: 25 } }} cost={0}>
        <p>paid</p>
      </Gate>,
    );
    expect(container!.textContent).toContain('paid');
  });

  it('a Gate on a usage-limit entitlement without a cost logs the missing-cost error once and still decides as before', async () => {
    await mount(
      <Gate id="g_missing" check={{ entitlement: 'seats_used', context: { used: 3 } }}>
        <p>paid</p>
      </Gate>,
    );
    expect(container!.textContent).toContain('paid');
    expect(errors('without a cost')).toHaveLength(1);
    expect(errors('without a cost')[0]).toContain('seats_used');
  });
});

describe('hooks forward cost', () => {
  it('useEntitlement({ cost }) and useCan(handle, { cost })', async () => {
    function Probe(): React.ReactElement {
      const a = useEntitlement({ handle: 'api_calls', context: { used: 7 }, cost: 4 });
      const b = useCan('api_calls', { context: { used: 7 }, cost: 3 });
      return <p>{`ent:${String(a.denied)} can:${String(b.can)} diag:${a.result?.diagnostic?.code ?? 'none'}`}</p>;
    }
    await mount(<Probe />);
    expect(container!.textContent).toContain('ent:true can:true diag:none');
    expect(errors('without a cost')).toHaveLength(0);
  });

  it('useGatedAction passes the cost in its context', async () => {
    let run: (() => Promise<{ ran: boolean }>) | undefined;
    function Probe(): null {
      const gated = useGatedAction('api_calls', async () => 'ok', { used: 7, cost: 4 });
      run = gated.run as never;
      return null;
    }
    await mount(<Probe />);
    let result: { ran: boolean } | undefined;
    await act(async () => { result = await run!(); });
    expect(result?.ran).toBe(false);
  });
});

describe('BUG-1541: one entitlement per Gate', () => {
  it('two entitlement checks in `check` fail closed and log one error naming the Gate id and the count', async () => {
    await mount(
      <Gate id="g_two" check={[{ entitlement: 'export' }, { entitlement: 'sso' }]} deniedFallback={<p>denied</p>}>
        <p>paid</p>
      </Gate>,
    );
    expect(container!.textContent).toContain('denied');
    expect(container!.textContent).not.toContain('paid');
    const logged = errors('exactly one entitlement');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('g_two');
    expect(logged[0]).toContain('2 entitlement checks');
  });

  it('`can` plus an entitlement in `check` is also two, and fails closed even when both would pass', async () => {
    await mount(
      <Gate id="g_can_plus" can="export" check={{ entitlement: 'api_calls' }} cost={1} deniedFallback={<p>denied</p>}>
        <p>paid</p>
      </Gate>,
    );
    expect(container!.textContent).toContain('denied');
    expect(errors('g_can_plus')).toHaveLength(1);
  });

  it('logs once per Gate id per session: a remounting Gate does not repeat the error', async () => {
    function Remounting(): React.ReactElement {
      const [n, setN] = React.useState(0);
      React.useEffect(() => { if (n < 3) setN((v) => v + 1); }, [n]);
      return (
        <Gate key={n} id="g_remount" check={[{ entitlement: 'export' }, { entitlement: 'sso' }]}>
          <p>paid</p>
        </Gate>
      );
    }
    await mount(<Remounting />);
    expect(errors('g_remount')).toHaveLength(1);
  });

  it('one entitlement plus usage thresholds still combines and renders', async () => {
    await mount(
      <Gate id="g_ok" can="export" check={{ usage: 'api_calls', threshold: 100 }}>
        <p>paid</p>
      </Gate>,
    );
    expect(container!.textContent).toContain('paid');
    expect(errors('exactly one entitlement')).toHaveLength(0);
  });

  it('nested Gates each check their own entitlement', async () => {
    await mount(
      <Gate id="outer" can="export" deniedFallback={<p>outer-denied</p>}>
        <Gate id="inner" can="sso" deniedFallback={<p>inner-denied</p>}>
          <p>paid</p>
        </Gate>
      </Gate>,
    );
    expect(container!.textContent).toContain('inner-denied');
    expect(container!.textContent).not.toContain('outer-denied');
    expect(errors('exactly one entitlement')).toHaveLength(0);
  });
});
