/**
 * @vitest-environment jsdom
 *
 * Plan 174 TASK-4 (F-69b) — init failures propagate their cause.
 *
 * The provider's catch used to bind no error variable and store a constant
 * string, so the specific failure (including deliberately raised init
 * errors) never reached `useRevTurbine().error`. These tests pin the fix:
 * the constant prefixes, the underlying message follows, and the real error
 * object is logged for its stack.
 *
 * Plan: docs/dev-lifecycle/inprogress/174-spec-check-remediation-batch.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from './RevTurbineProvider';
import { useRevTurbine } from './useRevTurbine';
import type { RevTurbineInitOptions } from '../customer-side';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    ({ ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response),
  ));
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const handle: { error: string; isReady: boolean } = { error: '', isReady: false };

function Probe(): null {
  const { error, isReady } = useRevTurbine();
  handle.error = error;
  handle.isReady = isReady;
  return null;
}

async function mount(options: RevTurbineInitOptions): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={options}>
        <Probe />
      </RevTurbineProvider>,
    );
  });
}

describe('RevTurbineProvider init-error propagation (AC-4)', () => {
  it('surfaces the thrown cause through useRevTurbine().error, prefixed not replaced', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount({
      tenantId: 'tenant_init_error',
      apiKey: 'sk_test',
      ingestPublicKey: 'pub_test',
      environmentId: 'staging',
      endpoint: 'https://edge.example.com',
      mode: 'snippet',
      runtimeMode: 'local_only',
      contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
      // sanitizeUiPathResolverMap throws on an empty action_type key — a
      // deliberately raised init error whose message must survive.
      uiPathResolvers: { '   ': () => {} },
    });

    expect(handle.isReady).toBe(false);
    expect(handle.error).toContain('Failed to initialize RevTurbine SDK provider:');
    expect(handle.error).toContain('empty action_type');
    expect(consoleError).toHaveBeenCalledWith(
      '[RevTurbine] SDK provider initialization failed:',
      expect.any(Error),
    );
  });
});
