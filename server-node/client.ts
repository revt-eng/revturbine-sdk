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
 *   endpoint: 'https://api.revturbine.io',
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
   * Evaluate placement decisions, entitlements, and context for a user.
   *
   * Returns a `ServerEvaluationPayload` that can be serialized and sent
   * to the client for hydration.
   */
  async evaluate(request: ServerEvaluationRequest): Promise<ServerEvaluationPayload> {
    const requestId = generateRequestId();
    const anonymousId = request.anonymousId ?? generateRequestId();

    const [decisions, entitlements, trialStatus, userContext, theme] = await Promise.all([
      this.evaluatePlacements(requestId, request),
      this.evaluateEntitlements(requestId, request),
      request.includeTrialStatus ? this.fetchTrialStatus(requestId, request.userId) : Promise.resolve(undefined),
      request.includeUserContext ? this.fetchUserContext(requestId, request.userId) : Promise.resolve(undefined),
      request.includeTheme ? this.fetchTheme(requestId) : Promise.resolve(undefined),
    ]);

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

    if (entitlements && Object.keys(entitlements).length > 0) {
      payload.entitlements = entitlements;
    }
    if (trialStatus) {
      payload.trial_status = trialStatus;
    }
    if (userContext) {
      payload.user_context = userContext;
    }
    if (theme) {
      payload.theme = theme;
    }

    return payload;
  }

  /**
   * Evaluate a single placement.
   */
  async getPlacement(
    userId: string,
    placement: ServerPlacementRequest,
    traits?: Record<string, unknown>, // sdk-ok: boundary-parse — user traits are dynamic key-value pairs
  ): Promise<ServerEvaluationPayloadDecisionsItem> {
    const requestId = generateRequestId();
    const body = {
      request_id: requestId,
      user_id: userId,
      traits: traits ?? {},
      slot_id: placement.slotId,
      entitlement_handle: placement.entitlementHandle,
      plan_handle: placement.planHandle,
      placement_handle: placement.placementHandle,
    };

    try {
      const response = await this.apiCall(requestId, '/api/decision-api/v1/decide-context', body);

      if (!response.ok) {
        return {
          slot_id: placement.slotId,
          entitlement_handle: placement.entitlementHandle,
          plan_handle: placement.planHandle,
          placement_handle: placement.placementHandle,
          visible: false,
          reason_codes: ['api_error'],
        };
      }

      const data = await response.json() as {
        request_id: string;
        reason_codes?: string[];
        decision?: {
          decision_id?: string;
          decision_type?: string;
          visible?: boolean;
          content?: Record<string, unknown>; // sdk-ok: boundary-parse — API response shape
          [key: string]: unknown; // sdk-ok: boundary-parse — API response shape
        };
      };

      const decision = data.decision;
      const visible = decision?.visible ?? false;

      const result: ServerEvaluationPayloadDecisionsItem = {
        slot_id: placement.slotId,
        entitlement_handle: placement.entitlementHandle,
        plan_handle: placement.planHandle,
        placement_handle: placement.placementHandle,
        visible,
      };
      if (visible && decision) {
        result.output = decision as unknown as PlacementDecisionOutput; // sdk-ok: boundary-parse — narrowing API response to schema output
      }
      if (data.reason_codes) {
        result.reason_codes = data.reason_codes;
      }
      return result;
    } catch {
      return {
        slot_id: placement.slotId,
        entitlement_handle: placement.entitlementHandle,
        plan_handle: placement.planHandle,
        placement_handle: placement.placementHandle,
        visible: false,
        reason_codes: ['network_error'],
      };
    }
  }

  /**
   * Check a single entitlement for a user.
   */
  async checkEntitlement(
    userId: string,
    handle: string,
    context?: { used?: number; balance?: number; requiredTier?: string },
  ): Promise<ServerEvaluationPayloadEntitlementsValue> {
    const requestId = generateRequestId();
    const body = {
      request_id: requestId,
      user_id: userId,
      entitlement_handle: handle,
      ...(context ?? {}),
    };

    try {
      const response = await this.apiCall(requestId, '/api/decision-api/v1/check-entitlement', body);

      if (!response.ok) {
        return { status: 'denied', allowed: false, reason: 'api_error' };
      }

      const data = await response.json() as {
        status?: 'allowed' | 'limited' | 'denied';
        allowed?: boolean;
        reason?: string;
        current_tier?: string;
      };
      return {
        status: data.status ?? 'denied',
        allowed: data.allowed ?? false,
        reason: data.reason,
        current_tier: data.current_tier,
      };
    } catch {
      return { status: 'denied', allowed: false, reason: 'network_error' };
    }
  }

  /**
   * Fetch trial status for a user.
   */
  async getTrialStatus(userId: string): Promise<ServerEvaluationPayloadTrialStatus> {
    const requestId = generateRequestId();
    return this.fetchTrialStatus(requestId, userId);
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

  private async evaluatePlacements(
    requestId: string,
    request: ServerEvaluationRequest,
  ): Promise<ServerEvaluationPayloadDecisionsItem[]> {
    const placements = request.placements ?? [];
    if (placements.length === 0) return [];

    // Use bootstrap-context for batch evaluation when multiple placements
    if (placements.length > 1) {
      return this.evaluatePlacementsBatch(requestId, request, placements);
    }

    // Single placement — use decide-context
    const result = await this.getPlacement(request.userId, placements[0], request.traits);
    return [result];
  }

  private async evaluatePlacementsBatch(
    requestId: string,
    request: ServerEvaluationRequest,
    placements: ServerPlacementRequest[],
  ): Promise<ServerEvaluationPayloadDecisionsItem[]> {
    const body = {
      request_id: requestId,
      user_id: request.userId,
      traits: request.traits ?? {},
      usage_balances: request.usageBalances ?? {},
      page: request.page ?? {},
      placements: placements.map((p) => ({
        slot_id: p.slotId,
        entitlement_handle: p.entitlementHandle,
        plan_handle: p.planHandle,
        placement_handle: p.placementHandle,
      })),
    };

    try {
      const response = await this.apiCall(requestId, '/api/decision-api/v1/bootstrap-context', body);

      if (!response.ok) {
        return placements.map((p) => ({
          slot_id: p.slotId,
          entitlement_handle: p.entitlementHandle,
          plan_handle: p.planHandle,
          placement_handle: p.placementHandle,
          visible: false,
          reason_codes: ['api_error'],
        }));
      }

      const data = await response.json() as {
        request_id: string;
        user_id: string;
        decisions: Array<{
          placement_id: string;
          result: {
            request_id: string;
            reason_codes?: string[];
            decision?: {
              visible?: boolean;
              [key: string]: unknown; // sdk-ok: boundary-parse — API response shape
            };
          };
        }>;
      };

      return data.decisions.map((d, index) => {
        const original = placements[index] ?? {};
        const visible = d.result.decision?.visible ?? false;
        const entry: ServerEvaluationPayloadDecisionsItem = {
          slot_id: original.slotId,
          entitlement_handle: original.entitlementHandle,
          plan_handle: original.planHandle,
          placement_handle: original.placementHandle,
          visible,
        };
        if (visible && d.result.decision) {
          entry.output = d.result.decision as unknown as PlacementDecisionOutput; // sdk-ok: boundary-parse — narrowing API response to schema output
        }
        if (d.result.reason_codes) {
          entry.reason_codes = d.result.reason_codes;
        }
        return entry;
      });
    } catch {
      return placements.map((p) => ({
        slot_id: p.slotId,
        entitlement_handle: p.entitlementHandle,
        plan_handle: p.planHandle,
        placement_handle: p.placementHandle,
        visible: false,
        reason_codes: ['network_error'],
      }));
    }
  }

  private async evaluateEntitlements(
    _requestId: string,
    request: ServerEvaluationRequest,
  ): Promise<Record<string, ServerEvaluationPayloadEntitlementsValue> | undefined> {
    const handles = request.entitlementHandles ?? [];
    if (handles.length === 0) return undefined;

    const results: Record<string, ServerEvaluationPayloadEntitlementsValue> = {};
    const settled = await Promise.allSettled(
      handles.map(async (handle) => {
        const result = await this.checkEntitlement(request.userId, handle);
        return { handle, result };
      }),
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results[outcome.value.handle] = outcome.value.result;
      }
    }

    return results;
  }

  private async fetchTrialStatus(requestId: string, userId: string): Promise<ServerEvaluationPayloadTrialStatus> {
    try {
      const response = await this.apiCall(requestId, '/api/decision-api/v1/trial-status', {
        request_id: requestId,
        user_id: userId,
      });

      if (!response.ok) return { in_trial: false };

      // Plan 43 TASK-8: read every trial field the scaffold's
      // UserTrialStatus declares. The `state` field is omitted by
      // ServerEvaluationPayloadTrialStatusSchema (pre-existing
      // scaffold quirk to be revisited in a follow-up), but we
      // include it defensively here — if the API serves it, the
      // SDK PlanProvider plumbing can gate trial_ended /
      // trial_converted placements correctly.
      const data = await response.json() as {
        in_trial?: boolean;
        trial_type?: 'free' | 'reverse';
        plan_handle?: string;
        state?: 'active' | 'running_out' | 'expired' | 'converted' | 'none';
        trial_limit_type?: 'time' | 'usage';
        progress_percent?: number;
        day_number?: number;
        days_remaining?: number;
        usage_entitlement_handle?: string;
        usage_consumed?: number;
        usage_remaining?: number;
        usage_limit?: number;
      };

      return {
        in_trial: data.in_trial ?? false,
        ...(data.trial_type !== undefined ? { trial_type: data.trial_type } : {}),
        ...(data.plan_handle !== undefined ? { plan_handle: data.plan_handle } : {}),
        ...(data.trial_limit_type !== undefined ? { trial_limit_type: data.trial_limit_type } : {}),
        ...(data.progress_percent !== undefined ? { progress_percent: data.progress_percent } : {}),
        ...(data.day_number !== undefined ? { day_number: data.day_number } : {}),
        ...(data.days_remaining !== undefined ? { days_remaining: data.days_remaining } : {}),
        ...(data.usage_entitlement_handle !== undefined ? { usage_entitlement_handle: data.usage_entitlement_handle } : {}),
        ...(data.usage_consumed !== undefined ? { usage_consumed: data.usage_consumed } : {}),
        ...(data.usage_remaining !== undefined ? { usage_remaining: data.usage_remaining } : {}),
        ...(data.usage_limit !== undefined ? { usage_limit: data.usage_limit } : {}),
      };
    } catch {
      return { in_trial: false };
    }
  }

  private async fetchUserContext(requestId: string, userId: string): Promise<ServerEvaluationPayloadUserContext | undefined> {
    try {
      const response = await this.apiCall(requestId, '/api/decision-api/v1/user-context', {
        request_id: requestId,
        user_id: userId,
      });

      if (!response.ok) return undefined;

      const data = await response.json() as {
        segments?: string[];
        traits?: Record<string, unknown>; // sdk-ok: boundary-parse — API response user traits
        usage_balances?: Record<string, number>;
      };

      return {
        segments: data.segments,
        traits: data.traits,
        usage_balances: data.usage_balances,
      };
    } catch {
      return undefined;
    }
  }

  private async fetchTheme(requestId: string): Promise<Record<string, unknown> | undefined> { // sdk-ok: boundary-parse — theme is opaque JSON from API
    try {
      const response = await this.apiGet(requestId, '/api/sdk/theme');
      if (!response.ok) return undefined;

      const data = await response.json();
      if (typeof data !== 'object' || data === null) return undefined;
      return data as Record<string, unknown>; // sdk-ok: boundary-parse — narrowing API response
    } catch {
      return undefined;
    }
  }
}
