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
 * TypeScript widens JSON modules to plain `string`/`number` property types,
 * which can never satisfy the literal-typed {@link ConfigArtifact}
 * (`artifact_type: "playbook"` etc.), so a strict-mode project could not pass
 * the imported JSON without a cast. The SDK therefore accepts this raw shape
 * everywhere a {@link ConfigArtifact} is accepted at the `localRuntime`
 * boundary and validates it at runtime ({@link normalizeConfigArtifactOrThrow}
 * — a malformed artifact fails fast at init with a descriptive error).
 */
export type UnvalidatedConfigArtifact = Record<string, unknown>; // sdk-ok: type-definition

/** Target values used only when an older legacy artifact predates target stamping. */
export interface LegacyConfigTargetDefaults {
  tenantId: string;
  environmentId: string;
}

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
 * Parse either supported wire shape into the canonical Playbook shape.
 *
 * Presence of either canonical discriminator selects the canonical parser, so
 * an unsupported future `format_version` can never fall back to legacy.
 */
export function normalizeConfigArtifactOrThrow(
  raw: unknown, // sdk-ok: boundary-parse
  source: string,
  legacyTargetDefaults?: LegacyConfigTargetDefaults,
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

  const tenantId = typeof raw.tenant_id === 'string' && raw.tenant_id.length > 0
    ? raw.tenant_id
    : canonical ? undefined : legacyTargetDefaults?.tenantId;
  const environmentId = typeof raw.environment_id === 'string' && raw.environment_id.length > 0
    ? raw.environment_id
    : canonical ? undefined : legacyTargetDefaults?.environmentId;
  if (!tenantId) throw new Error(`Invalid ${source}: missing non-empty string "tenant_id"`);
  if (!environmentId) throw new Error(`Invalid ${source}: missing non-empty string "environment_id"`);
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
  legacyTargetDefaults?: LegacyConfigTargetDefaults,
): RevTurbineConfig | undefined {
  return normalizeConfigArtifactOrThrow(raw, source, legacyTargetDefaults);
}
