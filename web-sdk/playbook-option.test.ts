/**
 * ST-1418: the `ExportedConfig`-spelled aliases were removed in 0.13.0.
 *
 * This file used to pin the alias machinery (precedence, one-time warning).
 * It now pins the removal: only the canonical `playbook` / `getPlaybook()`
 * spellings are read, and an old spelling is ignored rather than honoured.
 */
import { describe, expect, it } from 'vitest';
import { PLAYBOOK_ALIAS_REMOVAL_VERSION, REMOVED_ALIAS_NAMES } from './playbook-option';
import { resolveLocalPlaybook, resolveProviderPlaybook, resolvePlaybookResolver } from './customer-side';
import type { ConfigArtifact } from './customer-side';

const PLAYBOOK = { version: 'p' } as unknown as ConfigArtifact;
const OLD = { version: 'old' } as unknown as ConfigArtifact;

describe('removed ExportedConfig-era aliases (0.13.0)', () => {
  it('names the removal release and the removed spellings', () => {
    expect(PLAYBOOK_ALIAS_REMOVAL_VERSION).toBe('0.13.0');
    expect(REMOVED_ALIAS_NAMES).toContain('getExportedConfig');
  });

  it('localRuntime.exportedConfig is no longer read', () => {
    const legacy = { exportedConfig: OLD } as unknown as Parameters<typeof resolveLocalPlaybook>[0];
    expect(resolveLocalPlaybook(legacy)).toBeUndefined();
    expect(resolveLocalPlaybook({ playbook: PLAYBOOK })).toBe(PLAYBOOK);
  });

  it('resolvers.resolveExportedConfig is no longer read', () => {
    const legacy = { resolveExportedConfig: () => OLD } as unknown as Parameters<typeof resolvePlaybookResolver>[0];
    expect(resolvePlaybookResolver(legacy)).toBeUndefined();
    const canonical = () => PLAYBOOK;
    expect(resolvePlaybookResolver({ resolvePlaybook: canonical })).toBe(canonical);
  });

  it('a provider implementing only getExportedConfig is rejected', () => {
    const legacy = { getExportedConfig: () => OLD } as unknown as Parameters<typeof resolveProviderPlaybook>[0];
    expect(() => resolveProviderPlaybook(legacy)).toThrow(/must implement .getPlaybook\(\)./);
    expect(resolveProviderPlaybook({ getPlaybook: () => PLAYBOOK })).toBe(PLAYBOOK);
  });
});
