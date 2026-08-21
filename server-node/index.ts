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
 *   apiKey: process.env.REVTURBINE_SECRET_KEY!,
 *   endpoint: 'https://edge.example.com',
 * });
 *
 * // Hand this to the browser; the client SDK re-mints on expiry.
 * const { token } = await server.createClientSession({ userId: 'user_123' });
 * ```
 */
export { RevTurbineServer, RevTurbineClientSessionError } from './client';
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
} from './types';

// Local evaluation using core DecisionEngine
export { LocalEvaluationServer, createLocalEvaluationServer } from './local-server';
export type { LocalEvaluationServerOptions, LocalEvaluationRequest } from './local-server';

// Re-export core adapters for server-side usage
export {
  LocalRuntime,
  createStaticProviders,
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
