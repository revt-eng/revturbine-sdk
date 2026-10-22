/**
 * Runtime environment detection — `isServer` / `isBrowser` are re-exported
 * from @revt-eng/core.
 *
 * Core's `isServer()` means "no DOM" (`window` or `document` is missing). That
 * is the right test for DOM access, but NOT for "may this context hold the
 * secret server key": a Web Worker or service worker has no `window` /
 * `document`, yet it runs in the end user's browser. {@link isServerKeyContext}
 * is the credential test; it treats worker scopes as browser contexts.
 */

import { isServer } from '@revt-eng/core';

export { isServer, isBrowser } from '@revt-eng/core';

/**
 * Server-side runtimes that use a worker-style global scope (Cloudflare
 * `workerd`, Vercel Edge, Deno, Bun). Their worker scopes are backends, not a
 * user's browser.
 */
function isServerWorkerRuntime(scope: object): boolean {
  if (typeof Reflect.get(scope, 'EdgeRuntime') === 'string') return true;
  if (Reflect.get(scope, 'Deno') !== undefined) return true;
  if (Reflect.get(scope, 'Bun') !== undefined) return true;
  const navigatorValue = Reflect.get(scope, 'navigator');
  if (typeof navigatorValue === 'object' && navigatorValue !== null) {
    if (Reflect.get(navigatorValue, 'userAgent') === 'Cloudflare-Workers') return true;
  }
  return false;
}

/**
 * Whether `scope` is a browser worker global scope — a dedicated or shared Web
 * Worker (`WorkerGlobalScope`, `importScripts`) or a service worker
 * (`ServiceWorkerGlobalScope`) — as opposed to a server runtime.
 *
 * @param scope the global object to inspect; defaults to `globalThis`.
 * @internal
 */
export function isBrowserWorkerScope(scope: object = globalThis): boolean {
  if (isServerWorkerRuntime(scope)) return false;
  for (const name of ['ServiceWorkerGlobalScope', 'WorkerGlobalScope']) {
    const ctor = Reflect.get(scope, name);
    if (typeof ctor === 'function' && scope instanceof ctor) return true;
  }
  return typeof Reflect.get(scope, 'importScripts') === 'function';
}

/**
 * Whether this context may authenticate with the SECRET server key
 * (`apiKey`): a backend — no `window` / `document` — that is not a browser
 * Web Worker or service worker. Every browser context, worker scopes
 * included, uses only the public key.
 *
 * @internal
 */
export function isServerKeyContext(): boolean {
  return isServer() && !isBrowserWorkerScope();
}
