/**
 * RevTurbine Server-Side SDK Client.
 *
 * Performs server-to-server evaluation calls against the RevTurbine decision
 * engine and returns a serializable `ServerEvaluationPayload` that the
 * client-side SDK can hydrate.
 *
 * Designed for:
 * - Next.js `getServerSideProps` / RSC / API routes
 * - Express / Fastify middleware
 * - Any Node.js server-side rendering pipeline
 *
 * @example
 * ```ts
 * import { RevTurbineServer } from '@revt-eng/sdk/server';
 *
 * const server = new RevTurbineServer({
 *   tenantId: 'tenant_abc',
 *   apiKey: process.env.REVTURBINE_SECRET_KEY!,
 *   endpoint: 'https://edge.example.com',
 * });
 *
 * // In getServerSideProps:
 * const payload = await server.evaluate({
 *   userId: session.user.id,
 *   traits: { plan: 'pro' },
 *   placements: [{ slotId: 'hero_banner' }],
 *   entitlementHandles: ['advanced_analytics'],
 *   includeTheme: true,
 * });
 *
 * return { props: { rtPayload: payload } };
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
 * the mint secret, request headers, or response body — so the secret cannot leak
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
   * Mint a short-lived, opaque per-user client-session token (plan 157).
   *
   * The customer backend — which holds the `rt_secret_` mint secret (passed as
   * {@link RevTurbineServerOptions.apiKey}) — calls this to obtain a browser-safe
   * `rt_client_` token scoped to one end-user subject, then returns the token to
   * its frontend. The frontend authenticates `GET /api/sdk/client-context` with
   * it to read the user's client-safe context.
   *
   * This is a **server-only** capability: the browser SDK never mints tokens (it
   * only consumes them). Tenant / application / environment are derived
   * server-side from the mint secret, never from this call.
   *
   * @throws {RevTurbineClientSessionError} if the control plane rejects the mint.
   *   The error carries only the HTTP status + request id — never the secret.
   */
  async createClientSession(input: CreateClientSessionInput): Promise<ClientSessionResult> {
    const requestId = generateRequestId();
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
