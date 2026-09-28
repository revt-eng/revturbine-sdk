/**
 * RevTurbine Server-Side SDK Client.
 *
 * Holds the customer's **server key** and mints short-lived, browser-safe
 * `rt_client_` session keys for one end user at a time, and writes server-only
 * user state such as a user's seat-type assignment. Evaluation does not happen
 * here (plan 192) — it runs in the customer SDKs.
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

import createClient, { type Client } from 'openapi-fetch';
import type { paths } from '../web-sdk/generated/openapi';
import type {
  ClientSessionResult,
  CreateClientSessionInput,
  PlacementDecisionOutput,
  RevTurbineServerOptions,
  AssignSeatTypeOptions,
  BuiltinDimensionsErrorReason,
  DimensionWriteErrorReason,
  SeatAssignmentErrorReason,
  ServerBuiltinDimensionsWrite,
  SetBuiltinDimensionsOptions,
  ServerEvaluationPayload,
  ServerEvaluationPayloadDecisionsItem,
  ServerEvaluationPayloadEntitlementsValue,
  ServerEvaluationPayloadTrialStatus,
  ServerEvaluationPayloadUserContext,
  ServerEvaluationRequest,
  ServerPlacementRequest,
  ServerUserBuiltinDimensions,
  ServerUserContextAssignment,
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

/** The control plane's error code for an out-of-vocabulary dimension value (BL-0382). */
const UNKNOWN_DIMENSION_VALUE = 'UNKNOWN_DIMENSION_VALUE';

function seatAssignmentReason(status: number, code: string | undefined): SeatAssignmentErrorReason {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 422:
      return code === UNKNOWN_DIMENSION_VALUE ? 'unknown_dimension_value' : 'unknown_seat_type';
    default:
      return 'request_failed';
  }
}

function dimensionWriteReason(status: number): DimensionWriteErrorReason {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 422:
      return 'unknown_dimension_value';
    default:
      return 'request_failed';
  }
}

/** Read the machine-readable `code` from an error body; a non-JSON body arrives as a string. */
function errorCode(error: unknown): string | undefined { // sdk-ok: boundary-parse
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Error thrown when a seat-type assignment ({@link RevTurbineServer.assignSeatType})
 * is refused by the control plane.
 *
 * Like {@link RevTurbineClientSessionError} it carries only the HTTP status, a
 * typed {@link SeatAssignmentErrorReason}, the control plane's machine-readable
 * error `code` when one was returned, and a correlation id — never the server
 * key, request headers, or the free-text response message.
 */
export class RevTurbineSeatAssignmentError extends Error {
  /** Typed classification of {@link RevTurbineSeatAssignmentError.status}. */
  readonly reason: SeatAssignmentErrorReason;

  constructor(
    /** HTTP status returned by the control plane. */
    readonly status: number,
    /** Correlation id sent as `x-request-id` on the failed request. */
    readonly requestId: string,
    /** The control plane's machine-readable error code, when the body carried one. */
    readonly code?: string,
  ) {
    super(`RevTurbine seat-type assignment failed (status ${status})`);
    this.name = 'RevTurbineSeatAssignmentError';
    this.reason = seatAssignmentReason(status, code);
  }
}

/**
 * Error thrown when a built-in dimension write
 * ({@link RevTurbineServer.setBuiltinDimensions}) is refused by the control
 * plane (BL-0382).
 *
 * Like {@link RevTurbineSeatAssignmentError} it carries only the HTTP status, a
 * typed {@link DimensionWriteErrorReason}, the control plane's machine-readable
 * error `code` when one was returned, and a correlation id — never the server
 * key, request headers, or the free-text response message.
 */
export class RevTurbineDimensionWriteError extends Error {
  /** Typed classification of {@link RevTurbineDimensionWriteError.status}. */
  readonly reason: DimensionWriteErrorReason;

  constructor(
    /** HTTP status returned by the control plane. */
    readonly status: number,
    /** Correlation id sent as `x-request-id` on the failed request. */
    readonly requestId: string,
    /** The control plane's machine-readable error code, when the body carried one. */
    readonly code?: string,
  ) {
    super(`RevTurbine built-in dimension write failed (status ${status})`);
    this.name = 'RevTurbineDimensionWriteError';
    this.reason = dimensionWriteReason(status);
  }
}

function builtinDimensionsReason(status: number): BuiltinDimensionsErrorReason {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    default:
      return 'request_failed';
  }
}

/**
 * Error thrown when a built-in dimension read
 * ({@link RevTurbineServer.getBuiltinDimensions}) is refused by the control
 * plane.
 *
 * Like {@link RevTurbineSeatAssignmentError} it carries only the HTTP status, a
 * typed {@link BuiltinDimensionsErrorReason}, the control plane's
 * machine-readable error `code` when one was returned, and a correlation id —
 * never the server key, request headers, or the free-text response message.
 */
