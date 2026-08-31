/**
 * Optional Optimizely experiment-assignment integration.
 * Importing the base SDK does not include this module or Optimizely; customers
 * inject their initialized client.
 */
export {
  createOptimizelyExperimentAssignmentProvider,
  OptimizelyAssignmentError,
} from './providers/optimizely-experiment-provider';
export type {
  OptimizelyAssignmentErrorReason,
  OptimizelyExperimentAssignmentOptions,
  OptimizelyExperimentBinding,
} from './providers/optimizely-experiment-provider';
