import { describe, expect, it } from 'vitest';
import { resolveLocalPlaybook } from './customer-side';
import type { ConfigArtifact } from './customer-side';

/**
 * `localRuntime.playbook` is the only key that carries the local Playbook.
 * Resolution lives in one place (`resolveLocalPlaybook`) so every consumer
 * agrees, so that is what these pin.
 */
const PLAYBOOK = { version: 'p' } as unknown as ConfigArtifact;

describe('local runtime Playbook resolution', () => {
  it('accepts the playbook key', () => {
    expect(resolveLocalPlaybook({ playbook: PLAYBOOK })).toBe(PLAYBOOK);
  });

  it('returns undefined when it is not supplied', () => {
    expect(resolveLocalPlaybook({})).toBeUndefined();
    expect(resolveLocalPlaybook(undefined)).toBeUndefined();
    expect(resolveLocalPlaybook(null)).toBeUndefined();
  });

  it('does not treat an explicitly undefined playbook as a value', () => {
    expect(resolveLocalPlaybook({ playbook: undefined })).toBeUndefined();
  });
});
