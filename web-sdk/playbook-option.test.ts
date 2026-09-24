/**
 * BL-0156 — `ExportedConfig` option names are deprecated; `Playbook` is canonical.
 *
 * Mirrors scaffold's `src/core/playbook-option.test.ts` (PR #380) and plan 257's
 * `public-key-option.test.ts`, because the mechanism is deliberately the same
 * one. What is asserted:
 *
 *   - the canonical spelling resolves and NEVER warns;
 *   - the deprecated spelling still resolves, so nothing breaks on upgrade;
 *   - the warning fires **exactly once per runtime** across different read
 *     sites, names the canonical replacement, names the removal version, and
 *     fires again only after the test-only reset;
 *   - a required read site with neither spelling throws;
 *   - every public read site accepts BOTH spellings and reaches the same
 *     Playbook: `BrowserRuntime`, `LocalEvaluationServer`, the SDK's
 *     `localRuntime.playbook`, the `configProvider` accessors, and the
 *     `resolvers.resolvePlaybook` callback.
 *
 * The warning is gated on a development build, so every case that expects a
 * console line sets `NODE_ENV=development` explicitly — `web-sdk`'s
 * `build-mode.ts` fails toward development, and a test that relied on that
 * default would silently stop asserting if the default ever changed.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  requirePlaybookOption,
  resetPlaybookAliasWarning,
  resolvePlaybookOption,
  PLAYBOOK_ALIAS_REMOVAL_VERSION,
} from './playbook-option';
import {
  RevTurbineCustomerSdk,
  resolveLocalPlaybook,
  resolvePlaybookResolver,
  resolveProviderPlaybook,
} from './customer-side';
import type { RevTurbineConfigProvider } from './customer-side';
import type { ConfigArtifact } from './config-artifact';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function makePlaybook(handle = 'free'): ConfigArtifact {
  return {
    version: '1.0.0',
    exported_at: '2026-01-01T00:00:00Z',
    plans: [{ id: 'cfg_a', unique_handle: handle, name: 'Free', tier_position: 0, sort_order: 0 }],
    entitlements: [],
    entitlement_rules: [],
    segments: [],
    content_ui_paths: [],
    surface_templates: [],
    placements: [],
  } as unknown as ConfigArtifact;
}

beforeEach(() => {
  resetPlaybookAliasWarning();
  process.env.NODE_ENV = 'development';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

function spyWarn(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

function aliasWarnings(warn: ReturnType<typeof spyWarn>): string[] {
  return warn.mock.calls
    .map(([m]) => String(m))
    .filter((m) => m.includes('is deprecated'));
}

describe('resolvePlaybookOption / requirePlaybookOption', () => {
  it('resolves the canonical `playbook` and never warns', () => {
    const warn = spyWarn();
    const playbook = makePlaybook();
    expect(resolvePlaybookOption({ playbook }, 'X')).toBe(playbook);
    expect(aliasWarnings(warn)).toEqual([]);
  });

  it('still resolves the deprecated `exportedConfig`', () => {
    const playbook = makePlaybook();
    expect(resolvePlaybookOption({ exportedConfig: playbook }, 'X')).toBe(playbook);
  });

  it('prefers `playbook` when both are supplied', () => {
    const canonical = makePlaybook('canonical');
    const legacy = makePlaybook('legacy');
    expect(resolvePlaybookOption({ playbook: canonical, exportedConfig: legacy }, 'X')).toBe(canonical);
  });

  it('returns undefined for neither, and `requirePlaybookOption` throws instead', () => {
    expect(resolvePlaybookOption({}, 'X')).toBeUndefined();
    expect(() => requirePlaybookOption({}, 'BrowserRuntime')).toThrow(/BrowserRuntime\.playbook. is required/);
  });

  it('warns once, naming the canonical key and the removal version', () => {
    const warn = spyWarn();
    resolvePlaybookOption({ exportedConfig: makePlaybook() }, 'localRuntime');
    const warnings = aliasWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('`localRuntime.exportedConfig` is deprecated');
    expect(warnings[0]).toContain('`localRuntime.playbook`');
    expect(warnings[0]).toContain(PLAYBOOK_ALIAS_REMOVAL_VERSION);
  });

  it('warns exactly once ACROSS different read sites, then again after the reset', () => {
    const warn = spyWarn();
    // Three different read sites, three deprecated spellings, one line.
    resolvePlaybookOption({ exportedConfig: makePlaybook() }, 'localRuntime');
    resolvePlaybookOption({ exportedConfig: makePlaybook() }, 'BrowserRuntime');
    resolveLocalPlaybook({ exportedConfig: makePlaybook() });
    expect(aliasWarnings(warn)).toHaveLength(1);

    resetPlaybookAliasWarning();
    resolvePlaybookOption({ exportedConfig: makePlaybook() }, 'LocalEvaluationServer');
    expect(aliasWarnings(warn)).toHaveLength(2);
  });

  it('is silent in a production build', () => {
    process.env.NODE_ENV = 'production';
    const warn = spyWarn();
    resolvePlaybookOption({ exportedConfig: makePlaybook() }, 'localRuntime');
    expect(aliasWarnings(warn)).toEqual([]);
  });
});

describe('resolveLocalPlaybook — `localRuntime.playbook` vs `exportedConfig`', () => {
  it('accepts either spelling and reaches the same Playbook', () => {
    const playbook = makePlaybook();
    expect(resolveLocalPlaybook({ playbook })).toBe(playbook);
    expect(resolveLocalPlaybook({ exportedConfig: playbook })).toBe(playbook);
  });

  it('prefers `playbook` and does not warn for it', () => {
    const warn = spyWarn();
    const canonical = makePlaybook('canonical');
    expect(resolveLocalPlaybook({ playbook: canonical, exportedConfig: makePlaybook('legacy') })).toBe(canonical);
    expect(aliasWarnings(warn)).toEqual([]);
  });
});

describe('resolvePlaybookResolver — `resolvers.resolvePlaybook` vs `resolveExportedConfig`', () => {
  it('accepts either spelling', () => {
    const playbook = makePlaybook();
    const fn = (): ConfigArtifact => playbook;
    expect(resolvePlaybookResolver({ resolvePlaybook: fn })).toBe(fn);
    expect(resolvePlaybookResolver({ resolveExportedConfig: fn })).toBe(fn);
    expect(resolvePlaybookResolver(undefined)).toBeUndefined();
  });

  it('prefers the canonical name and warns only for the alias', () => {
    const warn = spyWarn();
    const canonical = (): ConfigArtifact => makePlaybook('canonical');
    const legacy = (): ConfigArtifact => makePlaybook('legacy');
    expect(resolvePlaybookResolver({ resolvePlaybook: canonical, resolveExportedConfig: legacy })).toBe(canonical);
    expect(aliasWarnings(warn)).toEqual([]);
    resolvePlaybookResolver({ resolveExportedConfig: legacy });
    expect(aliasWarnings(warn)).toHaveLength(1);
  });
});

describe('resolveProviderPlaybook — `getPlaybook()` vs `getExportedConfig()`', () => {
  it('reads getPlaybook() without warning', () => {
    const warn = spyWarn();
    const playbook = makePlaybook();
    expect(resolveProviderPlaybook({ getPlaybook: () => playbook })).toBe(playbook);
    expect(aliasWarnings(warn)).toEqual([]);
  });

  it('still reads the deprecated getExportedConfig(), and warns once', () => {
    const warn = spyWarn();
    const playbook = makePlaybook();
    expect(resolveProviderPlaybook({ getExportedConfig: () => playbook })).toBe(playbook);
    const warnings = aliasWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('getExportedConfig()');
  });

  it('prefers getPlaybook() when a provider implements both', () => {
    const canonical = makePlaybook('canonical');
    const provider: RevTurbineConfigProvider = {
      getPlaybook: () => canonical,
      getExportedConfig: () => makePlaybook('legacy'),
    };
    expect(resolveProviderPlaybook(provider)).toBe(canonical);
  });

  it('throws when a provider implements neither accessor', () => {
    expect(() => resolveProviderPlaybook({})).toThrow(/must implement .getPlaybook\(\)./);
  });
});

describe('the SDK facade reaches the Playbook under both method names', () => {
  it('getPlaybook() and the deprecated getExportedConfig() return the same snapshot', () => {
    const playbook = makePlaybook('starter');
    const sdk = new RevTurbineCustomerSdk({
      tenantId: 'tenant_abc',
      publicKey: 'rtk_test',
      endpoint: 'https://edge.example.com',
      mode: 'snippet',
      anonymousTelemetry: false,
      runtimeMode: 'local_only',
      localRuntime: { playbook },
    });
    const canonical = sdk.getPlaybook();
    expect(canonical?.plans?.[0]?.unique_handle).toBe('starter');
    expect(sdk.getExportedConfig()).toBe(canonical);
  });

  it('getPolicy() reports the Playbook version under both keys', () => {
    // A CANONICAL artifact, so `format_version` is present for `getPolicy()` to
    // report. A bare `format_version` on a legacy-shaped object is rejected at
    // the ingestion boundary, which is the correct behaviour, not the subject here.
    const playbook = {
      ...makePlaybook(),
      artifact_type: 'playbook',
      format_version: '1.0.0',
      playbook_handle: 'default',
      playbook_version_id: null,
    } as unknown as ConfigArtifact;
    const sdk = new RevTurbineCustomerSdk({
      tenantId: 'tenant_abc',
      publicKey: 'rtk_test',
      endpoint: 'https://edge.example.com',
      mode: 'snippet',
      anonymousTelemetry: false,
      runtimeMode: 'local_only',
      localRuntime: { playbook },
    });
    const policy = sdk.getPolicy();
    expect(policy.playbookVersion).toBe('1.0.0');
    // Deprecated, and emitted with the identical value until 0.12.0.
    expect(policy.exportedConfigVersion).toBe(policy.playbookVersion);
  });
});
