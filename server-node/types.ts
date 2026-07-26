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
} from '@revt-eng/schema';

export type {
  PlacementDecisionOutput,
  ServerEvaluationPayload,
  ServerEvaluationPayloadDecisionsItem,
  ServerEvaluationPayloadEntitlementsValue,
  ServerEvaluationPayloadTrialStatus,
  ServerEvaluationPayloadUser,
  ServerEvaluationPayloadUserContext,
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
 * scoped to exactly that subject. Tenant / application / environment are derived
 * server-side from the mint secret — never from this input.
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
// Server SDK configuration
// ---------------------------------------------------------------------------

/** Options for initializing the RevTurbine server-side SDK. */
export interface RevTurbineServerOptions {
  /** Your RevTurbine tenant identifier. */
  tenantId: string;
  /** Server-side API key (should be a secret key, not a publishable key). */
  apiKey: string;
  /** Base URL of the RevTurbine API Edge. */
  endpoint: string;
  /** Default TTL for evaluation payloads (seconds). Default: 60. */
  defaultTtlSeconds?: number;
  /** Custom fetch implementation (e.g. for testing or non-standard runtimes). */
  fetch?: typeof globalThis.fetch;
}
