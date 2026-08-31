/**
 * GrowthBook-backed experiment assignment provider.
 *
 * The GrowthBook client is injected by the customer. This adapter therefore
 * evaluates the customer's real GrowthBook instance without bundling its SDK,
 * fetching credentials, or accepting executable customer code.
 */
import type { GrowthBook } from '@growthbook/growthbook';
import type {
  ExperimentAssignmentProvider,
  ExperimentProviderState,
} from '@revt-eng/core';

/** One RevTurbine experiment handle mapped to its GrowthBook feature key. */
export interface GrowthBookExperimentBinding {
  /** Stable RevTurbine experiment handle emitted in normalized assignments. */
  experimentHandle: string;
  /** GrowthBook feature key whose evaluated string value is the variant handle. */
  featureKey: string;
  /** Optional allowlist that rejects unexpected GrowthBook variant values. */
  allowedVariants?: readonly string[];
}

/** Options for the separately bundled GrowthBook assignment adapter. */
export interface GrowthBookExperimentAssignmentOptions {
  /** An initialized customer-owned GrowthBook client. */
  client: Pick<GrowthBook<Record<string, string>>, 'evalFeature'>;
  /** Explicit experiment-to-feature mappings; no naming convention is assumed. */
  bindings: readonly GrowthBookExperimentBinding[];
  /** Customer-controlled revision for feature/config changes. */
  providerRevision?: string | number;
}

/** Machine-readable reasons a GrowthBook assignment cannot be normalized. */
export type GrowthBookAssignmentErrorReason =
  | 'duplicate_experiment_handle'
  | 'invalid_binding'
  | 'unknown_feature'
  | 'invalid_variant'
  | 'unexpected_variant';

/** Raised when GrowthBook cannot produce a valid normalized assignment. */
export class GrowthBookAssignmentError extends Error {
  /** Stable reason suitable for logs and error handling. */
  readonly reason: GrowthBookAssignmentErrorReason;
  /** RevTurbine experiment whose assignment failed. */
  readonly experimentHandle: string;
  /** GrowthBook feature evaluated for the assignment. */
  readonly featureKey: string;

  /** Construct a named GrowthBook normalization failure. */
  constructor(
    reason: GrowthBookAssignmentErrorReason,
    binding: GrowthBookExperimentBinding,
    detail: string,
  ) {
    super(
      `GrowthBook assignment for experiment "${binding.experimentHandle}" `
      + `(feature "${binding.featureKey}") failed: ${detail}`,
    );
    this.name = 'GrowthBookAssignmentError';
    this.reason = reason;
    this.experimentHandle = binding.experimentHandle;
    this.featureKey = binding.featureKey;
  }
}

function validateBindings(bindings: readonly GrowthBookExperimentBinding[]): void {
  const handles = new Set<string>();
  for (const binding of bindings) {
    if (!binding.experimentHandle.trim() || !binding.featureKey.trim()) {
      throw new GrowthBookAssignmentError(
        'invalid_binding',
        binding,
        'experiment handles and GrowthBook feature keys must be non-empty',
      );
    }
    if (handles.has(binding.experimentHandle)) {
      throw new GrowthBookAssignmentError(
        'duplicate_experiment_handle',
        binding,
        'the experiment handle is mapped more than once',
      );
    }
    handles.add(binding.experimentHandle);
  }
}

/**
 * Create an assignment provider backed by an initialized GrowthBook client.
 *
 * Each GrowthBook feature must evaluate to a non-empty string variant handle.
 * Unknown features and invalid values fail explicitly instead of being
 * converted to an empty assignment or fabricated fallback.
 */
export function createGrowthBookExperimentAssignmentProvider(
  options: GrowthBookExperimentAssignmentOptions,
): ExperimentAssignmentProvider {
  validateBindings(options.bindings);

  return {
    domain: 'experiments',
    providerHandle: 'growthbook',
    providerRevision: options.providerRevision,
    ownedExperimentHandles: options.bindings.map((binding) => binding.experimentHandle),
    resolve(): ExperimentProviderState {
      const assignments: Record<string, string> = {};

      for (const binding of options.bindings) {
        const result = options.client.evalFeature(binding.featureKey);
        if (result.source === 'unknownFeature') {
          throw new GrowthBookAssignmentError(
            'unknown_feature',
            binding,
            'GrowthBook reported an unknown feature',
          );
        }

        if (typeof result.value !== 'string' || result.value.length === 0) {
          throw new GrowthBookAssignmentError(
            'invalid_variant',
            binding,
            'the evaluated value must be a non-empty string variant handle',
          );
        }

        if (binding.allowedVariants && !binding.allowedVariants.includes(result.value)) {
          throw new GrowthBookAssignmentError(
            'unexpected_variant',
            binding,
            `variant "${result.value}" is outside the configured allowlist`,
          );
        }

        assignments[binding.experimentHandle] = result.value;
      }

      return { assignments };
    },
  };
}
