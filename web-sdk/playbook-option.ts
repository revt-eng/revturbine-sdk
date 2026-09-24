/**
 * The `ExportedConfig` → `Playbook` option-alias machinery for the SDK (BL-0156).
 *
 * `ExportedConfig` is dead vocabulary. Plan 118 renamed the domain object to
 * **Playbook** and plan 104 renamed the schema type to `RevTurbineConfig`, but
 * the *option*, *parameter* and *method* names that carry a Playbook around the
 * SDK still spelled it `exportedConfig`. Scaffold went first (`@revt-eng/core`
 * 0.1.330, `src/core/playbook-option.ts`); this module is its `web-sdk`
 * counterpart, and deliberately mirrors it.
 *
 * Two rules it exists to enforce:
 *
 * 1. **One resolver per read site.** Every reader of either spelling goes
 *    through a function here, so precedence cannot drift between call sites.
 *    This is the property that made plan 257's `publicKey` rename — and
 *    BL-0113's removal of its aliases one minor later — a three-line change
 *    rather than an audit.
 * 2. **One warning per runtime, not one per alias.** An integration still
 *    spelling three of these gets a single console line naming the first it
 *    hit, not a wall.
 *
 * Unlike scaffold's copy, the warning here IS gated on a development build:
 * `web-sdk` can read `NODE_ENV` through `build-mode.ts`, where core cannot
 * (its ESLint config forbids the `process` global so core runs unchanged on
 * edge runtimes).
 *
 * @internal — not part of the public SDK surface.
 */
import { devWarn as warnInDevelopmentBuild } from './build-mode';

/** The minor that removes every `ExportedConfig`-spelled alias. */
export const PLAYBOOK_ALIAS_REMOVAL_VERSION = '0.12.0';

let warned = false;

/**
 * Emit the one-time development warning for an `ExportedConfig`-spelled alias.
 *
 * The message always names the canonical replacement, and production builds
 * stay silent.
 *
 * @internal
 */
export function warnDeprecatedPlaybookAliasOnce(message: string): void {
  if (warned) return;
  warned = true;
  warnInDevelopmentBuild(`${message} Removed in ${PLAYBOOK_ALIAS_REMOVAL_VERSION}.`);
}

/**
 * Resolve a `{ playbook?, exportedConfig? }` pair to whichever was supplied.
 *
 * `playbook` is canonical and wins when both are present; reading the alias
 * warns once. Returns `undefined` when neither was supplied, so each caller
 * decides whether that is an error.
 *
 * @internal
 */
export function resolvePlaybookOption<T>(
  source: { playbook?: T; exportedConfig?: T } | null | undefined,
  label: string,
): T | undefined {
  if (source?.playbook !== undefined) return source.playbook;
  if (source?.exportedConfig !== undefined) {
    warnDeprecatedPlaybookAliasOnce(
      `\`${label}.exportedConfig\` is deprecated; pass the same Playbook as \`${label}.playbook\`.`,
    );
    return source.exportedConfig;
  }
  return undefined;
}

/**
 * {@link resolvePlaybookOption}, but throws when neither spelling was supplied.
 *
 * For a read site whose option was *required* before the rename, so that
 * omitting both stays an error rather than becoming a silent `undefined`.
 *
 * @internal
 */
export function requirePlaybookOption<T>(
  source: { playbook?: T; exportedConfig?: T } | null | undefined,
  label: string,
): T {
  const resolved = resolvePlaybookOption(source, label);
  if (resolved === undefined) {
    throw new Error(`RevTurbine: \`${label}.playbook\` is required.`);
  }
  return resolved;
}

/** Test-only: forget that the alias warning fired so the next read warns again. @internal */
export function resetPlaybookAliasWarning(): void {
  warned = false;
}
