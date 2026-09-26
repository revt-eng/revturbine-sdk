/**
 * RevTurbine Server-Side SDK Client.
 *
 * Holds the customer's **server key** and mints short-lived, browser-safe
 * `rt_client_` session keys for one end user at a time. Evaluation does not
 * happen here (plan 192) — it runs in the customer SDKs.
 *
 * Designed for:
 * - Next.js RSC / route handlers / `getServerSideProps`
 * - Express / Fastify middleware
 * - Any Node.js backend
 *
 * @example
 * ```ts
 * import { RevTurbineServer } from '@revt-eng/sdk/server';
 *
 * const server = new RevTurbineServer({
 *   tenantId: 'tenant_abc',
 *   apiKey: process.env.REVTURBINE_API_KEY!, // the server key (rtk_…, type server)
 *   endpoint: 'https://edge.example.com',
 * });
 *
 * // Mint a session key for the signed-in user and hand it to the browser.
 * const { client_token } = await server.createClientSession({ subject: session.user.id });
 * ```
 */

import type {
  ClientSessionResult,
  CreateClientSessionInput,
  PlacementDecisionOutput,
  RevTurbineServerOptions,
  ServerEvaluationPayload,
  ServerEvaluationPayloadDecisionsItem,
  ServerEvaluationPayloadEntitlementsValue,
  ServerEvaluationPayloadTrialStatus,
  ServerEvaluationPayloadUserContext,
  ServerEvaluationRequest,
  ServerPlacementRequest,
} from './types';

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Error thrown when a client-session mint request is rejected by the control
 * plane. Carries only the HTTP status and a correlation id — deliberately never
 * the server key, request headers, or response body — so the key cannot leak
 * through error logs (plan 157 AC-8).
 */
export class RevTurbineClientSessionError extends Error {
  constructor(
    /** HTTP status returned by the control plane. */
    readonly status: number,
    /** Correlation id for the failed request. */
    readonly requestId: string,
  ) {
    super(`RevTurbine client-session mint failed (status ${status})`);
    this.name = 'RevTurbineClientSessionError';
  }
}

export class RevTurbineServer {
  private readonly tenantId: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly defaultTtlSeconds: number;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: RevTurbineServerOptions) {
    this.tenantId = options.tenantId;
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 60;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  /**
   * Client-session minting namespace (plan 157). Ergonomic form of
   * {@link createClientSession}:
   *
   * @example
   * ```ts
   * const { client_token, expires_at } = await server.clientSessions.create({
   *   subject: session.user.id,
   * });
   * // return client_token to the frontend
   * ```
   */
  get clientSessions(): {
    create: (input: CreateClientSessionInput) => Promise<ClientSessionResult>;
  } {
    return { create: (input: CreateClientSessionInput) => this.createClientSession(input) };
  }

  /**
   * Mint a short-lived, opaque per-user client-session token (plan 157; the
   * server key is the minting authority, plan 256).
   *
   * The customer backend — which holds the server key (passed as
   * {@link RevTurbineServerOptions.apiKey}) — calls this to obtain a browser-safe
   * `rt_client_` token scoped to one end-user subject, then returns the token to
   * its frontend. The frontend authenticates `GET /api/sdk/client-context` with
   * it to read the user's client-safe context.
   *
   * This is a **server-only** capability: the browser SDK never mints tokens (it
   * only consumes them). The tenant is derived server-side from the server key,
   * never from this call.
   *
   * @throws {RevTurbineClientSessionError} if the control plane rejects the mint.
   *   The error carries only the HTTP status + request id — never the key.
   */
  async createClientSession(input: CreateClientSessionInput): Promise<ClientSessionResult> {
    const requestId = generateRequestId();
    // @revturbine-graph source:revturbine-sdk-internal:server-node/client.ts#createClientSession
    const response = await this.apiCall(requestId, '/api/sdk/client-sessions', {
      subject: input.subject,
      surface: input.surface,
      capabilities: input.capabilities ?? ['context:read'],
    });

    if (!response.ok) {
      throw new RevTurbineClientSessionError(response.status, requestId);
    }

    const data = (await response.json()) as { client_token: string; expires_at: string };
    return { client_token: data.client_token, expires_at: data.expires_at };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async apiCall(requestId: string, path: string, body: unknown): Promise<Response> { // sdk-ok: boundary-parse — transport accepts any JSON-serializable body
    return this.fetchFn(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.apiKey}`,
        'x-tenant-id': this.tenantId,
        'x-request-id': requestId,
      },
      body: JSON.stringify(body),
    });
  }

  private async apiGet(requestId: string, path: string): Promise<Response> {
    return this.fetchFn(`${this.endpoint}${path}`, {
      method: 'GET',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'x-tenant-id': this.tenantId,
        'x-request-id': requestId,
      },
    });
  }

}
