import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaticProviders } from '../server-node';
import { createLocalEvaluationServer } from '../server-node/local-server';
import { configArtifactForRuntime } from './config-artifact';
import { RevTurbineCustomerSdk } from './customer-side';
import { InMemoryStorage } from './storage';

const config = configArtifactForRuntime(JSON.parse(readFileSync(
  new URL('../tests/parity/fixtures/configs/segment-membership.json', import.meta.url), 'utf8',
)), 'BUG-1127 real producer fixture');
if (!config) throw new Error('Missing hydration fixture');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BUG-1127: unbound hydration placement decisions', () => {
  it('recomputes the real server payload locally without persisting unbound answers', async () => {
    const fetch = vi.fn(() => { throw new Error('Unexpected decision HTTP'); });
    vi.stubGlobal('fetch', fetch);
    const producer = createLocalEvaluationServer({
      tenantId: 'tenant_parity', playbook: config,
      providers: createStaticProviders({ config, planHandle: 'starter' }),
    });
    const produced = await producer.evaluate({ userId: 'user_hydration', placements: [{ slotId: 'pl_open' }],
      entitlementHandles: ['paid_reports'] });
    const payload: typeof produced = JSON.parse(JSON.stringify(produced));
    expect(payload.decisions[0]?.visible).toBe(true);
    expect(payload.decisions[0]?.output).toBeDefined();
    const sessionStorage = new InMemoryStorage();
    const writes = vi.spyOn(sessionStorage, 'setItem');
    const sdk = new RevTurbineCustomerSdk({
      tenantId: 'tenant_parity', runtimeMode: 'local_only', anonymousTelemetry: false,
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      user: { id: 'user_hydration', plan_handle: 'starter' }, sessionStorage,
      localRuntime: { playbook: config },
    });
    const placementId = await sdk.registerPlacement({ name: 'Open offer', placementScopeKey: 'slot_open',
      metadata: { surface_slot_id: 'slot_open', surface_template_ids: ['banner_tpl'] } });
    writes.mockClear();
    sdk.hydrate(payload);
    // A legacy payload has no producer Playbook/context binding. It must not
    // plant unusable or stale entries into the persisted decision cache.
    expect(writes.mock.calls.filter(([key]) => key.includes('decision-cache'))).toEqual([]);
    const result = await sdk.getPlacementDecision({ placementId, userId: 'user_hydration' });
    expect(result).toMatchObject({ visible: true });
    expect(result.decisionSource).not.toBe('cache');
    expect(result.output?.content).toEqual(payload.decisions[0]?.output?.content);
    expect((await sdk.can('paid_reports')).allowed).toBe(payload.entitlements?.paid_reports?.allowed);
    expect((await sdk.getPlacementDecision({ placementId, userId: 'user_hydration' })).decisionSource).toBe('cache');
    expect(fetch).not.toHaveBeenCalled();
    sdk.dispose();
  });

  it.each(['playbook', 'missing-playbook'])('never resurrects a server placement after a changed %s', async (change) => {
    const producer = createLocalEvaluationServer({
      tenantId: 'tenant_parity', playbook: config,
      providers: createStaticProviders({ config, planHandle: 'starter' }),
    });
    const produced = await producer.evaluate({ userId: 'user_hydration', placements: [{ slotId: 'pl_open' }] });
    expect(produced.decisions[0]?.visible).toBe(true);
    const payload: typeof produced = JSON.parse(JSON.stringify(produced));
    // A compatible current Playbook with no placements must never inherit
    // the producer's visible placement, regardless of other input changes.
    const sdk = new RevTurbineCustomerSdk({
      tenantId: 'tenant_parity', runtimeMode: 'local_only', anonymousTelemetry: false,
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      user: { id: 'user_hydration', plan_handle: 'starter' },
      localRuntime: change === 'missing-playbook' ? undefined : { playbook: { ...config, placements: [] } },
    });
    const placementId = await sdk.registerPlacement({ name: 'Open offer', placementScopeKey: 'slot_open',
      metadata: { surface_slot_id: 'slot_open', surface_template_ids: ['banner_tpl'] } });
    sdk.hydrate(payload);
    const result = await sdk.getPlacementDecision({ placementId, userId: 'user_hydration' });
    expect(result.visible).toBe(false);
    expect(result.output).toBeUndefined();
    sdk.dispose();
  });

  it('uses current provider context instead of a producer grant for the same user and Playbook', async () => {
    const producer = createLocalEvaluationServer({
      tenantId: 'tenant_parity', playbook: config,
      providers: createStaticProviders({ config, planHandle: 'starter',
        userContext: { id: 'user_hydration', builtin_dimensions: { subscription_state: 'paid' } } }),
    });
    const payload = await producer.evaluate({ userId: 'user_hydration', placements: [{ slotId: 'pl_paid' }] });
    expect(payload.decisions[0]?.visible).toBe(true);
    const sdk = new RevTurbineCustomerSdk({
      tenantId: 'tenant_parity', runtimeMode: 'local_only', anonymousTelemetry: false,
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      user: { id: 'user_hydration', plan_handle: 'starter', builtin_dimensions: { subscription_state: 'trial' } },
      localRuntime: { playbook: config },
    });
    const placementId = await sdk.registerPlacement({ name: 'Paid offer', placementScopeKey: 'slot_paid',
      metadata: { surface_slot_id: 'slot_paid', surface_template_ids: ['banner_tpl'] } });
    sdk.hydrate(payload);
    expect((await sdk.getPlacementDecision({ placementId, userId: 'user_hydration' })).visible).toBe(false);
    sdk.dispose();
  });
});
