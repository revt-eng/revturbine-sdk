/**
 * Local server-side evaluation using core LocalRuntime.
 *
 * Unlike `RevTurbineServer` which calls REST APIs, this module evaluates
 * placement decisions locally using data adapters (static config, Drizzle DB,
 * or API-fetched data). The output is the same `ServerEvaluationPayload`
 * that the client-side SDK expects for hydration.
 *
 * @example
 * ```ts
 * import { createLocalEvaluationServer } from '@revt-eng/server-node/local-server';
 * import { createStaticProviders } from '@revt-eng/core';
 *
 * const server = createLocalEvaluationServer({
 *   tenantId: 'tenant_abc',
 *   providers: createStaticProviders({ exportedConfig }),
 * });
 *
 * const payload = await server.evaluate({
 *   userId: 'user_123',
 *   placements: [{ slotId: 'hero_banner' }],
 * });
 * ```
 */

import {
  LocalRuntime,
} from '@revt-eng/core';
import type {
  AnyDomainProvider,
  RevTurbineStorage,
} from '@revt-eng/core';
import type { RevTurbineConfig } from '@revt-eng/schema';

import type {
  ServerEvaluationPayload,
  ServerEvaluationPayloadDecisionsItem,
  ServerEvaluationPayloadEntitlementsValue,
} from './types';

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface LocalEvaluationServerOptions {
  tenantId: string;
  /** Pre-built domain providers (from createStaticProviders, createDrizzleProviders, etc.) */
  providers: AnyDomainProvider[];
  /** RevTurbineConfig for local placement resolution. */
  exportedConfig?: RevTurbineConfig;
  /** Optional storage for interaction state (defaults to in-memory). */
  storage?: RevTurbineStorage;
  /** Default TTL for evaluation payloads (seconds). Default: 60. */
  defaultTtlSeconds?: number;
}

export interface LocalEvaluationRequest {
  userId: string;
  anonymousId?: string;
  traits?: Record<string, unknown>; // sdk-ok: boundary-parse — user traits are dynamic key-value pairs
  placements?: Array<{
    slotId?: string;
    entitlementHandle?: string;
    planHandle?: string;
    placementHandle?: string;
  }>;
  entitlementHandles?: string[];
  includeTheme?: boolean;
}

export class LocalEvaluationServer {
  private readonly tenantId: string;
  private readonly runtime: LocalRuntime;
  private readonly defaultTtlSeconds: number;

  constructor(options: LocalEvaluationServerOptions) {
    this.tenantId = options.tenantId;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 60;

    if (!options.exportedConfig) {
      throw new Error('LocalEvaluationServer requires exportedConfig');
    }

    this.runtime = new LocalRuntime({
      tenantId: options.tenantId,
      userId: '__server__',
      exportedConfig: options.exportedConfig,
      providers: options.providers,
      storage: options.storage,
    });
  }

  async evaluate(request: LocalEvaluationRequest): Promise<ServerEvaluationPayload> {
    const requestId = generateRequestId();
    const anonymousId = request.anonymousId ?? generateRequestId();

    const decisions: ServerEvaluationPayloadDecisionsItem[] = [];

    for (const placement of request.placements ?? []) {
      const placementId = placement.slotId ?? placement.placementHandle ?? 'unknown';

      const result = await this.runtime.getPlacementDecision({
        placementId,
        userId: request.userId,
        traits: request.traits as Record<string, string | number | boolean> | undefined,
      });

      decisions.push({
        slot_id: placement.slotId,
        entitlement_handle: placement.entitlementHandle,
        plan_handle: placement.planHandle,
        placement_handle: placement.placementHandle,
        visible: result.visible,
        reason_codes: result.reasonCodes,
        output: result.output as ServerEvaluationPayloadDecisionsItem['output'],
      });
    }

    const entitlements: Record<string, ServerEvaluationPayloadEntitlementsValue> = {};
    for (const handle of request.entitlementHandles ?? []) {
      const result = await this.runtime.checkEntitlement(handle);
      entitlements[handle] = {
        status: result.status as ServerEvaluationPayloadEntitlementsValue['status'],
        allowed: result.allowed,
        reason: result.reason,
      };
    }

    const payload: ServerEvaluationPayload = {
      version: '1.0.0',
      request_id: requestId,
      tenant_id: this.tenantId,
      evaluated_at: new Date().toISOString(),
      ttl_seconds: this.defaultTtlSeconds,
      user: {
        id: request.userId,
        anonymous_id: anonymousId,
        traits: request.traits,
      },
      decisions,
    };

    if (Object.keys(entitlements).length > 0) {
      payload.entitlements = entitlements;
    }

    return payload;
  }
}

export function createLocalEvaluationServer(
  options: LocalEvaluationServerOptions,
): LocalEvaluationServer {
  return new LocalEvaluationServer(options);
}
