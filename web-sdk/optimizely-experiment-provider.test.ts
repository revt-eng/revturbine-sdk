import { describe, expect, it } from 'vitest';
import {
  createInstance,
  createStaticProjectConfigManager,
} from '@optimizely/optimizely-sdk';
import { createOptimizelyExperimentAssignmentProvider } from './providers/optimizely-experiment-provider';

const DATAFILE = {
  version: '4',
  revision: '1',
  accountId: 'account',
  projectId: 'project',
  anonymizeIP: false,
  botFiltering: false,
  sendFlagDecisions: false,
  attributes: [],
  audiences: [],
  events: [],
  featureFlags: [],
  groups: [],
  integrations: [],
  rollouts: [],
  experiments: [{
    id: 'experiment-1',
    key: 'pricing-experiment',
    status: 'Running',
    layerId: 'layer-1',
    audienceIds: [],
    forcedVariations: {},
    variations: [
      { id: 'variation-1', key: 'control', featureEnabled: true, variables: [] },
      { id: 'variation-2', key: 'treatment', featureEnabled: true, variables: [] },
    ],
    trafficAllocation: [
      { entityId: 'variation-1', endOfRange: 5000 },
      { entityId: 'variation-2', endOfRange: 10000 },
    ],
  }],
};

describe('Optimizely experiment assignment adapter', () => {
  it('normalizes a real initialized Optimizely client', () => {
    const client = createInstance({
      projectConfigManager: createStaticProjectConfigManager({ datafile: JSON.stringify(DATAFILE) }),
      disposable: true,
    });
    client.setForcedVariation('pricing-experiment', 'contract-user', 'treatment');
    const provider = createOptimizelyExperimentAssignmentProvider({
      client,
      bindings: [{
        experimentHandle: 'pricing_test',
        experimentKey: 'pricing-experiment',
        allowedVariants: ['control', 'treatment'],
      }],
      userId: () => 'contract-user',
    });

    expect(provider.resolve()).toMatchObject({
      assignments: { pricing_test: 'treatment' },
      selections: {
        pricing_test: {
          status: 'assigned',
          experimentHandle: 'pricing_test',
          variantHandle: 'treatment',
          providerHandle: 'optimizely',
        },
      },
    });
  });

  it('keeps non-enrollment distinct from control', () => {
    const client = createInstance({
      projectConfigManager: createStaticProjectConfigManager({ datafile: JSON.stringify(DATAFILE) }),
      disposable: true,
    });
    const provider = createOptimizelyExperimentAssignmentProvider({
      client,
      bindings: [{ experimentHandle: 'missing', experimentKey: 'missing' }],
      userId: () => 'contract-user',
    });

    expect(provider.resolve()).toMatchObject({
      assignments: {},
      selections: {
        missing: { status: 'not_assigned', reason: 'not_enrolled' },
      },
    });
  });
});
