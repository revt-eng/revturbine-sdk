/**
 * @vitest-environment jsdom
 *
 * ST-1696 (Kent, 2026-11-11): RevTurbine reporting is OPT-OUT. Clickstream and
 * placement-interaction reporting are functional (attribution of placements to
 * conversions; planned for caps and cooldowns), so with neither `analytics` nor
 * `telemetry.consent` set they are ON. A customer turns them off explicitly:
 * `analytics: false`, `telemetry.consent: 'denied' | 'pending'`, or
 * `setTelemetryConsent()` at runtime. Turning them off never changes Playbook
 * delivery or decisions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk, RuntimeMode } from './customer-side';

interface Call { url: string; body: string }
let calls: Call[];
const sdks: RevTurbineCustomerSdk[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return { ok: true, status: 202, json: async () => ({}), text: async () => '' } as unknown as Response;
  }));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const sdk of sdks.splice(0)) sdk.dispose();
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function build(extra: Record<string, unknown> = {}): RevTurbineCustomerSdk {
  const sdk = new RevTurbineCustomerSdk({
    user: { id: 'u1' },
    runtimeMode: RuntimeMode.Server,
    publicKey: 'rtk_public',
    tenantId: 't_1',
    environmentId: 'production',
    endpoint: 'https://edge.example.com',
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...extra,
  } as never);
  sdks.push(sdk);
  return sdk;
}

async function report(sdk: RevTurbineCustomerSdk): Promise<string[]> {
  await sdk.flushEvents();
  calls = [];
  await sdk.capture('feature_used', { marker: 'default_probe' }, { immediate: true });
  await sdk.trackTreatmentInteraction({
    userId: 'u1', placementId: 'pl_1', payloadId: 'out_1', interactionType: 'impression',
  } as never);
  await sdk.flushEvents();
  const events = calls
    .filter((c) => c.url.endsWith('/api/track'))
    .flatMap((c) => (JSON.parse(c.body) as { events: Array<{ event_name: string }> }).events);
  return events.map((e) => e.event_name);
}

describe('defaults: reporting is ON', () => {
  it('with neither option set, clickstream and placement-interaction events are sent', async () => {
    const names = await report(build());
    expect(names).toContain('feature_used');
    expect(names.some((n) => n.includes('placement_interaction'))).toBe(true);
  });

  it('the consent default is granted', () => {
    expect(build().getTelemetryConsent()).toBe('granted');
  });
});

describe('explicit opt-outs stop reporting', () => {
  it('analytics: false', async () => {
    expect(await report(build({ analytics: false }))).toEqual([]);
  });

  it.each(['denied', 'pending'] as const)('telemetry.consent: %s', async (consent) => {
    expect(await report(build({ telemetry: { consent } }))).toEqual([]);
  });

  it('setTelemetryConsent() stops and resumes reporting at runtime', async () => {
    const sdk = build();
    sdk.setTelemetryConsent('denied');
    expect(await report(sdk)).toEqual([]);
    sdk.setTelemetryConsent('granted');
    expect(await report(sdk)).toContain('feature_used');
  });
});
