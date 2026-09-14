/**
 * @vitest-environment jsdom
 *
 * Plan 233 TASK-2 / AC-3 — init failure is reachable with no SDK instance.
 *
 * The defect these pin: every diagnostic the SDK ships hangs off a running
 * instance, so when init throws there is nothing left to ask. The provider
 * caught the error, logged one `console.error`, and rendered children normally —
 * and because the host app renders correctly without RevTurbine by design, a
 * dead SDK looked exactly like a healthy one. A customer ran that way for 36
 * hours and found it only by pasting a raw browser console log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from './RevTurbineProvider';
import { useRevTurbine } from './useRevTurbine';
import { remediationFor, initStatusForError } from './init-status';
import type { RevTurbineInitOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let handle: ReturnType<typeof useRevTurbine>;

function Probe() {
  handle = useRevTurbine();
  return <div data-testid="child">child rendered</div>;
}

/**
 * A Playbook missing a required body array — a genuine, realistic init failure
 * (a hand-edited or truncated export).
 *
 * NOT the example AC-3 suggests. AC-3 proposes "a Playbook with neither an
 * artifact `tenant_id` nor a `tenantId` option", but that cannot fail:
 * `normalizeInitOptions` (customer-side.ts) substitutes
 * `LOCAL_ONLY_INIT_DEFAULTS.tenantId` whenever a Playbook is present, so the
 * init option is never actually absent in local mode. Verified by this suite
 * failing against that fixture with a live SDK instead of a null one.
 */
const MALFORMED_PLAYBOOK = {
  artifact_type: 'playbook',
  format_version: '1.0.0',
  playbook_handle: 'default',
  playbook_version_id: null,
  tenant_id: 't_1',
  environment_id: 'production',
  // `plans` omitted — requireBodyArrays throws.
  entitlements: [],
  entitlement_rules: [],
  segments: [],
  content_ui_paths: [],
};

/** A healthy Playbook, for the ok:true case. */
const HEALTHY_PLAYBOOK = { ...MALFORMED_PLAYBOOK, plans: [] };

async function mount(options: Partial<RevTurbineInitOptions>): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={options as RevTurbineInitOptions}>
        <Probe />
      </RevTurbineProvider>,
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('AC-3 — initStatus is readable with no SDK instance', () => {
  it('reports ok:false with a phase, message, and non-empty remediation', async () => {
    await mount({
      runtimeMode: 'local_only',
      localRuntime: { playbook: MALFORMED_PLAYBOOK },
    });

    // The guard TASK-2 names: the SDK is null, and the status is still there.
    expect(handle.sdk).toBeNull();
    expect(handle.initStatus.ok).toBe(false);
    expect(handle.initStatus.phase).toBe('construct');
    expect(handle.initStatus.message).toContain('missing array "plans"');
    expect(handle.initStatus.remediation).toBeTruthy();
    expect(handle.initStatus.remediation).toContain('Re-export');
  });

  it('keeps rendering children — the app is never taken down by a dead SDK', async () => {
    await mount({
      runtimeMode: 'local_only',
      localRuntime: { playbook: MALFORMED_PLAYBOOK },
    });

    // This is the behaviour that made the failure invisible, and it is correct:
    // the fix is to make the status reachable, not to break the host app.
    expect(container?.textContent).toContain('child rendered');
  });

  it('renders a visible diagnostic in a development build', async () => {
    await mount({
      runtimeMode: 'local_only',
      localRuntime: { playbook: MALFORMED_PLAYBOOK },
    });

    const banner = container?.querySelector('[data-revturbine-init-failure="true"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('RevTurbine did not start');
    expect(banner?.getAttribute('role')).toBe('alert');
  });

  it('does NOT render the diagnostic in a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await mount({
      runtimeMode: 'local_only',
      localRuntime: { playbook: MALFORMED_PLAYBOOK },
    });

    expect(handle.initStatus.ok).toBe(false);
    expect(container?.querySelector('[data-revturbine-init-failure="true"]')).toBeNull();
  });

  it('logs the remediation, not just the raw error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await mount({
      runtimeMode: 'local_only',
      localRuntime: { playbook: MALFORMED_PLAYBOOK },
    });

    const logged = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('Re-export');
  });

  it('stays ok:true on a healthy init', async () => {
    await mount({
      tenantId: 't_1',
      runtimeMode: 'local_only',
      localRuntime: { playbook: HEALTHY_PLAYBOOK },
    });

    expect(handle.sdk).not.toBeNull();
    expect(handle.initStatus.ok).toBe(true);
    expect(handle.initStatus.remediation).toBeUndefined();
    expect(container?.querySelector('[data-revturbine-init-failure="true"]')).toBeNull();
  });
});

describe('remediation is never empty', () => {
  it('maps known failures to an actionable fix', () => {
    expect(remediationFor('Invalid x: missing non-empty string "tenant_id"')).toContain('tenantId');
    expect(remediationFor('Invalid x: missing array "plans"')).toContain('Re-export');
    expect(remediationFor('Invalid x: expected top-level object')).toContain('parsed value');
  });

  it('falls back rather than returning nothing for an unrecognized error', () => {
    const remediation = remediationFor('something nobody anticipated');
    expect(remediation.length).toBeGreaterThan(0);
    // The fallback must not send the reader back to the console — that is the
    // signal that already failed them.
    expect(remediation.toLowerCase()).not.toContain('check the console');
  });

  it('populates every field from a thrown value, including a non-Error', () => {
    const status = initStatusForError('theme', 'a bare string throw');
    expect(status).toMatchObject({ ok: false, phase: 'theme', message: 'a bare string throw' });
    expect(status.remediation).toBeTruthy();
  });
});
