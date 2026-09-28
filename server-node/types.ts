/**
 * Server-side evaluation types for the RevTurbine SDK.
 *
 * Response/payload types are imported from the generated schema types
 * (`@revt-eng/schema`) so the server SDK is always aligned with the
 * JSON-Schema source of truth. Request-only and configuration types
 * that are SDK-specific (not in the schema) are defined here.
 */

// ---------------------------------------------------------------------------
// Generated payload types — re-exported for convenience
// ---------------------------------------------------------------------------

import type {
  PlacementDecisionOutput,
  ServerEvaluationPayload,
  ServerEvaluationPayloadDecisionsItem,
  ServerEvaluationPayloadEntitlementsValue,
  ServerEvaluationPayloadTrialStatus,
  ServerEvaluationPayloadUser,
  ServerEvaluationPayloadUserContext,
  ServerUserContextAssignment,
  ServerUserBuiltinDimensions,
  ServerBuiltinDimensionsWrite,
} from '@revt-eng/schema';

export type {
  PlacementDecisionOutput,
  ServerEvaluationPayload,
  ServerEvaluationPayloadDecisionsItem,
  ServerEvaluationPayloadEntitlementsValue,
  ServerEvaluationPayloadTrialStatus,
  ServerEvaluationPayloadUser,
  ServerEvaluationPayloadUserContext,
  ServerUserContextAssignment,
  ServerUserBuiltinDimensions,
  ServerBuiltinDimensionsWrite,
};

// ---------------------------------------------------------------------------
// Convenience aliases — shorter names re-exported from the SDK index
// ---------------------------------------------------------------------------

/** A single placement decision within a server evaluation payload. */
export type ServerPlacementDecision = ServerEvaluationPayloadDecisionsItem;

/** An entitlement check result within a server evaluation payload. */
export type ServerEntitlementResult = ServerEvaluationPayloadEntitlementsValue;

/** User context returned in a server evaluation payload. */
export type ServerUserContext = ServerEvaluationPayloadUserContext;

// ---------------------------------------------------------------------------
// Request types — what the caller passes to the server SDK
// ---------------------------------------------------------------------------

/** A single placement to evaluate on the server. */
export interface ServerPlacementRequest {
  /** Slot identifier for slot-based decisions. */
  slotId?: string;
  /** Entitlement handle for entitlement-gated decisions. */
  entitlementHandle?: string;
  /** Plan handle for plan-specific placements. */
  planHandle?: string;
  /** Placement handle for chained CTA paths. */
  placementHandle?: string;
}

/** Full evaluation request submitted to the server SDK. */
export interface ServerEvaluationRequest {
  /** Authenticated user identifier. */
  userId: string;
  /** Optional anonymous ID for correlation (generated server-side when omitted). */
  anonymousId?: string;
  /** User traits for segmentation/personalization. */
  traits?: Record<string, unknown>; // sdk-ok: boundary-parse — user traits are dynamic key-value pairs
  /** Page context when rendering a specific page server-side. */
  page?: {
    url?: string;
    title?: string;
    tags?: string[];
  };
  /** Placements to evaluate. When omitted, evaluates the bootstrap context. */
  placements?: ServerPlacementRequest[];
  /** Entitlement handles to check. */
  entitlementHandles?: string[];
  /** Current usage balances keyed by entitlement handle. */
  usageBalances?: Record<string, number>;
  /** Whether to include the tenant theme in the payload. */
  includeTheme?: boolean;
  /** Whether to include trial status in the payload. */
  includeTrialStatus?: boolean;
  /** Whether to include full user context (segments, traits, balances). */
  includeUserContext?: boolean;
}

// ---------------------------------------------------------------------------
// Client-session minting (plan 157) — server-only capability
// ---------------------------------------------------------------------------

/**
 * Input for minting a short-lived, per-user client-session token.
 *
 * The customer backend attests the end user, then mints a browser-safe token
 * scoped to exactly that subject. The tenant is derived server-side from the
 * server key ({@link RevTurbineServerOptions.apiKey}) — never from this input.
 */
export interface CreateClientSessionInput {
  /** The end-user subject the token is minted for (opaque to RevTurbine). */
  subject: string;
  /** Optional surface / session scope hint (e.g. a page or feature area). */
  surface?: string;
  /**
   * Client-facing capabilities the token is scoped to. Defaults to
   * `['context:read']` (fetch the user's client-safe context).
   */
  capabilities?: string[];
}

/**
 * Result of minting a client session — a short-lived, opaque browser token.
 *
 * Hand `client_token` to the frontend; it authenticates
 * `GET /api/sdk/client-context`. It carries no user id in the request (the token
 * determines the subject), and expires at `expires_at`.
 */
