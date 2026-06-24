/**
 * API adapter — creates domain providers that fetch data from the RevTurbine REST API.
 *
 * Works everywhere with `fetch` (Node 18+, edge runtimes, browsers).
 * This adapter lives in the SDK (not core) because core is pure in-memory
 * evaluation with no network dependencies.
 */

import type {
  AnyDomainProvider,
  ContentProviderState,
  EntitlementProviderState,
  PlanProviderState,
  RuleProviderState,
  SegmentProviderState,
  ThemeProviderState,
  EntitlementRuleSnapshot,
  AdapterBaseOptions,
} from '@revt-eng/core';

/**
 * Entitlement-rule target, derived from the canonical snapshot contract
 * itself (not a separately-imported name) so it can never drift from
 * `EntitlementRuleSnapshot.targets`.
 */
type RuleTargetSnapshot = NonNullable<EntitlementRuleSnapshot['targets']>[number];
import type { EntitlementResult } from '@revt-eng/core';

/** Options for the API-backed adapter. */
export interface ApiAdapterOptions extends AdapterBaseOptions {
  baseUrl: string;
  token?: string;
  tenantId: string;
  userId?: string;
  headers?: Record<string, string>;
}

/**
 * Create domain providers that fetch from the RevTurbine REST API.
 *
 * Returns providers for: plan, entitlements, segments, rules, content, theme.
 * Each provider's `resolve()` makes a `fetch()` call to the appropriate endpoint.
 */
export function createApiProviders(options: ApiAdapterOptions): AnyDomainProvider[] {
  const { baseUrl, token, tenantId, userId, cacheTtlMs, headers: extraHeaders } = options;
  const providers: AnyDomainProvider[] = [];

  function buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      ...extraHeaders,
    };
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  async function apiFetch<T>(path: string, body?: unknown): Promise<T | null> { // sdk-ok: boundary-parse
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: buildHeaders(),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) return null;
      return await response.json() as T;
    } catch {
      return null;
    }
  }

  // Plan provider
  const planProvider: AnyDomainProvider = {
    domain: 'plan' as const,
    cacheTtlMs,
    resolve: async (): Promise<PlanProviderState> => {
      if (!userId) {
        return { currentPlanHandle: 'unknown' };
      }
      const data = await apiFetch<{
        plan_handle?: string;
        plan_name?: string;
        billing_period?: string;
        trial_active?: boolean;
        trial_days_remaining?: number;
      }>('/api/sdk/user-context', { user_id: userId, tenant_id: tenantId });

      return {
        currentPlanHandle: data?.plan_handle ?? 'unknown',
        currentPlanName: data?.plan_name,
        billingPeriod: data?.billing_period as PlanProviderState['billingPeriod'],
        trialActive: data?.trial_active,
        trialDaysRemaining: data?.trial_days_remaining,
      };
    },
  };
  providers.push(planProvider);

  // Entitlements provider
  const entitlementProvider: AnyDomainProvider = {
    domain: 'entitlements' as const,
    cacheTtlMs,
    resolve: async (): Promise<EntitlementProviderState> => {
      if (!userId) {
        return { entries: {} };
      }
      const data = await apiFetch<{
        entitlements?: Record<string, EntitlementResult>;
        usage?: Record<string, { used: number; limit: number; remaining: number }>;
      }>('/api/sdk/bootstrap-context', { user_id: userId, tenant_id: tenantId });

      return {
        entries: data?.entitlements ?? {},
        usage: data?.usage,
      };
    },
  };
  providers.push(entitlementProvider);

  // Segments provider
  const segmentProvider: AnyDomainProvider = {
    domain: 'segments' as const,
    cacheTtlMs,
    resolve: async (): Promise<SegmentProviderState> => {
      if (!userId) {
        return { segmentIds: [] };
      }
      const data = await apiFetch<{
        segment_ids?: string[];
      }>('/api/sdk/user-context', { user_id: userId, tenant_id: tenantId });

      return {
        segmentIds: data?.segment_ids ?? [],
      };
    },
  };
  providers.push(segmentProvider);

  // Rules provider
  const rulesProvider: AnyDomainProvider = {
    domain: 'rules' as const,
    cacheTtlMs,
    resolve: async (): Promise<RuleProviderState> => {
      const data = await apiFetch<{
        entitlement_rules?: Array<{
          id: string;
          entitlement_id: string;
          // Canonical (plan 32 `targets.min(1)`). `plan_ids` is the
          // pre-plan-32 legacy shape — still accepted from control planes
          // not yet upgraded (REQ-6 back-compat), normalized below.
          targets?: Array<{ kind: RuleTargetSnapshot['kind']; id: string }>;
          plan_ids?: string[];
          segment_ids?: string[];
          type_fields?: Record<string, unknown>; // sdk-ok: boundary-parse
        }>;
        version?: string;
      }>('/api/sdk/config');

      const entitlementRules: Record<string, EntitlementRuleSnapshot[]> = {};
      for (const rule of data?.entitlement_rules ?? []) {
        const entId = rule.entitlement_id;
        if (!entitlementRules[entId]) entitlementRules[entId] = [];
        // Prefer canonical kind-discriminated `targets`; normalize legacy
        // `plan_ids` → plan targets (REQ-6 back-compat for control planes
        // not yet on plan 32). Pass the full `targets[]` so the evaluator
        // matches plan_variation / addon kinds (parity with the scaffold
        // rules.ts evaluator), and derive `planIds` from plan-kind targets
        // for the snapshot's legacy plan-id path.
        const targets: RuleTargetSnapshot[] = Array.isArray(rule.targets)
          ? rule.targets
          : Array.isArray(rule.plan_ids)
            ? rule.plan_ids.map((id) => ({ kind: 'plan' as const, id }))
            : [];
        entitlementRules[entId].push({
          ruleId: rule.id,
          entitlementId: entId,
          planIds: targets.filter((t) => t.kind === 'plan').map((t) => t.id),
          targets,
          segmentIds: Array.isArray(rule.segment_ids) ? rule.segment_ids : [],
          kind: (rule.type_fields?.kind as EntitlementRuleSnapshot['kind']) ?? 'feature',
          fields: rule.type_fields ?? {},
        });
      }

      return {
        entitlementRules,
        configVersion: data?.version ?? 'unknown',
      };
    },
  };
  providers.push(rulesProvider);

  // Content provider
  const contentProvider: AnyDomainProvider = {
    domain: 'content' as const,
    cacheTtlMs,
    resolve: async (): Promise<ContentProviderState> => {
      const data = await apiFetch<{
        message_blocks?: Array<{
          block_id: string;
          name: string;
          default_content: Record<string, unknown>; // sdk-ok: boundary-parse
          status: string;
        }>;
      }>('/api/sdk/config');

      const messageBlocks: ContentProviderState['messageBlocks'] = {};
      for (const block of data?.message_blocks ?? []) {
        messageBlocks[block.block_id] = {
          blockId: block.block_id,
          name: block.name,
          defaultContent: block.default_content,
          status: block.status as 'draft' | 'active' | 'archived',
        };
      }

      return {
        messageBlocks,
        personalization: {},
      };
    },
  };
  providers.push(contentProvider);

  // Theme provider
  const themeProvider: AnyDomainProvider = {
    domain: 'theme' as const,
    cacheTtlMs,
    resolve: async (): Promise<ThemeProviderState> => {
      const data = await apiFetch<Record<string, unknown>>('/api/sdk/theme'); // sdk-ok: boundary-parse
      return { overrides: data ?? {} };
    },
  };
  providers.push(themeProvider);

  return providers;
}
