import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DomainProviderResolutionInput,
  ExperimentAssignmentProvider,
  RevTurbineEventEnvelope,
} from '@revt-eng/core';
import type { RevTurbineConfig } from '@revt-eng/schema';
import {
  composeEffectiveExperimentContext,
  createCompositeExperimentProvider,
} from './providers/experiment-context';
import {
  RevTurbineCustomerSdk,
  RuntimeMode,
  type RevTurbineInitOptions,
} from './customer-side';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 202,
    json: async () => ({}),
    text: async () => '',
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeSdk(overrides: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_experiment_context',
    apiKey: 'sk_test',
    ingestPublicKey: 'pub_test',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    runtimeMode: RuntimeMode.LocalOnly,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    eventBatching: { maxBatchSize: 100, flushIntervalMs: 0 },
    ...overrides,
  });
}

describe('effective experiment context', () => {
  it('coalesces equal assignments and rejects caller/provider disagreement', () => {
    const equal = composeEffectiveExperimentContext(
      { id: 'u1', experiments: { pricing_test: 'treatment' } },
      {
        assignments: { pricing_test: 'treatment' },
        selections: {
          pricing_test: {
            status: 'assigned',
            experimentHandle: 'pricing_test',
            variantHandle: 'treatment',
            providerHandle: 'fixture',
          },
        },
      },
      '1',
    );
    expect(equal.userContext.experiments).toEqual({ pricing_test: 'treatment' });
    expect(equal.experimentSelections.pricing_test).toMatchObject({
      status: 'assigned',
      providerHandle: 'fixture',
    });

    const conflict = composeEffectiveExperimentContext(
      { id: 'u1', experiments: { pricing_test: 'control' } },
      {
        assignments: { pricing_test: 'treatment' },
        selections: {
          pricing_test: {
            status: 'assigned',
            experimentHandle: 'pricing_test',
            variantHandle: 'treatment',
            providerHandle: 'fixture',
          },
        },
      },
      '1',
    );
    expect(conflict.userContext.experiments).toBeUndefined();
    expect(conflict.experimentSelections.pricing_test).toMatchObject({
      status: 'unsupported',
      reason: 'assignment_conflict',
    });
  });

  it('reports overlapping provider ownership instead of choosing registration order', async () => {
    const first: ExperimentAssignmentProvider = {
      domain: 'experiments',
      providerHandle: 'first',
      ownedExperimentHandles: ['pricing_test'],
      resolve: () => ({ assignments: { pricing_test: 'control' } }),
    };
    const second: ExperimentAssignmentProvider = {
      domain: 'experiments',
      providerHandle: 'second',
      ownedExperimentHandles: ['pricing_test'],
      resolve: () => ({ assignments: { pricing_test: 'treatment' } }),
    };

    const state = await createCompositeExperimentProvider([first, second]).resolve();
    expect(state.assignments).toEqual({});
    expect(state.selections?.pricing_test).toMatchObject({
      status: 'unsupported',
      reason: 'ownership_conflict',
    });
  });

  it('detects dynamic ownership from a legacy provider result', async () => {
    const legacy: ExperimentAssignmentProvider = {
      domain: 'experiments',
      resolve: () => ({ assignments: { pricing_test: 'control' } }),
    };
    const declared: ExperimentAssignmentProvider = {
      domain: 'experiments',
      ownedExperimentHandles: ['pricing_test'],
      resolve: () => ({ assignments: { pricing_test: 'treatment' } }),
    };

    const state = await createCompositeExperimentProvider([legacy, declared]).resolve();
    expect(state.assignments).toEqual({});
    expect(state.selections?.pricing_test).toMatchObject({
      status: 'unsupported',
      reason: 'ownership_conflict',
    });
  });

  it('resolves a zero-argument legacy provider once per context revision', async () => {
    const resolve = vi.fn(() => ({ assignments: { pricing_test: 'treatment' } }));
    const legacy: ExperimentAssignmentProvider = { domain: 'experiments', resolve };
    const sdk = makeSdk({ user: { id: 'user_a' }, domainProviders: [legacy] });

    await expect(sdk.getExperimentVariant('pricing_test')).resolves.toMatchObject({
      status: 'assigned',
      variantHandle: 'treatment',
    });
    await sdk.getEffectiveUserContext();
    await sdk.getExperimentVariant('pricing_test');
    expect(resolve).toHaveBeenCalledTimes(1);

    sdk.identify('user_b');
    await sdk.getExperimentVariant('pricing_test');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('caches experiment assignment without freezing other zero-TTL domains', async () => {
    const resolveExperiment = vi.fn(() => ({ assignments: { pricing_test: 'treatment' } }));
    const resolvePlan = vi.fn(() => ({ currentPlanHandle: 'free' }));
    const sdk = makeSdk({
      user: { id: 'user_a' },
      domainProviders: [
        { domain: 'experiments', resolve: resolveExperiment },
        { domain: 'plan', resolve: resolvePlan },
      ],
    });

    await sdk.getExperimentVariant('pricing_test');
    await sdk.getEligiblePlans();
    await sdk.getEligibleAddons();

    expect(resolveExperiment).toHaveBeenCalledTimes(1);
    expect(resolvePlan).toHaveBeenCalledTimes(3);
  });

  it('invalidates cached assignments when a provider revision changes', async () => {
    let revision = 1;
    let variant = 'control';
    const resolve = vi.fn(() => ({ assignments: { pricing_test: variant } }));
    const provider: ExperimentAssignmentProvider = {
      domain: 'experiments',
      ownedExperimentHandles: ['pricing_test'],
      get providerRevision() { return revision; },
      resolve,
    };
    const sdk = makeSdk({ user: { id: 'user_a' }, domainProviders: [provider] });

    await expect(sdk.getExperimentVariant('pricing_test')).resolves.toMatchObject({
      status: 'assigned',
      variantHandle: 'control',
    });
    revision = 2;
    variant = 'treatment';
    await expect(sdk.getExperimentVariant('pricing_test')).resolves.toMatchObject({
      status: 'assigned',
      variantHandle: 'treatment',
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('reports provider timeouts without fabricating control', async () => {
    const provider: ExperimentAssignmentProvider = {
      domain: 'experiments',
      providerHandle: 'slow-fixture',
      ownedExperimentHandles: ['pricing_test'],
      resolve: () => new Promise(() => undefined),
    };
    const sdk = makeSdk({
      user: { id: 'user_a' },
      domainProviders: [provider],
      experimentProviderTimeoutMs: 5,
    });

    await expect(sdk.getExperimentVariant('pricing_test')).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'timeout',
      providerHandle: 'slow-fixture',
    });
    await expect(sdk.getEffectiveUserContext()).resolves.toHaveProperty('experiments', undefined);
  });

  it('discards a late assignment from the previous identity', async () => {
    const pending = new Map<string, (variant: string) => void>();
    const provider: ExperimentAssignmentProvider = {
      domain: 'experiments',
      providerHandle: 'race-fixture',
      ownedExperimentHandles: ['pricing_test'],
      resolve(input?: DomainProviderResolutionInput) {
        const userId = input?.userContext.id ?? 'unknown';
        return new Promise((resolve) => {
          pending.set(userId, (variant) => resolve({
            assignments: { pricing_test: variant },
          }));
        });
      },
    };
    const sdk = makeSdk({ user: { id: 'user_a' }, domainProviders: [provider] });

    const stale = sdk.getExperimentVariant('pricing_test');
    await vi.waitFor(() => expect(pending.has('user_a')).toBe(true));
    sdk.identify('user_b');
    const current = sdk.getExperimentVariant('pricing_test');
    await vi.waitFor(() => expect(pending.has('user_b')).toBe(true));
    pending.get('user_b')?.('treatment');
    await expect(current).resolves.toMatchObject({
      status: 'assigned',
      variantHandle: 'treatment',
    });
    pending.get('user_a')?.('control');
    await expect(stale).resolves.toMatchObject({
      status: 'assigned',
      variantHandle: 'treatment',
    });
    await expect(sdk.getEffectiveUserContext()).resolves.toMatchObject({
      id: 'user_b',
      experiments: { pricing_test: 'treatment' },
    });
  });

  it('stamps telemetry from the same cached assignment', async () => {
    const consumed: RevTurbineEventEnvelope[] = [];
    const experimentProvider: ExperimentAssignmentProvider = {
      domain: 'experiments',
      providerHandle: 'fixture',
      ownedExperimentHandles: ['pricing_test'],
      resolve: () => ({ assignments: { pricing_test: 'treatment' } }),
    };
    const sdk = makeSdk({
      user: { id: 'user_a' },
      domainProviders: [
        experimentProvider,
        {
          domain: 'events',
          resolve: () => ({
            consumers: [{ consume: (events: RevTurbineEventEnvelope[]) => consumed.push(...events) }],
          }),
        },
      ],
    });

    await sdk.getExperimentVariant('pricing_test');
    await sdk.capture('checkout_opened', {}, { immediate: true });
    await vi.waitFor(() => {
      expect(consumed.some((candidate) => candidate.type === 'checkout_opened')).toBe(true);
    });

    const event = consumed.find((candidate) => candidate.type === 'checkout_opened');
    expect(event?.properties.experiment_assignments).toEqual({ pricing_test: 'treatment' });
  });

  it('uses the effective assignment for segment targeting and output attribution', async () => {
    const config = {
      version: '1.0.0',
      plans: [],
      entitlements: [],
      entitlement_rules: [],
      segments: [{
        handle: 'pricing_test_enrolled',
        name: 'Pricing test enrolled',
        experiment_handle: 'pricing_test',
        predicates: [],
      }],
      content_ui_paths: [],
      surface_templates: [{ id: 'pricing_banner', surface_type: 'banner' }],
      placements: [{
        id: 'pricing_treatment',
        category: 'promotion',
        order: 1,
        payloads: [{
          id: 'pricing_payload',
          status: 'active',
          target: { segment_ids: ['pricing_test_enrolled'] },
          surfaces: [{
            template_id: 'pricing_banner',
            fields: {
              header: 'Treatment price',
              body: 'Assigned by the customer SDK',
              cta_label: 'Continue',
            },
            ctas: [],
          }],
        }],
      }],
    } satisfies RevTurbineConfig;
    const sdk = makeSdk({
      user: { id: 'user_a' },
      localRuntime: { exportedConfig: config },
      domainProviders: [{
        domain: 'experiments',
        providerHandle: 'fixture',
        ownedExperimentHandles: ['pricing_test'],
        resolve: () => ({ assignments: { pricing_test: 'treatment' } }),
      }],
    });
    const placementId = await sdk.registerSurfaceSlot({
      id: 'pricing_slot',
      name: 'Pricing slot',
      surfaceTemplateIds: ['pricing_banner'],
    });

    const selection = await sdk.getExperimentVariant('pricing_test');
    const decision = await sdk.getPlacementDecision({
      placementId,
      userId: 'user_a',
    });

    expect(selection).toMatchObject({ status: 'assigned', variantHandle: 'treatment' });
    expect(decision).toMatchObject({
      visible: true,
      output: {
        experiment_id: 'pricing_test',
        variant_key: 'treatment',
      },
    });
  });
});
