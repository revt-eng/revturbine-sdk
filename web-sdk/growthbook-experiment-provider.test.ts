import { describe, expect, it } from 'vitest';
import { GrowthBook } from '@growthbook/growthbook';
import {
  createNativeExperimentAssignmentProvider,
} from './providers/basic-experiment-provider';
import {
  createGrowthBookExperimentAssignmentProvider,
  GrowthBookAssignmentError,
} from './providers/growthbook-experiment-provider';
import { createCompositeExperimentProvider } from './providers/experiment-context';

const CONTRACT_FIXTURE = {
  experimentHandle: 'pricing_test',
  featureKey: 'pricing-variant',
  subject: 'contract-user',
  variants: Object.freeze(['control', 'treatment']),
};

describe('GrowthBook experiment assignment adapter', () => {
  it('normalizes a real GrowthBook evaluation', () => {
    const growthbook = new GrowthBook<Record<string, string>>({
      attributes: { id: CONTRACT_FIXTURE.subject },
    }).initSync({
      payload: {
        features: {
          [CONTRACT_FIXTURE.featureKey]: {
            defaultValue: 'control',
            rules: [{
              variations: [...CONTRACT_FIXTURE.variants],
              weights: [0, 1],
              key: CONTRACT_FIXTURE.experimentHandle,
            }],
          },
        },
      },
    });

    expect(growthbook.evalFeature(CONTRACT_FIXTURE.featureKey).source).toBe('experiment');

    const provider = createGrowthBookExperimentAssignmentProvider({
      client: growthbook,
      bindings: [{
        experimentHandle: CONTRACT_FIXTURE.experimentHandle,
        featureKey: CONTRACT_FIXTURE.featureKey,
        allowedVariants: CONTRACT_FIXTURE.variants,
      }],
    });

    expect(provider.resolve()).toEqual({
      assignments: { [CONTRACT_FIXTURE.experimentHandle]: 'treatment' },
    });
  });

  it('passes the section 16.4 fixture through native and external paths', () => {
    const native = createNativeExperimentAssignmentProvider({
      subject: CONTRACT_FIXTURE.subject,
      experiments: [{
        handle: CONTRACT_FIXTURE.experimentHandle,
        traffic_allocation: 1,
        variants: [{ variant_id: 'treatment', weight: 1 }],
      }],
    });
    const growthbook = new GrowthBook<Record<string, string>>({
      attributes: { id: CONTRACT_FIXTURE.subject },
    }).initSync({
      payload: {
        features: {
          [CONTRACT_FIXTURE.featureKey]: { defaultValue: 'treatment' },
        },
      },
    });
    const external = createGrowthBookExperimentAssignmentProvider({
      client: growthbook,
      bindings: [{
        experimentHandle: CONTRACT_FIXTURE.experimentHandle,
        featureKey: CONTRACT_FIXTURE.featureKey,
        allowedVariants: CONTRACT_FIXTURE.variants,
      }],
    });

    expect(external.resolve()).toEqual(native.resolve());
  });

  it('rejects unknown features instead of fabricating an assignment', () => {
    const growthbook = new GrowthBook<Record<string, string>>().initSync({
      payload: { features: {} },
    });
    const provider = createGrowthBookExperimentAssignmentProvider({
      client: growthbook,
      bindings: [{ experimentHandle: 'missing', featureKey: 'missing' }],
    });

    expect(() => provider.resolve()).toThrowError(GrowthBookAssignmentError);
    expect(() => provider.resolve()).toThrowError(/unknown feature/);
  });

  it('rejects values outside the declared variant vocabulary', () => {
    const growthbook = new GrowthBook<Record<string, string>>().initSync({
      payload: {
        features: { flag: { defaultValue: 'surprise' } },
      },
    });
    const provider = createGrowthBookExperimentAssignmentProvider({
      client: growthbook,
      bindings: [{
        experimentHandle: 'experiment',
        featureKey: 'flag',
        allowedVariants: ['control', 'treatment'],
      }],
    });

    expect(() => provider.resolve()).toThrowError(/outside the configured allowlist/);
  });

  it('normalizes an unexpected vendor value for the SDK variant API', async () => {
    const growthbook = new GrowthBook<Record<string, string>>().initSync({
      payload: { features: { flag: { defaultValue: 'surprise' } } },
    });
    const provider = createGrowthBookExperimentAssignmentProvider({
      client: growthbook,
      bindings: [{
        experimentHandle: 'experiment',
        featureKey: 'flag',
        allowedVariants: ['control', 'treatment'],
      }],
    });

    const state = await createCompositeExperimentProvider([provider]).resolve();
    expect(state.assignments).toEqual({});
    expect(state.selections?.experiment).toMatchObject({
      status: 'unsupported',
      reason: 'unknown_variant',
      providerHandle: 'growthbook',
    });
  });
});
