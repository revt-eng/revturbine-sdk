/**
 * Optimizely-backed experiment assignment provider.
 *
 * The customer injects an initialized client. The adapter contains no SDK
 * credentials and is shipped only from the optional Optimizely entry point.
 */
import type { Client, UserAttributes } from '@optimizely/optimizely-sdk';
import type {
  DomainProviderResolutionInput,
  ExperimentAssignmentProvider,
  ExperimentProviderState,
} from '@revt-eng/core';

/** One RevTurbine experiment handle mapped to an Optimizely experiment key. */
export interface OptimizelyExperimentBinding {
  /** Stable RevTurbine experiment handle used by decisions and telemetry. */
  experimentHandle: string;
  /** Experiment key configured in the customer-owned Optimizely project. */
  experimentKey: string;
  /** Optional allowlist that rejects unexpected Optimizely variation keys. */
  allowedVariants?: readonly string[];
}

/** Options for the separately bundled Optimizely assignment adapter. */
export interface OptimizelyExperimentAssignmentOptions {
  /** An initialized customer-owned Optimizely client. */
  client: Pick<Client, 'getVariation'>;
  /** Explicit experiment mappings; no naming convention is assumed. */
  bindings: readonly OptimizelyExperimentBinding[];
  /** Override how the Optimizely user id is derived from current context. */
  userId?: (input: DomainProviderResolutionInput) => string | undefined;
  /** Optional customer-owned Optimizely attributes for audience evaluation. */
  attributes?: (input: DomainProviderResolutionInput) => UserAttributes | undefined;
  /** Customer-controlled revision for Optimizely datafile/context changes. */
  providerRevision?: string | number;
}

/** Machine-readable reasons an Optimizely assignment cannot be normalized. */
export type OptimizelyAssignmentErrorReason =
  | 'duplicate_experiment_handle'
  | 'invalid_binding'
  | 'unexpected_variant';

/** Raised for invalid Optimizely mappings or variation values. */
export class OptimizelyAssignmentError extends Error {
  /** Stable reason suitable for diagnostics and structured SDK outcomes. */
  readonly reason: OptimizelyAssignmentErrorReason;
  /** RevTurbine experiment whose mapping failed. */
  readonly experimentHandle: string;
  /** Optimizely experiment key used for lookup. */
  readonly experimentKey: string;

  /** Construct a named Optimizely normalization failure. */
  constructor(
    reason: OptimizelyAssignmentErrorReason,
    binding: OptimizelyExperimentBinding,
    detail: string,
  ) {
    super(
      `Optimizely assignment for experiment "${binding.experimentHandle}" `
      + `(experiment key "${binding.experimentKey}") failed: ${detail}`,
    );
    this.name = 'OptimizelyAssignmentError';
    this.reason = reason;
    this.experimentHandle = binding.experimentHandle;
    this.experimentKey = binding.experimentKey;
  }
}

function validateBindings(bindings: readonly OptimizelyExperimentBinding[]): void {
  const handles = new Set<string>();
  for (const binding of bindings) {
    if (!binding.experimentHandle.trim() || !binding.experimentKey.trim()) {
      throw new OptimizelyAssignmentError(
        'invalid_binding',
        binding,
        'experiment handles and Optimizely keys must be non-empty',
      );
    }
    if (handles.has(binding.experimentHandle)) {
      throw new OptimizelyAssignmentError(
        'duplicate_experiment_handle',
        binding,
        'the experiment handle is mapped more than once',
      );
    }
    handles.add(binding.experimentHandle);
  }
}

/**
 * Create an assignment provider backed by an initialized Optimizely client.
 * A null variation is retained as explicit non-enrollment and never converted
 * to a control assignment.
 */
export function createOptimizelyExperimentAssignmentProvider(
  options: OptimizelyExperimentAssignmentOptions,
): ExperimentAssignmentProvider {
  validateBindings(options.bindings);

  return {
    domain: 'experiments',
    providerHandle: 'optimizely',
    providerRevision: options.providerRevision,
    ownedExperimentHandles: options.bindings.map((binding) => binding.experimentHandle),
    resolve(input?: DomainProviderResolutionInput): ExperimentProviderState {
      const fallbackController = new AbortController();
      const resolutionInput = input ?? {
        userContext: {},
        contextRevision: 'legacy',
        signal: fallbackController.signal,
      };
      const userId = options.userId?.(resolutionInput) ?? resolutionInput.userContext.id;
      const assignments: Record<string, string> = {};
      const selections: NonNullable<ExperimentProviderState['selections']> = {};

      for (const binding of options.bindings) {
        if (!userId) {
          selections[binding.experimentHandle] = {
            status: 'unavailable',
            experimentHandle: binding.experimentHandle,
            reason: 'provider_not_ready',
            providerHandle: 'optimizely',
            ...(options.providerRevision !== undefined
              ? { providerRevision: options.providerRevision }
              : {}),
          };
          continue;
        }

        const variant = options.client.getVariation(
          binding.experimentKey,
          userId,
          options.attributes?.(resolutionInput),
        );
        if (variant === null || variant.length === 0) {
          selections[binding.experimentHandle] = {
            status: 'not_assigned',
            experimentHandle: binding.experimentHandle,
            reason: 'not_enrolled',
            providerHandle: 'optimizely',
            ...(options.providerRevision !== undefined
              ? { providerRevision: options.providerRevision }
              : {}),
          };
          continue;
        }
        if (binding.allowedVariants && !binding.allowedVariants.includes(variant)) {
          throw new OptimizelyAssignmentError(
            'unexpected_variant',
            binding,
            `variant "${variant}" is outside the configured allowlist`,
          );
        }

        assignments[binding.experimentHandle] = variant;
        selections[binding.experimentHandle] = {
          status: 'assigned',
          experimentHandle: binding.experimentHandle,
          variantHandle: variant,
          providerHandle: 'optimizely',
          ...(options.providerRevision !== undefined
            ? { providerRevision: options.providerRevision }
            : {}),
        };
      }

      return { assignments, selections };
    },
  };
}