export interface ClientSessionResult {
  /** The opaque `rt_client_` token to return to the browser. */
  client_token: string;
  /** ISO-8601 timestamp at which the token expires. */
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Seat-type assignment (plan 279 TASK-16a, D-36) — server-only capability
// ---------------------------------------------------------------------------

/**
 * Why a seat-type assignment was refused, derived from the HTTP status of
 * `POST /api/sdk/user-contexts`:
 *
 * - `invalid_request` (400) — malformed body, e.g. an empty user id.
 * - `unauthorized` (401) — missing or invalid credential.
 * - `forbidden` (403) — the credential is not a **server** key. Only a server
 *   key may write a seat assignment (D-36).
 * - `unknown_seat_type` (422) — the handle is not one of the tenant's current
 *   seat types.
 * - `unknown_dimension_value` (422, code `UNKNOWN_DIMENSION_VALUE`) — a
 *   `builtinDimensions` value passed alongside the seat is outside its
 *   dimension's vocabulary (BL-0382).
 * - `request_failed` — any other non-2xx status.
 */
export type SeatAssignmentErrorReason =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'unknown_seat_type'
  | 'unknown_dimension_value'
  | 'request_failed';

/**
 * Options for {@link RevTurbineServer.assignSeatType}: built-in dimension
 * values to write in the SAME server-key upsert as the seat (BL-0382). See
 * {@link SetBuiltinDimensionsOptions} for `override`.
 */
export interface AssignSeatTypeOptions {
  /** Built-in dimension values to set (or clear with `null`) with the seat. */
  builtinDimensions?: ServerBuiltinDimensionsWrite;
  /** Pin the `builtinDimensions` written in this call (D-47). Default `false`. */
  override?: boolean;
}

// ---------------------------------------------------------------------------
// Customer-set built-in dimensions (BL-0382, D-46/D-47) — server-only capability
// ---------------------------------------------------------------------------

/** Options for {@link RevTurbineServer.setBuiltinDimensions}. */
export interface SetBuiltinDimensionsOptions {
  /**
   * `false` (default) — an UPDATE: the value is delivered until a newer
   * RevTurbine enrichment change (Stripe subscription / trial / billing, the
   * activity job, request signals) supersedes it — last writer wins,
   * enrichment included. Writing a pinned dimension without the flag UNPINS it.
   *
   * `true` — an OVERRIDE: the values written in this call are pinned, and
   * RevTurbine enrichment never replaces them until you write that dimension
   * again without the flag, or clear it with `null` (ruling D-47).
   */
  override?: boolean;
}

/**
 * Why a built-in dimension write ({@link RevTurbineServer.setBuiltinDimensions})
 * was refused, derived from the HTTP status of `POST /api/sdk/user-contexts`:
 *
 * - `invalid_request` (400) — malformed body: an empty user id, an empty
 *   dimensions map, `seat_type` (use `assignSeatType`) or an unknown key.
 * - `unauthorized` (401) — missing or invalid credential.
 * - `forbidden` (403) — the credential is not a **server** key.
 * - `unknown_dimension_value` (422) — a value is outside its dimension's
 *   vocabulary.
 * - `request_failed` — any other non-2xx status.
 */
export type DimensionWriteErrorReason =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'unknown_dimension_value'
  | 'request_failed';

// ---------------------------------------------------------------------------
// Server-resolved built-in dimensions (BL-0366) — server-only capability
// ---------------------------------------------------------------------------

/**
 * Why a built-in dimension read was refused, derived from the HTTP status of
 * `GET /api/sdk/user-contexts/{userId}/builtin-dimensions`:
 *
 * - `invalid_request` (400) — e.g. a blank user id.
 * - `unauthorized` (401) — missing or invalid credential.
 * - `forbidden` (403) — the credential is not a **server** key, the request
 *   looked browser-originated, or a tenant header named another tenant.
 * - `request_failed` — any other non-2xx status.
 */
export type BuiltinDimensionsErrorReason =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'request_failed';

// ---------------------------------------------------------------------------
// Server SDK configuration
// ---------------------------------------------------------------------------

/** Options for initializing the RevTurbine server-side SDK. */
export interface RevTurbineServerOptions {
  /** Your RevTurbine tenant identifier. */
  tenantId: string;
  /**
   * Your **server key** — the secret backend credential (`rtk_…`, type
   * `server`, minted under **Settings → API tokens → Server token**).
   *
   * Keep it in server-side configuration only. It is never the browser
   * SDK's `publicKey`, and the control plane refuses it on browser-like
   * requests.
   */
  apiKey: string;
  /** Base URL of the RevTurbine API Edge. */
  endpoint: string;
  /** Default TTL for evaluation payloads (seconds). Default: 60. */
  defaultTtlSeconds?: number;
  /** Custom fetch implementation (e.g. for testing or non-standard runtimes). */
  fetch?: typeof globalThis.fetch;
}
