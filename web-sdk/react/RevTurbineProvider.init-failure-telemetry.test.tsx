/**
 * @vitest-environment jsdom
 *
 * ST-1696 — what a failed provider initialisation reports on the anonymous
 * meta lane. A caught exception's message can carry customer data (an id in a
 * URL, an email, a trait value), so the lane gets only the init PHASE and the
 * error's constructor name, in the one fixed shape
 * `provider_init_failed at <phase>: <ErrorName>`; anything that is not a plain
 * identifier name, and any non-Error throw, becomes `NonError`.
 *
 * Asserts on what reaches the lane and a telemetry provider, not on a helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineProvider } from './RevTurbineProvider';
import { RevTurbineCustomerSdk } from '../customer-side';
import type { RevTurbineInitInputOptions, SdkTelemetryProvider } from '../customer-side';
import type { SdkMetaEvent } from '../generated';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let laneBodies: string[];

const PLAYBOOK = {
  artifact_type: 'playbook', format_version: '1.0.0', playbook_handle: 'd', playbook_version_id: null,
  tenant_id: 't_1', environment_id: 'production', plans: [], entitlements: [], entitlement_rules: [],
  segments: [], content_ui_paths: [], surface_templates: [], placements: [],
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  laneBodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/sdk/meta')) laneBodies.push(String(init?.body));
    return { ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response;
  }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) { await act(async () => root!.unmount()); root = null; }
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function failInitWith(thrown: unknown): Promise<{ lane: SdkMetaEvent[]; provider: SdkMetaEvent[] }> {
  vi.spyOn(RevTurbineCustomerSdk.prototype, 'registerPlacement').mockRejectedValue(thrown);
  const provider: SdkMetaEvent[] = [];
  const sink: SdkTelemetryProvider = { name: 'sink', send(events) { provider.push(...events); } };
  const options = {
    user: { id: 'u_secret_42' },
    tenantId: 't_1',
    runtimeMode: 'local_only',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    localRuntime: { playbook: PLAYBOOK },
    sdkTelemetryProviders: [sink],
  } as unknown as RevTurbineInitInputOptions;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineProvider options={options as never} bootstrapPlacements={[{ placement: { name: 'p', route: '/' } }]}>
        <p>child</p>
      </RevTurbineProvider>,
    );
  });
  await vi.waitFor(() => expect(provider.some((e) => e.event_type === 'sdk_error')).toBe(true));
  await vi.waitFor(() => expect(laneBodies.some((b) => b.includes('sdk_error'))).toBe(true));
  const lane = laneBodies.flatMap((b) => (JSON.parse(b) as { events: SdkMetaEvent[] }).events)
    .filter((e) => e.event_type === 'sdk_error');
  return { lane, provider: provider.filter((e) => e.event_type === 'sdk_error') };
}

describe('provider_init_failed on the meta lane', () => {
  it('carries the phase and the error name only, never the exception text (id, email, trait)', async () => {
    class ValidationError extends Error {
      constructor(message: string) { super(message); this.name = 'ValidationError'; }
    }
    const { lane, provider } = await failInitWith(
      new ValidationError('bad row for user u_secret_42 <alice@example.com> plan=enterprise-gold'),
    );
    expect(lane).toHaveLength(1);
    expect(lane[0]).toMatchObject({ reason: 'provider_init_failed', message: 'provider_init_failed at placements: ValidationError' });
    expect(provider).toHaveLength(1);
    expect(provider[0].message).toBe('provider_init_failed at placements: ValidationError');
    for (const sent of [JSON.stringify(lane), JSON.stringify(provider)]) {
      expect(sent).not.toContain('u_secret_42');
      expect(sent).not.toContain('alice@example.com');
      expect(sent).not.toContain('enterprise-gold');
    }
  });

  it('a non-Error throw is NonError', async () => {
    const { lane } = await failInitWith('user alice@example.com failed');
    expect(lane[0].message).toBe('provider_init_failed at placements: NonError');
    expect(JSON.stringify(lane)).not.toContain('alice@example.com');
  });

  it('an error whose name is not a plain identifier is NonError', async () => {
    const odd = new Error('boom u_secret_42');
    odd.name = 'Bad Name: alice@example.com';
    const { lane, provider } = await failInitWith(odd);
    expect(lane[0].message).toBe('provider_init_failed at placements: NonError');
    expect(provider[0].message).toBe('provider_init_failed at placements: NonError');
  });
});
