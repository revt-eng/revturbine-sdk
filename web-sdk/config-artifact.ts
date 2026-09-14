import {
  type Playbook,
  type RevTurbineConfig,
} from '@revt-eng/schema';
import { isDevelopmentBuild } from './build-mode';

const PLAYBOOK_FORMAT_VERSION = '1.0.0';
const REQUIRED_BODY_ARRAY_FIELDS = [
  'plans',
  'entitlements',
  'entitlement_rules',
  'segments',
  'content_ui_paths',
] as const;
const LEGACY_PROJECTION_FIELDS = ['slot_configs', 'content_overrides'] as const;

/** A canonical Playbook or the deprecated RevTurbineConfig wire shape. */
export type ConfigArtifact = Playbook | RevTurbineConfig;

/**
 * A config artifact as raw parsed JSON — what
 * `import playbook from './revturbine.playbook.json'` produces.
 *
 * This exists because TypeScript widens JSON modules to plain `string`/`number`
 * property types, which can never satisfy the literal-typed
 * {@link ConfigArtifact} (`artifact_type: "playbook"` etc.), so a strict-mode
 * project could not pass the imported JSON without a cast.
 *
 * Widening affects only *literal* types, so it is no reason to give up on the
 * rest of the shape. The body arrays are structurally required here, which
 * makes a truncated artifact a **compile** error at the `localRuntime`
 * boundary rather than a runtime one — the whole point of plan 233. The header
 * fields stay unconstrained because those are exactly the widened ones.
 *
 * The required-field list is *derived* from {@link REQUIRED_BODY_ARRAY_FIELDS},
 * the same constant {@link normalizeConfigArtifactOrThrow} validates against at
 * runtime, so the compile-time and runtime contracts cannot drift apart.
 *
 * The index signature keeps every other field open: a Playbook carries many
 * optional header fields, and a *fetched* artifact (`await res.json()`, typed
 * `any`) still satisfies this, so the served path is not made harder to write —
 * only harder to get silently wrong. Values are still validated at runtime by
 * {@link normalizeConfigArtifactOrThrow}, which fails fast with a descriptive
 * error; this type constrains the *shape*, never the values.
 */
export type UnvalidatedConfigArtifact =
  & { [K in (typeof REQUIRED_BODY_ARRAY_FIELDS)[number]]: unknown[] } // sdk-ok: type-definition
  & { [key: string]: unknown }; // sdk-ok: type-definition

/**
 * The target (tenant + environment) the SDK was initialized against.
 *
 * These are the **authority** on which tenant a runtime decides for. An
 * artifact's own `tenant_id` / `environment_id` are a *guard*: they exist so the
 * CLI can refuse to upload a config to the wrong tenant while setting up demo
 * environments, and they are not a runtime input (plan 233 REQ-2, Kent 2026-09-10).
 *
 * A disagreement between the two warns and proceeds on these values — it never
 * fails init. See {@link normalizeConfigArtifactOrThrow}.
 *
 * @public
 */
export interface ConfigTargetDefaults {
  /** Tenant the SDK was initialized with. Wins over the artifact's `tenant_id`. */
  tenantId: string;
  /** Environment the SDK was initialized with. Wins over the artifact's `environment_id`. */
  environmentId: string;
}

/**
 * @deprecated Renamed to {@link ConfigTargetDefaults} in plan 233 — these values
 * are no longer "legacy defaults" applied only to pre-stamping artifacts; they
 * are the authoritative target for every artifact shape. Kept as an alias so the
 * already-shipped export keeps resolving.
 * @public
 */
export type LegacyConfigTargetDefaults = ConfigTargetDefaults;

