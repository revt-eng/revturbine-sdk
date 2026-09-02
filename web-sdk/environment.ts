/** The canonical environment used when an integration omits its environment. @internal */
export const PRODUCTION_ENVIRONMENT_ID = 'production';

/**
 * Resolve an SDK environment identifier before it is stamped on events or used
 * to normalize an unstamped legacy Playbook.
 *
 * @internal
 */
export function normalizeEnvironmentId(environmentId?: string): string {
  return environmentId?.trim() || PRODUCTION_ENVIRONMENT_ID;
}
