import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configArtifactForRuntime,
  normalizeConfigArtifactOrThrow,
} from './config-artifact';

const BODY = {
  plans: [],
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
};

describe('config artifact dual-read normalization', () => {
  it('warns once when accepting a legacy unversioned Playbook', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { normalizeConfigArtifactOrThrow: normalize } = await import('./config-artifact');
    const input = { ...BODY, version: '1.0.0', tenant_id: 't', environment_id: 'e' };
    normalize(input, 'fixture');
    normalize(input, 'fixture');
    expect(warn.mock.calls.filter(([message]) => String(message).includes('no bundle_schema_version'))).toHaveLength(1);
  });
  it.each([15, 16, 18])('admits historical/current writer %s through the actual normalizer', (version) => {
    expect(normalizeConfigArtifactOrThrow({
      ...BODY, version: '1.0.0', tenant_id: 't', environment_id: 'e', bundle_schema_version: version,
    }, 'fixture')?.bundle_schema_version).toBe(version);
  });

  it.each([10, 999, '18', null])('refuses incompatible or malformed writer %s before projection', (version) => {
    expect(() => normalizeConfigArtifactOrThrow({
      ...BODY, version: '1.0.0', tenant_id: 't', environment_id: 'e', bundle_schema_version: version,
    }, 'fixture')).toThrow();
  });

  it.each([undefined, 18])('refuses mandatory extensions with writer %s', (version) => {
    expect(() => normalizeConfigArtifactOrThrow({
      ...BODY, version: '1.0.0', tenant_id: 't', environment_id: 'e',
      ...(version === undefined ? {} : { bundle_schema_version: version }),
      extension_rules: [{ kind: 'geo.v1', must_understand: true }],
    }, 'fixture')).toThrow('unsupported mandatory extension');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('normalizes the known legacy header without re-emitting legacy keys', () => {
    const normalized = normalizeConfigArtifactOrThrow({
      version: '1.0.0',
      change_set_id: 'pbv_legacy',
      ...BODY,
    }, 'fixture', {
      tenantId: 'tenant_sdk',
      environmentId: 'production',
    });

    expect(normalized).toMatchObject({
      artifact_type: 'playbook',
      format_version: '1.0.0',
      playbook_handle: 'default',
      playbook_version_id: 'pbv_legacy',
      tenant_id: 'tenant_sdk',
      environment_id: 'production',
    });
    expect(normalized && 'version' in normalized).toBe(false);
    expect(normalized && 'change_set_id' in normalized).toBe(false);
  });

  it('preserves a canonical Playbook header', () => {
    const normalized = normalizeConfigArtifactOrThrow({
      artifact_type: 'playbook',
      format_version: '1.0.0',
      playbook_handle: 'growth',
      playbook_version_id: null,
      tenant_id: 'tenant_sdk',
      environment_id: 'production',
      project_id: 'project_sdk',
      experiments: [],
      ...BODY,
    }, 'fixture');

    expect(normalized).toMatchObject({
      artifact_type: 'playbook',
      format_version: '1.0.0',
      playbook_handle: 'growth',
      playbook_version_id: null,
      project_id: 'project_sdk',
      experiments: [],
    });
  });

  it('rejects future canonical versions without legacy fallback', () => {
    expect(() => normalizeConfigArtifactOrThrow({
      artifact_type: 'playbook',
      format_version: '2.0.0',
      version: '1.0.0',
      playbook_handle: 'default',
      playbook_version_id: null,
      tenant_id: 'tenant_sdk',
      environment_id: 'production',
      ...BODY,
    }, 'fixture')).toThrow('Invalid fixture');
  });

  it('returns the canonical Playbook for the runtime evaluator (no legacy header re-emit)', () => {
    // Plan 147 flattened the config schema: the evaluator consumes the canonical
    // Playbook directly, so the former legacy-typed seam (which re-emitted
    // `version` / `change_set_id`) is retired — callers read `format_version` /
    // `playbook_version_id`.
    const runtime = configArtifactForRuntime({
      artifact_type: 'playbook',
      format_version: '1.0.0',
      playbook_handle: 'default',
      playbook_version_id: 'pbv_123',
      tenant_id: 'tenant_sdk',
      environment_id: 'production',
      ...BODY,
    }, 'fixture');

    expect(runtime).toMatchObject({
      format_version: '1.0.0',
      playbook_version_id: 'pbv_123',
    });
    expect(runtime).not.toHaveProperty('version');
    expect(runtime).not.toHaveProperty('change_set_id');
  });

  it('warns in development when legacy projections are normalized', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    normalizeConfigArtifactOrThrow({
      version: '1.0.0',
      slot_configs: [],
      content_overrides: {},
      ...BODY,
    }, 'legacy fixture', {
      tenantId: 'tenant_sdk',
      environmentId: 'production',
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('slot_configs, content_overrides'));
  });

  it('suppresses legacy projection warnings in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    normalizeConfigArtifactOrThrow({
      version: '1.0.0',
      slot_configs: [],
      ...BODY,
    }, 'legacy fixture', {
      tenantId: 'tenant_sdk',
      environmentId: 'production',
    });

    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * Plan 233 TASK-1 — the init option is the authority; the artifact's target is a guard.
 *
 * Every pre-existing canonical fixture in this file carries `tenant_id`, which is
 * precisely why the escalated defect shipped: the branch that rejects a canonical
 * artifact WITHOUT one was never exercised. These cases cover that shape.
 */
describe('target precedence — init option is the authority (plan 233 REQ-2)', () => {
  const CANONICAL = {
    artifact_type: 'playbook',
    format_version: '1.0.0',
    playbook_handle: 'default',
    playbook_version_id: null,
    ...BODY,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('AC-1: a canonical Playbook with no tenant_id initializes from the init options', () => {
    // The escalated defect verbatim: the host destructured tenant_id out of the
    // served body and passed it as the tenantId option. Before plan 233 this threw
    // `missing non-empty string "tenant_id"` and the SDK never started.
    const normalized = normalizeConfigArtifactOrThrow(CANONICAL, 'localRuntime.playbook', {
      tenantId: 't_1',
      environmentId: 'production',
    });

    expect(normalized).toMatchObject({ tenant_id: 't_1', environment_id: 'production' });
  });

  it('AC-1: no warning is emitted when only the init option supplies the target', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    normalizeConfigArtifactOrThrow(CANONICAL, 'localRuntime.playbook', {
      tenantId: 't_1',
      environmentId: 'production',
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it('AC-2: a mismatch resolves to the init option and warns, naming both values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const normalized = normalizeConfigArtifactOrThrow(
      { ...CANONICAL, tenant_id: 't_1', environment_id: 'production' },
      'localRuntime.playbook',
      { tenantId: 't_2', environmentId: 'production' },
    );

    // Init option wins — the Playbook's tenant_id is a guard, not a runtime input.
    expect(normalized?.tenant_id).toBe('t_2');

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('t_1');
    expect(message).toContain('t_2');
    expect(message).toContain('tenant_id');
  });

  it('AC-2: a mismatch never throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => normalizeConfigArtifactOrThrow(
      { ...CANONICAL, tenant_id: 't_1', environment_id: 'staging' },
      'localRuntime.playbook',
      { tenantId: 't_2', environmentId: 'production' },
    )).not.toThrow();
  });

  it('does NOT let a defaulted environmentId overwrite a stamped one', () => {
    // `normalizeEnvironmentId` substitutes 'production' whenever the host omitted
    // an environment, so at this layer an explicit environment and a defaulted one
    // look identical. Inverting environment precedence the way tenant is inverted
    // would silently rewrite every `staging` Playbook to `production` — caught by
    // browser-runtime.test.ts's "preserves an explicit legacy environment".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const normalized = normalizeConfigArtifactOrThrow(
      { ...CANONICAL, tenant_id: 't_1', environment_id: 'staging' },
      'localRuntime.playbook',
      { tenantId: 't_1', environmentId: 'production' },
    );

    expect(normalized?.environment_id).toBe('staging');
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses the init environmentId only when the artifact stamps none', () => {
    const normalized = normalizeConfigArtifactOrThrow(
      { ...CANONICAL, tenant_id: 't_1' },
      'localRuntime.playbook',
      { tenantId: 't_1', environmentId: 'staging' },
    );

    expect(normalized?.environment_id).toBe('staging');
  });

  it('falls back to the artifact when no init target is supplied', () => {
    const normalized = normalizeConfigArtifactOrThrow(
      { ...CANONICAL, tenant_id: 't_1', environment_id: 'production' },
      'localRuntime.playbook',
    );

    expect(normalized).toMatchObject({ tenant_id: 't_1', environment_id: 'production' });
  });

  it('still throws — naming the fix — when neither source supplies a target', () => {
    expect(() => normalizeConfigArtifactOrThrow(CANONICAL, 'localRuntime.playbook'))
      .toThrow(/missing non-empty string "tenant_id".*tenantId/s);
  });

  it('applies the same precedence to a legacy artifact', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const normalized = normalizeConfigArtifactOrThrow(
      { version: '1.0.0', tenant_id: 't_legacy', environment_id: 'production', ...BODY },
      'fixture',
      { tenantId: 't_init', environmentId: 'production' },
    );

    expect(normalized?.tenant_id).toBe('t_init');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
