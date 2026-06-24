/**
 * @module @revt-eng/sdk/server-node
 *
 * Server-side evaluation SDK for RevTurbine.
 *
 * Use `RevTurbineServer` to pre-evaluate placement decisions, entitlements,
 * and user context on the server. The resulting `ServerEvaluationPayload`
 * can be serialized into your page props and consumed by the client-side SDK
 * via `sdk.hydrate(payload)`.
 *
 * @example
 * ```ts
 * import { RevTurbineServer } from '@revt-eng/sdk/server';
 *
 * const server = new RevTurbineServer({
 *   tenantId: 'tenant_abc',
 *   apiKey: process.env.REVTURBINE_SECRET_KEY!,
 *   endpoint: 'https://api.revturbine.io',
 * });
 *
 * const payload = await server.evaluate({
 *   userId: 'user_123',
 *   traits: { plan: 'pro' },
 *   placements: [{ slotId: 'hero_banner' }],
 *   includeTheme: true,
 * });
 * ```
 */
export { RevTurbineServer } from './client';
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
export {
  createApiProviders,
} from '../web-sdk/adapters/api';
export type {
  ApiAdapterOptions,
} from '../web-sdk/adapters/api';
export type {
  LocalRuntimeOptions,
  AdapterBaseOptions,
  CreateProvidersResult,
  RevTurbineStorage,
} from '@revt-eng/core';
