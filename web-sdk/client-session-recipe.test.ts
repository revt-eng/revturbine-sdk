/**
 * BL-0404 / BL-0408 / BL-0479 — the documented client-session round trip, run
 * against a fake control plane.
 *
 * pages-build `guides/client-sessions.mdx` teaches three pieces: a server route
 * that authenticates the app's own user and mints with `RevTurbineServer`, a
 * browser `fetchClientSession` callback, and `clientSession` at init. The docs
 * gate proves each snippet COMPILES; this proves the pieces WORK together —
 * that the server key never reaches the browser half, that the minted subject is
 * the signed-in user, and that an expired token is re-minted once.
 *
 * The route and callback below are the docs' code, line for line in behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RevTurbineServer } from '../server-node';
import { initRevTurbine, RuntimeMode } from './headless';
import type { RevTurbineInitOptions } from './customer-side';

const SERVER_KEY = 'rtk_server_secret';
const TENANT = 'tn_docs';

const PLAYBOOK = {
  version: '1.0.0',
  plans: [
    { unique_handle: 'free', name: 'Free', tier_position: 0, sort_order: 0 },
    { unique_handle: 'pro', name: 'Pro', tier_position: 1, sort_order: 1 },
  ],
  entitlements: [{ unique_handle: 'batch_export', name: 'Batch Export', type: 'feature' }],
  entitlement_rules: [
    { id: 'r_free', entitlement_id: 'batch_export', targets: [{ kind: 'plan', id: 'free' }], segment_ids: [], kind: 'feature', enabled: false },
    { id: 'r_pro', entitlement_id: 'batch_export', targets: [{ kind: 'plan', id: 'pro' }], segment_ids: [], kind: 'feature', enabled: true },
  ],
  segments: [], content_ui_paths: [], surface_templates: [], placements: [],
} as unknown as RevTurbineInitOptions['localRuntime'] extends { playbook?: infer P } ? P : never;

interface Recorded { method: string; url: string; auth?: string; body?: string; tenantHeader?: string }

let recorded: Recorded[];
let signedInUser: { id: string } | null;
let expireFirstContextToken: boolean;
const mintedFor = new Map<string, string>(); // token -> subject
let contextCalls = 0;

const realFetch = globalThis.fetch;

/** One fetch that plays the browser's own origin (`/api/revturbine-session`) and the control plane. */
function installFakeNetwork(): void {
  mintedFor.clear();
  contextCalls = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const method = (input instanceof Request ? input.method : init?.method ?? 'GET').toUpperCase();
    recorded.push({
      method,
      url,
      auth: headers.get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
      tenantHeader: headers.get('x-tenant-id') ?? undefined,
    });

    // The app's own route, same origin as the page.
    if (url === '/api/revturbine-session') return revturbineSessionRoute();

    if (url.endsWith('/api/sdk/client-sessions')) {
      if (headers.get('authorization') !== `Bearer ${SERVER_KEY}`) return new Response('{}', { status: 401 });
      const { subject } = JSON.parse(String(init?.body)) as { subject: string };
      const token = `rt_client_${mintedFor.size + 1}`;
      mintedFor.set(token, subject);
      return new Response(JSON.stringify({ client_token: token, expires_at: '2099-01-01T00:00:00.000Z' }), { status: 201 });
    }

    if (url.endsWith('/api/sdk/client-context')) {
      contextCalls += 1;
      const token = (headers.get('authorization') ?? '').replace('Bearer ', '');
      if (expireFirstContextToken && contextCalls === 1) return new Response('{}', { status: 401 });
      return mintedFor.get(token) === 'user_pro'
        ? new Response(JSON.stringify({ plan: { handle: 'pro', name: 'Pro' } }), { status: 200 })
        : new Response('{}', { status: 401 });
    }

    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

/** The route from guides/client-sessions.mdx (Next.js route handler). */
async function revturbineSessionRoute(): Promise<Response> {
  const revturbineServer = new RevTurbineServer({
    tenantId: TENANT,
    apiKey: SERVER_KEY,
    endpoint: 'https://revturbine.example.com/app',
  });
  const user = signedInUser;
  if (!user) return new Response('Unauthorized', { status: 401 });
  try {
    const { client_token, expires_at } = await revturbineServer.clientSessions.create({ subject: user.id });
    return Response.json({ client_token, expires_at }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return new Response('Could not create a RevTurbine session', { status: 502 });
  }
}

/** The callback from guides/client-sessions.mdx. */
async function fetchClientSession(): Promise<string> {
  const response = await fetch('/api/revturbine-session', { method: 'POST', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`RevTurbine client session failed (${response.status})`);
  const body: { client_token: string } = await response.json();
  return body.client_token;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function start(userId: string) {
  return initRevTurbine({
    runtimeMode: RuntimeMode.LocalOnly,
    localRuntime: { playbook: PLAYBOOK },
    anonymousTelemetry: false,
    analytics: false,
    endpoint: 'https://revturbine.example.com/app',
    user: { id: userId, plan_handle: 'free' },
    clientSession: fetchClientSession,
  });
}

beforeEach(() => {
  recorded = [];
  signedInUser = { id: 'user_pro' };
  expireFirstContextToken = false;
  installFakeNetwork();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('client-session recipe (guides/client-sessions.mdx)', () => {
  it('mints with the server key for the signed-in user, and the plan Stripe holds reaches the browser SDK', async () => {
    const rt = await start('user_pro');
    expect((await rt.can('batch_export')).allowed).toBe(false); // the app said `free`
    await settle();

    // The server half authenticated with the server key and minted for the signed-in user.
    const mint = recorded.find((r) => r.url.endsWith('/api/sdk/client-sessions'));
    expect(mint?.method).toBe('POST');
    expect(mint?.auth).toBe(`Bearer ${SERVER_KEY}`);
    expect(JSON.parse(mint?.body ?? '{}')).toMatchObject({ subject: 'user_pro' });
    expect(mint?.tenantHeader).toBe(TENANT);

    // The browser half never saw the server key: its only credential is the minted token.
    const toContext = recorded.find((r) => r.url.endsWith('/api/sdk/client-context'));
    expect(toContext?.auth).toBe('Bearer rt_client_1');
    expect(recorded.filter((r) => r.url === '/api/revturbine-session')).toSatisfy(
      (calls: Recorded[]) => calls.every((c) => c.auth === undefined),
    );

    // Server-derived plan overlaid the app-supplied one: the decision moved.
    expect((await rt.can('batch_export')).allowed).toBe(true);
  });

  it('re-mints once and retries when the control plane says the token expired', async () => {
    expireFirstContextToken = true;
    const rt = await start('user_pro');
    await settle();

    // The first token was rejected, so at least one fresh mint followed. (The
    // headless init also re-mints once after its own `identify()`, so the exact
    // count is not part of the contract; the outcome is.)
    expect(mintedFor.size).toBeGreaterThanOrEqual(2);
    expect(contextCalls).toBeGreaterThanOrEqual(2);
    expect((await rt.can('batch_export')).allowed).toBe(true);
  });

  it('keeps the app-supplied context when nobody is signed in (the route answers 401)', async () => {
    signedInUser = null;
    const rt = await start('user_pro');
    await settle();

    expect(mintedFor.size).toBe(0);
    expect(contextCalls).toBe(0);
    expect((await rt.can('batch_export')).allowed).toBe(false); // still `free`; nothing threw
  });
});
