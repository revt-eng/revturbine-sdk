/**
 * Worker scopes are browser contexts for the credential test: core's
 * `isServer()` is true there (no `window` / `document`), but a Web Worker or
 * service worker runs in the end user's browser and must never hold the
 * secret server key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBrowserWorkerScope, isServer, isServerKeyContext } from './env';

class WorkerGlobalScope {}
class ServiceWorkerGlobalScope extends WorkerGlobalScope {}

function workerScope(): object {
  return Object.assign(new WorkerGlobalScope(), { WorkerGlobalScope, importScripts: () => undefined });
}

function serviceWorkerScope(): object {
  return Object.assign(new ServiceWorkerGlobalScope(), { WorkerGlobalScope, ServiceWorkerGlobalScope });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isBrowserWorkerScope', () => {
  it('a dedicated Web Worker scope is a browser worker', () => {
    expect(isBrowserWorkerScope(workerScope())).toBe(true);
  });

  it('a service worker scope is a browser worker', () => {
    expect(isBrowserWorkerScope(serviceWorkerScope())).toBe(true);
  });

  it('a scope exposing only importScripts (classic worker) is a browser worker', () => {
    expect(isBrowserWorkerScope({ importScripts: () => undefined })).toBe(true);
  });

  it('a plain Node global is not a worker', () => {
    expect(isBrowserWorkerScope({ process: { versions: { node: '22.13.0' } } })).toBe(false);
    expect(isBrowserWorkerScope()).toBe(false);
  });

  it('server runtimes with a worker-style scope are not browser workers', () => {
    expect(isBrowserWorkerScope(Object.assign(serviceWorkerScope(), { navigator: { userAgent: 'Cloudflare-Workers' } }))).toBe(false);
    expect(isBrowserWorkerScope(Object.assign(workerScope(), { EdgeRuntime: 'edge-runtime' }))).toBe(false);
    expect(isBrowserWorkerScope(Object.assign(workerScope(), { Deno: {} }))).toBe(false);
    expect(isBrowserWorkerScope(Object.assign(workerScope(), { Bun: {} }))).toBe(false);
  });
});

describe('isServerKeyContext', () => {
  it('a Node backend may use the server key', () => {
    expect(isServer()).toBe(true);
    expect(isServerKeyContext()).toBe(true);
  });

  it('a worker global (no window, no document) may not', () => {
    vi.stubGlobal('importScripts', () => undefined);
    expect(isServer()).toBe(true);
    expect(isServerKeyContext()).toBe(false);
  });
});
