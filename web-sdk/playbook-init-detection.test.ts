/**
 * Regression: a `localRuntime.playbook`-only init must be detected as local-only.
 *
 * The playbook option (0.2.29) added the canonical key but two init paths still
 * read `exportedConfig` directly — `normalizeInitOptions` (which applies the
 * local-only defaults) and the React provider's theme shortcut. So a caller who
 * used only `playbook` never entered local mode: the SDK stayed in server mode
 * and hung/failed on init against a non-existent endpoint. These assert the
 * canonical key is honoured wherever the legacy key was.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initRevTurbine, resolveLocalPlaybook } from './customer-side';
import type { ConfigArtifact } from './customer-side';

const MINIMAL_PLAYBOOK = {
  version: '1.0.0',
  plans: [],
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
} as unknown as ConfigArtifact;

afterEach(() => vi.restoreAllMocks());

describe('playbook-only init is detected as local-only', () => {
  it('resolves entitlement checks locally, with no network call', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch must not be called in local-only mode');
    });
    vi.stubGlobal('fetch', fetchSpy);

    // No runtimeMode, no endpoint — exactly the shape the docs now recommend.
    // initRevTurbine() is the factory that applies local-only defaults via
    // normalizeInitOptions, which is where the missed key read lived.
    const sdk = initRevTurbine({
      localRuntime: { playbook: MINIMAL_PLAYBOOK },
      uiPathResolvers: {},
    } as never);
    sdk.setUserContext({ id: 'user_x', plan: { id: 'starter', name: 'Starter' } });

    const result = await sdk.checkEntitlement('anything');

    // The check resolved from the Playbook (a local answer), not a server round-trip.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.reason).not.toBe('entitlement_service_unavailable');
    expect(result.reason).not.toBe('entitlement_check_error');
  });

  it('resolveLocalPlaybook underpins the fix for both keys', () => {
    expect(resolveLocalPlaybook({ playbook: MINIMAL_PLAYBOOK })).toBe(MINIMAL_PLAYBOOK);
    expect(resolveLocalPlaybook({ exportedConfig: MINIMAL_PLAYBOOK })).toBe(MINIMAL_PLAYBOOK);
  });
});