function isRecord(value: unknown): value is Record<string, unknown> { // sdk-ok: boundary-parse
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warnForLegacyProjections(value: Record<string, unknown>, source: string): void { // sdk-ok: boundary-parse
  if (!isDevelopmentBuild()) return;

  const present = LEGACY_PROJECTION_FIELDS.filter((field) => field in value);
  if (present.length === 0) return;

  console.warn(
    `[RevTurbine] ${source} uses deprecated Playbook projection(s): ${present.join(', ')}. ` +
      'Move activation/triggers to local runtime state and content to Message Blocks/Placement Payloads.',
  );
}

function requireBodyArrays(value: Record<string, unknown>, source: string): void { // sdk-ok: boundary-parse
  for (const key of REQUIRED_BODY_ARRAY_FIELDS) {
    if (!Array.isArray(value[key])) {
      throw new Error(`Invalid ${source}: missing array "${key}"`);
    }
  }
}

function isPlaybook(value: Record<string, unknown>): value is Playbook { // sdk-ok: boundary-parse
  return value.artifact_type === 'playbook'
    && value.format_version === PLAYBOOK_FORMAT_VERSION
    && typeof value.playbook_handle === 'string'
    && value.playbook_handle.length > 0
    && (value.playbook_version_id === null || typeof value.playbook_version_id === 'string')
    && typeof value.tenant_id === 'string'
    && value.tenant_id.length > 0
    && typeof value.environment_id === 'string'
    && value.environment_id.length > 0
    && REQUIRED_BODY_ARRAY_FIELDS.every((key) => Array.isArray(value[key]));
}

function optionalHeaderFieldsAreValid(value: Record<string, unknown>): boolean { // sdk-ok: boundary-parse
  return (value.project_id === undefined
      || (typeof value.project_id === 'string' && value.project_id.length > 0))
    && (value.exported_at === undefined || typeof value.exported_at === 'string')
    && (value.schema_version === undefined
      || (typeof value.schema_version === 'string' && value.schema_version.length > 0))
    && (value.bundle_schema_version === undefined
      || (Number.isInteger(value.bundle_schema_version) && Number(value.bundle_schema_version) >= 0));
}

/**
 * Resolve one target field, with the init option as the authority.
 *
 * Plan 233 REQ-2. The previous rule was the inverse — the artifact won, and the
 * init option was a fallback applied only to legacy artifacts
 * (`canonical ? undefined : legacyTargetDefaults?.tenantId`). That combination
 * killed every integration that served a canonical Playbook and passed the
 * tenant at init: the artifact had no `tenant_id` to win with, and the option
 * was withheld because the artifact was canonical, so init threw. The provider
 * logged it and rendered children anyway, so the SDK simply never started.
 *
 * The artifact's value is now a *guard*, not an input: when the two disagree we
 * warn (naming both, so the mismatch is actionable) and proceed on the init
 * option. A mismatch never fails init — a config uploaded to the wrong tenant is
 * a CLI-time concern, and refusing to start is a worse outcome at runtime than
 * deciding against the tenant the host explicitly asked for.
 */
function resolveTarget(
  artifactValue: unknown, // sdk-ok: boundary-parse
  initValue: string | undefined,
  field: 'tenant_id' | 'environment_id',
  source: string,
): string | undefined {
  const fromArtifact = typeof artifactValue === 'string' && artifactValue.length > 0
    ? artifactValue
    : undefined;

  // `environment_id` is deliberately NOT inverted. Callers route it through
  // `normalizeEnvironmentId`, which substitutes 'production' whenever the host
  // omitted it — so by the time it reaches here an explicit environment and a
  // defaulted one are indistinguishable, and treating it as authoritative would
  // silently rewrite a Playbook stamped `staging` to `production` for every
  // integration that never passed one. It stays a fallback, which is what
  // `normalizeEnvironmentId` documents it as ("used to normalize an unstamped
  // legacy Playbook"). Warning on an environment mismatch needs the caller to
  // carry explicitness down; that is tracked separately, not assumed here.
  if (field === 'environment_id') return fromArtifact ?? initValue;

  if (initValue && fromArtifact && initValue !== fromArtifact) {
    console.warn(
      `[RevTurbine] ${source} declares ${field} "${fromArtifact}" but the SDK was initialized with `
        + `"${initValue}". Using "${initValue}" — the init option is the authority; the Playbook's `
        + `${field} is a guard against loading another tenant's config. Re-export the Playbook for `
        + `"${initValue}", or correct the value passed at init.`,
    );
  }

  return initValue ?? fromArtifact;
}

/**
 * Parse either supported wire shape into the canonical Playbook shape.
 *
 * Presence of either canonical discriminator selects the canonical parser, so
 * an unsupported future `format_version` can never fall back to legacy.
 */
export function normalizeConfigArtifactOrThrow(
  raw: unknown, // sdk-ok: boundary-parse
  source: string,
  targetDefaults?: ConfigTargetDefaults,
): Playbook | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new Error(`Invalid ${source}: expected top-level object`);
  }

  warnForLegacyProjections(raw, source);
  requireBodyArrays(raw, source);
  const canonical = 'artifact_type' in raw || 'format_version' in raw;
  if (canonical && raw.artifact_type !== 'playbook') {
    throw new Error(`Invalid ${source}: unsupported "artifact_type"`);
  }
  if (canonical && raw.format_version !== PLAYBOOK_FORMAT_VERSION) {
    throw new Error(`Invalid ${source}: unsupported "format_version" ${String(raw.format_version)}`);
  }
  if (!canonical && raw.version !== PLAYBOOK_FORMAT_VERSION) {
    throw new Error(`Invalid ${source}: unsupported legacy "version" ${String(raw.version)}`);
  }

  const tenantId = resolveTarget(raw.tenant_id, targetDefaults?.tenantId, 'tenant_id', source);
  const environmentId = resolveTarget(
    raw.environment_id,
    targetDefaults?.environmentId,
    'environment_id',
    source,
  );
  if (!tenantId) {
    throw new Error(
      `Invalid ${source}: missing non-empty string "tenant_id", and no "tenantId" was passed to the SDK. `
        + 'Pass tenantId in the init options, or stamp tenant_id into the Playbook.',
    );
  }
  if (!environmentId) {
    throw new Error(
      `Invalid ${source}: missing non-empty string "environment_id", and no "environmentId" was passed to the SDK. `
        + 'Pass environmentId in the init options, or stamp environment_id into the Playbook.',
    );
  }
  if (raw.playbook_handle !== undefined
    && (typeof raw.playbook_handle !== 'string' || raw.playbook_handle.length === 0)) {
    throw new Error(`Invalid ${source}: malformed "playbook_handle"`);
  }
  if (!optionalHeaderFieldsAreValid(raw)) {
    throw new Error(`Invalid ${source}: malformed optional Playbook header field`);
  }

  const {
    version: _legacyVersion,
    change_set_id: legacyPlaybookVersionId,
    ...withoutLegacyHeader
  } = raw;
  const playbookVersionId = canonical
    ? raw.playbook_version_id ?? null
    : legacyPlaybookVersionId ?? null;
  const normalized = {
    ...withoutLegacyHeader,
    artifact_type: 'playbook',
    format_version: PLAYBOOK_FORMAT_VERSION,
    playbook_handle: raw.playbook_handle ?? 'default',
    playbook_version_id: playbookVersionId,
    tenant_id: tenantId,
    environment_id: environmentId,
  };
  if (!isPlaybook(normalized)) {
    throw new Error(`Invalid ${source}: malformed Playbook header`);
  }
  return normalized;
}

/**
 * Normalize a raw config artifact to the canonical Playbook the runtime
 * evaluator consumes.
 *
 * @internal SDK runtime plumbing only. Plan 147 flattened the config schema, so
 * the evaluator consumes the canonical Playbook directly — the former
 * legacy-typed seam that re-emitted `version` / `change_set_id` is retired
 * (callers now read `format_version` / `playbook_version_id`).
 */
export function configArtifactForRuntime(
  raw: unknown, // sdk-ok: boundary-parse
  source: string,
  targetDefaults?: ConfigTargetDefaults,
): RevTurbineConfig | undefined {
  return normalizeConfigArtifactOrThrow(raw, source, targetDefaults);
}
