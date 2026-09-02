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
