/**
 * @vitest-environment jsdom
 *
 * Plan 144 TASK-15 — end-to-end: an annotated click flows through `capture`, so
 * any PII that slips into an allowlisted `data-rt-prop-*` value is scrubbed by
 * the existing redactor before it reaches the wire (REQ-14 "passed through the
 * existing redactor"). This closes the loop the module test (collection layer)
 * and the redaction suite (transport layer) each cover in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevTurbineCustomerSdk } from './customer-side';
import type { RevTurbineInitOptions } from './customer-side';
import { installAnnotatedCapture } from './telemetry';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];

function okResponse(): Response {
  return { ok: true, status: 202, json: async () => ({ accepted: 1 }), text: async () => '' } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  document.body.innerHTML = '';
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

function trackedRows(): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.url.endsWith('/api/track'))
    .flatMap((c) => (JSON.parse(String(c.init.body)) as { events: Array<Record<string, unknown>> }).events);
}

describe('annotated capture → capture → redaction (REQ-14)', () => {
  it('redacts PII in an allowlisted prop value before it reaches the wire', async () => {
    const sdk = makeSdk();
    document.body.innerHTML =
      '<button id="b" data-rt-event="cta_clicked" data-rt-prop-reporter="jane@acme.com" data-rt-prop-plan="pro"></button>';
    const cleanup = installAnnotatedCapture(document, (event, props) => {
      void sdk.capture(event, props);
    });

    document.getElementById('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sdk.flushEvents();
    cleanup();

    const ev = trackedRows().find((r) => r.event_name === 'cta_clicked');
    expect(ev, 'expected a cta_clicked wire row').toBeDefined();
    const serialized = JSON.stringify(JSON.parse(String(ev!.properties)));
    expect(serialized).not.toContain('jane@acme.com'); // PII scrubbed
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('pro'); // non-PII allowlisted value kept
  });
});
