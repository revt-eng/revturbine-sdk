import type { ExportedConfig } from '@revt-eng/schema';
import type { RevTurbineTrialContext, RevTurbineUserContext } from '../../index';
import type { DemoState } from './demo-state';
import { creditAllowanceFor, generationsLimitFor, planName } from './derived';

/**
 * Map the playground {@link DemoState} into the SDK `UserContext` the
 * local-runtime engine evaluates against the bundled Prism config.
 *
 * - `plan.id` carries the plan **handle** (the engine matches it to a config
 *   plan whose id appears in a rule/payload target).
 * - `usage[handle]` carries live amounts so the meter, credit counter, and
 *   usage/credit thresholds track the Director controls. Limits are derived
 *   from the config rules (never hardcoded).
 * - `custom` carries the segmentation attributes the Prism config's segment
 *   predicates read (see {@link DemoState.custom}).
 */
export function toUserContext(config: ExportedConfig, state: DemoState): RevTurbineUserContext {
  const generationsLimit = generationsLimitFor(config, state.planHandle);
  const creditLimit = creditAllowanceFor(config, state.planHandle);

  return {
    id: state.userId,
    plan: { id: state.planHandle, name: planName(config, state.planHandle) },
    usage: {
      generations: {
        entitlement_handle: 'generations',
        unit: 'images',
        amount: state.generationsUsed,
        limit: generationsLimit,
      },
      credits: {
        entitlement_handle: 'credits',
        unit: 'credits',
        amount: Math.max(0, creditLimit - state.creditBalance),
        limit: creditLimit,
      },
    },
    custom: { ...state.custom },
  };
}

/** Derive the runtime trial status the SDK's `getTrialStatus` resolver returns. */
export function toTrialStatus(state: DemoState): RevTurbineTrialContext {
  return {
    in_trial: state.trial.inTrial,
    trial_type: state.trial.trialType ?? undefined,
    day_number: state.trial.dayNumber,
    days_remaining: state.trial.daysRemaining,
    plan_handle: state.planHandle,
  };
}