export class RevTurbineBuiltinDimensionsError extends Error {
  /** Typed classification of {@link RevTurbineBuiltinDimensionsError.status}. */
  readonly reason: BuiltinDimensionsErrorReason;

  constructor(
    /** HTTP status returned by the control plane. */
    readonly status: number,
    /** Correlation id sent as `x-request-id` on the failed request. */
    readonly requestId: string,
    /** The control plane's machine-readable error code, when the body carried one. */
    readonly code?: string,
  ) {
    super(`RevTurbine built-in dimension read failed (status ${status})`);
    this.name = 'RevTurbineBuiltinDimensionsError';
    this.reason = builtinDimensionsReason(status);
  }
}

/**
 * The RevTurbine server-side client. Holds the server key; mints client
 * sessions ({@link RevTurbineServer.createClientSession}), writes
 * server-only user state ({@link RevTurbineServer.assignSeatType}) and reads
 * the user's server-resolved built-in dimensions
 * ({@link RevTurbineServer.getBuiltinDimensions}).
 */
export class RevTurbineServer {
  private readonly tenantId: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly defaultTtlSeconds: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly api: Client<paths>;

  constructor(options: RevTurbineServerOptions) {
    this.tenantId = options.tenantId;
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 60;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    // The generated, typed client (web-sdk/generated/openapi.d.ts). It sends no
    // tenant header: operations called through it take the tenant from the
    // server key.
    this.api = createClient<paths>({
      baseUrl: this.endpoint,
      headers: { authorization: `Bearer ${this.apiKey}` },
      fetch: (request: Request) => this.fetchFn(request),
    });
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

  /**
   * Assign a user's seat type, or clear it with `null` (plan 279 TASK-16a).
   *
   * Calls `POST /api/sdk/user-contexts` (`upsertServerUserContext`) with exactly
   * `{ user_id, seat_type_handle }`, authenticated by the server key this client
   * holds. The tenant is taken from that key — it is never a parameter, and no
   * tenant header is sent.
   *
   * **Server-written only (D-36).** A user's seat-type assignment is written
   * only by the tenant's backend through this server-key call (or by RevTurbine
   * enrichment). It is never set from the browser: the client SDK's
   * `identify()` / `update()` do not accept `seat_type_handle`, and the endpoint
   * refuses every credential except a server key.
   *
   * Pass `options.builtinDimensions` (and `options.override`) to set built-in
   * dimension values in the same write — see {@link setBuiltinDimensions} for
   * their semantics (BL-0382).
   *
   * @param userId - The tenant's own identifier for the user (non-empty).
   * @param seatTypeHandle - One of the tenant's current seat-type handles, or
   *   `null` to clear the user's assignment.
   * @param options - Optional built-in dimension values to write with the seat.
   * @returns The resulting state, including the stored `seat_type_handle`, the
   *   customer-set `builtin_dimensions`, the pinned `overrides` and `updated_at`.
   * @throws {RevTurbineSeatAssignmentError} if the control plane refuses the
   *   write — `reason` is `unknown_seat_type` for a 422 on the handle,
   *   `unknown_dimension_value` for a 422 on a dimension value, and `forbidden`
   *   for a 403 (the key is not a server key). The error never carries the key.
   *
   * @example
   * ```ts
   * await server.assignSeatType('user_123', 'admin');
   * await server.assignSeatType('user_123', null); // clear the assignment
   * ```
   */
  async assignSeatType(
    userId: string,
    seatTypeHandle: string | null,
    options: AssignSeatTypeOptions = {},
  ): Promise<ServerUserContextAssignment> {
    const requestId = generateRequestId();
    const withDimensions = options.builtinDimensions !== undefined;
    // @revturbine-graph source:revturbine-sdk-internal:server-node/client.ts#assignSeatType
    const { data, error, response } = await this.api.POST('/api/sdk/user-contexts', {
      body: {
        user_id: userId,
        seat_type_handle: seatTypeHandle,
        ...(withDimensions ? { builtin_dimensions: options.builtinDimensions, override: options.override === true } : {}),
      },
      headers: { 'x-request-id': requestId },
    });

    if (data === undefined) {
      throw new RevTurbineSeatAssignmentError(response.status, requestId, errorCode(error));
    }
    return data;
  }

  /**
   * Set a user's built-in segment dimension values from your backend (BL-0382,
   * rulings D-46 / D-47).
   *
   * Calls `POST /api/sdk/user-contexts` (`upsertServerUserContext`) with
   * `{ user_id, builtin_dimensions, override }`, authenticated by the server key
   * this client holds. The tenant is taken from that key — never a parameter.
   * The write is an UPSERT per dimension: dimensions you do not name are left
   * alone, and `null` clears a dimension (its value and its pin). The seat
   * assignment is untouched (use {@link assignSeatType}).
   *
   * Settable dimensions: `subscription_state`, `trial_type`, `billing_health`,
   * `activity_level`, `buyer_role`, `email_type`, `region`, `device_type` —
   * each takes a value from its closed vocabulary (the types enforce it).
   * `seat_type` is not settable here; it is `assignSeatType`.
   *
   * The control plane applies the value before delivery, so both the browser
   * SDK's client context and {@link getBuiltinDimensions} return it:
   * - `override: false` (default): delivered until a newer RevTurbine
   *   enrichment change supersedes it (last writer wins, enrichment included);
   *   writing a pinned dimension without the flag unpins it.
   * - `override: true`: pinned — enrichment never replaces it until you write
   *   the dimension again without the flag, or clear it.
   *
   * @param userId - The tenant's own identifier for the user (non-empty) — the
   *   same key `assignSeatType` and `createClientSession` use.
   * @param dimensions - Dimension → value (or `null` to clear). Must name at
   *   least one dimension.
   * @param options - `{ override }` — see above.
   * @returns The resulting state: `seat_type_handle`, every customer-set
   *   `builtin_dimensions` value now stored, the pinned `overrides`, and
   *   `updated_at`.
   * @throws {RevTurbineDimensionWriteError} if the control plane refuses the
   *   write — `reason` is `unknown_dimension_value` for a 422 and `forbidden`
   *   for a 403 (the key is not a server key). The error never carries the key.
   *
   * @example
   * ```ts
   * // Your billing system knows better than RevTurbine's Stripe view: pin it.
   * await server.setBuiltinDimensions('user_123', { subscription_state: 'paid' }, { override: true });
   * // Hand the dimension back to RevTurbine enrichment.
   * await server.setBuiltinDimensions('user_123', { subscription_state: null });
   * ```
   */
  async setBuiltinDimensions(
    userId: string,
    dimensions: ServerBuiltinDimensionsWrite,
    options: SetBuiltinDimensionsOptions = {},
  ): Promise<ServerUserContextAssignment> {
    const requestId = generateRequestId();
    // @revturbine-graph source:revturbine-sdk-internal:server-node/client.ts#setBuiltinDimensions
    const { data, error, response } = await this.api.POST('/api/sdk/user-contexts', {
      body: { user_id: userId, builtin_dimensions: dimensions, override: options.override === true },
      headers: { 'x-request-id': requestId },
    });

    if (data === undefined) {
      throw new RevTurbineDimensionWriteError(response.status, requestId, errorCode(error));
    }
    return data;
  }

  /**
   * Read the control plane's server-resolved built-in segment dimensions for
   * one user (BL-0366).
   *
   * Calls `GET /api/sdk/user-contexts/{userId}/builtin-dimensions`
   * (`getServerUserBuiltinDimensions`), authenticated by the server key this
   * client holds. The tenant is taken from that key — it is never a parameter,
   * and no tenant header is sent. The result's `builtin_dimensions` carries the
   * values the browser SDK would receive through the client context
   * (Subscription State, Trial Type, Activity State, Seat Type, Buyer Role,
   * Billing Health, Email Type); `region` / `device_type` are request-derived
   * and never present. An unknown user resolves to each dimension's default.
   *
   * Feed it to local evaluation as the server overlay: pass
   * `result.builtin_dimensions` as `createStaticProviders({ …, userContext,
   * serverBuiltinDimensions })`, which overlays it per key on
   * `userContext.builtin_dimensions` — the server value wins (plan 279 PD-3).
   * The Python and Rust server SDKs accept the same object through
   * `server_builtin_dimensions`.
   *
   * @param userId - The tenant's own identifier for the user (non-empty) — the
   *   same key `assignSeatType` and `createClientSession` use.
   * @returns `{ tenant_id, user_id, builtin_dimensions, resolved_at }`.
   * @throws {RevTurbineBuiltinDimensionsError} if the control plane refuses the
   *   read — `reason` is `forbidden` for a 403 (the key is not a server key).
   *   The error never carries the key.
   *
   * @example
   * ```ts
   * const { builtin_dimensions } = await server.getBuiltinDimensions('user_123');
   * const providers = createStaticProviders({
   *   config: playbook,
   *   userContext: { id: 'user_123' },
   *   serverBuiltinDimensions: builtin_dimensions,
   * });
   * ```
   */
  async getBuiltinDimensions(userId: string): Promise<ServerUserBuiltinDimensions> {
    const requestId = generateRequestId();
    // @revturbine-graph source:revturbine-sdk-internal:server-node/client.ts#getBuiltinDimensions
    const { data, error, response } = await this.api.GET('/api/sdk/user-contexts/{userId}/builtin-dimensions', {
      params: { path: { userId } },
      headers: { 'x-request-id': requestId },
    });

    if (data === undefined) {
      throw new RevTurbineBuiltinDimensionsError(response.status, requestId, errorCode(error));
    }
    return data;
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
