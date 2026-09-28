/**
 * @module @revt-eng/sdk/server-node
 *
 * Server-side support for RevTurbine on Node.
 *
 * **Evaluation does not happen here.** It is a pure function of
 * (UserContext, Playbook) and runs in the customer SDKs — there is no hosted
 * decision endpoint (plan 192). For local server-side evaluation use
 * `LocalEvaluationServer`, which fetches a Playbook and evaluates in-process.
 *
 * `RevTurbineServer` is now a **client-session minter**: it exchanges your
 * secret key for a short-lived, browser-safe `rt_client_` token that the
 * client SDK's `clientSession` callback consumes to ingest server-derived
 * plan, trial, and payment state.
 *
 * Its decision methods — `evaluate`, `getPlacement`, `checkEntitlement`,
 * `getTrialStatus` — were REMOVED in plan 194 TASK-9. Every one of them
 * called an endpoint plan 192 deleted, so each had been returning a network
 * error since that shipped.
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
 * // Hand this to the browser; the client SDK re-mints on expiry.
 * const { client_token } = await server.createClientSession({ subject: 'user_123' });
 *
 * // Server-only user state (D-36): assign a seat type, or clear it with null.
 * await server.assignSeatType('user_123', 'admin');
 *
 * // Built-in dimension values from your backend (BL-0382): an update that newer
 * // RevTurbine enrichment may supersede, or pinned with { override: true }.
 * await server.setBuiltinDimensions('user_123', { subscription_state: 'paid' }, { override: true });
 *
 * // The control plane's built-in dimensions for local evaluation (BL-0366):
 * // overlaid on the app's own values, the server value wins (PD-3).
 * const { builtin_dimensions } = await server.getBuiltinDimensions('user_123');
 * createStaticProviders({ config: playbook, userContext, serverBuiltinDimensions: builtin_dimensions });
 * ```
 */
export {
  RevTurbineServer,
  RevTurbineClientSessionError,
  RevTurbineSeatAssignmentError,
  RevTurbineDimensionWriteError,
  RevTurbineBuiltinDimensionsError,
} from './client';
export type {
  RevTurbineServerOptions,
  ServerEvaluationPayload,
  ServerEvaluationPayloadDecisionsItem,
  ServerEvaluationPayloadEntitlementsValue,
  ServerEvaluationPayloadTrialStatus,
  ServerEvaluationPayloadUser,
  ServerEvaluationPayloadUserContext,
  ServerEvaluationRequest,
  ServerPlacementRequest,
  ServerPlacementDecision,
  ServerEntitlementResult,
  ServerUserContext,
  CreateClientSessionInput,
  ClientSessionResult,
  SeatAssignmentErrorReason,
  AssignSeatTypeOptions,
  ServerUserContextAssignment,
  ServerBuiltinDimensionsWrite,
  SetBuiltinDimensionsOptions,
  DimensionWriteErrorReason,
  BuiltinDimensionsErrorReason,
  ServerUserBuiltinDimensions,
} from './types';

// Local evaluation using core DecisionEngine
export { LocalEvaluationServer, createLocalEvaluationServer } from './local-server';
export type { LocalEvaluationServerOptions, LocalEvaluationRequest } from './local-server';

// Re-export core adapters for server-side usage
export {
  LocalRuntime,
  createStaticProviders,
  applyServerBuiltinDimensions,
  createHydrationProviders,
  DecisionEngine,
  DomainProviderRegistry,
  InteractionTracker,
  CapEnforcer,
  InMemoryStorage,
} from '@revt-eng/core';
export type {
  LocalRuntimeOptions,
  AdapterBaseOptions,
  CreateProvidersResult,
  RevTurbineStorage,
} from '@revt-eng/core';
