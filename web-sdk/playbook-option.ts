/**
 * The `ExportedConfig`-era option/method spellings removed in 0.13.0 (ST-1418).
 *
 * The alias-resolution machinery that used to live here is gone: the SDK reads
 * only `playbook` / `getPlaybook()` / `resolvePlaybook`. This module keeps the
 * list of removed names so the removal tests share one definition.
 *
 * @internal — not part of the public SDK surface.
 */

/** The release that removed every `ExportedConfig`-spelled alias. */
export const PLAYBOOK_ALIAS_REMOVAL_VERSION = '0.13.0';

/** Identifiers that must not reappear in the public option surfaces. */
export const REMOVED_ALIAS_NAMES = [
  'exportedConfig',
  'getExportedConfig',
  'resolveExportedConfig',
  'exportedConfigVersion',
  'ExportedConfigProvider',
] as const;
