/**
 * @module @revturbine/sdk/growthbook
 *
 * Optional GrowthBook assignment integration. Importing the base SDK does not
 * include this module or GrowthBook; customers inject their initialized client.
 */

export {
  createGrowthBookExperimentAssignmentProvider,
  GrowthBookAssignmentError,
} from './providers/growthbook-experiment-provider';
export type {
  GrowthBookAssignmentErrorReason,
  GrowthBookExperimentAssignmentOptions,
  GrowthBookExperimentBinding,
} from './providers/growthbook-experiment-provider';
