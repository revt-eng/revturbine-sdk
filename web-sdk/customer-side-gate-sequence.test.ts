/**
 * Plan 144 TASK-14 / AC-11 — the ACTIVE gate sequence. `rt.gate(action, fn)`
 * emits `gate_attempted`, then `gate_allowed` (and runs `fn`) or `gate_denied`
 * (and does not). This is the single source the React `useGatedAction` delegates
 * to, distinct from the passive `gate_evaluated` a rendered `<Gate>` emits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];

function okResponse(): Response {
  return { ok: true, status: 202, json: async () => ({ accepted: 1 }), text: async () => '' } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(okResponse());
    }),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function makeSdk(over: Partial<RevTurbineInitOptions> = {}): RevTurbineCustomerSdk {
  return new RevTurbineCustomerSdk({
    tenantId: 'tenant_abc',
    apiKey: 'sk',
    ingestPublicKey: 'pub',
    environmentId: 'prod',
    endpoint: 'https://edge.example.com',
    mode: 'snippet',
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
    ...over,
  });
}

/** Event names across all `/api/track` batches, in wire order. */
function eventNames(): string[] {
  return calls
    .filter((c) => c.url.endsWith('/api/track'))
    .flatMap((c) => (JSON.parse(String(c.init.body)) as { events: Array<{ event_name: string }> }).events)
    .map((e) => e.event_name);
}

describe('rt.gate active sequence', () => {
  it('allowed: emits gate_attempted → gate_allowed and RUNS the action', async () => {
    const sdk = makeSdk();
    vi.spyOn(sdk, 'checkEntitlement').mockResolvedValue({ status: 'allowed', allowed: true } as never);
    const fn = vi.fn().mockResolvedValue('exported');

    const result = await sdk.gate('export_pdf', fn);
    await sdk.flushEvents();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ran: true, result: 'exported', entitlement: { status: 'allowed', allowed: true } });
    const gateEvents = eventNames().filter((n) => n.startsWith('gate_'));
    expect(gateEvents).toEqual(['gate_attempted', 'gate_allowed']);
  });

  it('denied: emits gate_attempted → gate_denied and does NOT run the action', async () => {
    const sdk = makeSdk();
    vi.spyOn(sdk, 'checkEntitlement').mockResolvedValue({ status: 'denied', allowed: false, reason: 'no_plan' } as never);
    const fn = vi.fn();

    const result = await sdk.gate('export_pdf', fn);
    await sdk.flushEvents();

    expect(fn).not.toHaveBeenCalled();
    expect(result.ran).toBe(false);
    const gateEvents = eventNames().filter((n) => n.startsWith('gate_'));
    expect(gateEvents).toEqual(['gate_attempted', 'gate_denied']);
    expect(gateEvents).not.toContain('gate_evaluated'); // active path, not passive
  });
});
