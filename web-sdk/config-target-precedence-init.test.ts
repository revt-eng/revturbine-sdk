/**
 * Plan 233 TASK-1, AC-1 + AC-2 at the level the acceptance criteria actually name.
 *
 * `config-artifact.test.ts` pins the parser. That is necessary but it is not the
 * claim: the escalated defect was not "normalization returns the wrong object",
 * it was "the SDK never started and nothing said so". Asserting only the parser
 * while claiming the SDK now starts would repeat the exact mistake this plan
 * exists to fix — a test that asserts the write and never the read.
 *
 * So these drive `initRevTurbine` and read back through the public probe surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initRevTurbine, RuntimeMode } from './customer-side';
import type { ConfigArtifact } from './customer-side';

/** A canonical Playbook with NO `tenant_id` — the shape the host serves after
 *  destructuring the tenant out to pass it as an init option. */
const CANONICAL_WITHOUT_TENANT = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  playbook_handle: 'default',
  playbook_version_id: null,
  plans: [],
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
} as unknown as ConfigArtifact;

const CANONICAL_WITH_TENANT = {
  ...(CANONICAL_WITHOUT_TENANT as unknown as Record<string, unknown>),
  tenant_id: 't_1',
  environment_id: 'production',
} as unknown as ConfigArtifact;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AC-1 — a canonical Playbook with no tenant_id starts the SDK', () => {
  it('initializes and getPolicy().runtimeMode is readable', () => {
    const sdk = initRevTurbine({
      tenantId: 't_1',
      runtimeMode: RuntimeMode.LocalOnly,
      localRuntime: { playbook: CANONICAL_WITHOUT_TENANT },
    } as never);

    // Before plan 233 this line was never reached: initRevTurbine threw
    // `missing non-empty string "tenant_id"` inside normalization.
    expect(sdk.getPolicy().runtimeMode).toBe(RuntimeMode.LocalOnly);
  });

  it('emits no console.error while initializing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    initRevTurbine({
      tenantId: 't_1',
      runtimeMode: RuntimeMode.LocalOnly,
      localRuntime: { playbook: CANONICAL_WITHOUT_TENANT },
    } as never);

    expect(error).not.toHaveBeenCalled();
  });

  it('serves the init tenant through the resolved config', () => {
    const sdk = initRevTurbine({
      tenantId: 't_1',
      runtimeMode: RuntimeMode.LocalOnly,
      localRuntime: { playbook: CANONICAL_WITHOUT_TENANT },
    } as never);

    expect(sdk.getExportedConfig()).toMatchObject({ tenant_id: 't_1' });
  });
});

describe('AC-2 — a tenant mismatch warns and resolves to the init option', () => {
  it('resolves the running config against the init tenant, not the artifact', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const sdk = initRevTurbine({
      tenantId: 't_2',
      runtimeMode: RuntimeMode.LocalOnly,
      localRuntime: { playbook: CANONICAL_WITH_TENANT },
    } as never);

    // The artifact declares t_1; the host asked for t_2. Decisions must resolve
    // against t_2 — the init option is the authority.
    expect(sdk.getExportedConfig()).toMatchObject({ tenant_id: 't_2' });
  });

  it('warns once, naming both values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    initRevTurbine({
      tenantId: 't_2',
      runtimeMode: RuntimeMode.LocalOnly,
      localRuntime: { playbook: CANONICAL_WITH_TENANT },
    } as never);

    const messages = warn.mock.calls.map((call) => String(call[0]));
    const mismatch = messages.filter((m) => m.includes('tenant_id'));
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toContain('t_1');
    expect(mismatch[0]).toContain('t_2');
  });

  it('does not fail init on a mismatch', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => initRevTurbine({
      tenantId: 't_2',
      runtimeMode: RuntimeMode.LocalOnly,
      localRuntime: { playbook: CANONICAL_WITH_TENANT },
    } as never)).not.toThrow();

    expect(error).not.toHaveBeenCalled();
  });
});
