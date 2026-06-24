import type { PlacementUiPath } from '../../placements/types';

/**
 * Produce a short, human-readable label for a resolved CTA action.
 *
 * The skeleton uses this to surface CTA clicks in the activity log so the
 * engine round-trip is observable. TASK-4 replaces the call sites with the
 * full checkout / add-on / billing-switch dispatch; this stays as the
 * label helper.
 */
export function describeCta(uiPath: PlacementUiPath): string {
  const type = typeof uiPath.type === 'string' ? uiPath.type : 'cta';
  const planHandle =
    'plan_handle' in uiPath && typeof uiPath.plan_handle === 'string' ? uiPath.plan_handle : undefined;
  return planHandle ? `${type} → ${planHandle}` : type;
}
