import { describe, expect, it } from 'vitest';
import { resolveLocalPlaybook } from './customer-side';
import type { ConfigArtifact } from './customer-side';

/**
 * `localRuntime.playbook` is the canonical key; `localRuntime.exportedConfig` is
 * the legacy alias and must keep working indefinitely. Precedence lives in one
 * place (`resolveLocalPlaybook`) precisely so every consumer agrees, so that is
 * what these pin.
 */
const PLAYBOOK = { version: 'p' } as unknown as ConfigArtifact;
const LEGACY = { version: 'l' } as unknown as ConfigArtifact;

describe('local runtime Playbook resolution', () => {
  it('accepts the canonical playbook key', () => {
    expect(resolveLocalPlaybook({ playbook: PLAYBOOK })).toBe(PLAYBOOK);
  });

  it('still accepts the legacy exportedConfig key', () => {
    expect(resolveLocalPlaybook({ exportedConfig: LEGACY })).toBe(LEGACY);
  });

  it('prefers playbook when both are supplied', () => {
    expect(resolveLocalPlaybook({ playbook: PLAYBOOK, exportedConfig: LEGACY })).toBe(PLAYBOOK);
  });

  it('returns undefined when neither is supplied', () => {
    expect(resolveLocalPlaybook({})).toBeUndefined();
    expect(resolveLocalPlaybook(undefined)).toBeUndefined();
    expect(resolveLocalPlaybook(null)).toBeUndefined();
  });

  it('does not treat an explicitly undefined playbook as a value', () => {
    // `?? ` not `||` — a caller spreading `{ playbook: undefined }` must still
    // fall through to the legacy key rather than resolving to undefined.
    expect(resolveLocalPlaybook({ playbook: undefined, exportedConfig: LEGACY })).toBe(LEGACY);
  });
});
