/**
 * @module @revt-eng/web-sdk/server
 *
 * Server-side entitlement and placement decisions for React Server Components
 * (plan 186 TASK-3).
 *
 * A React hook cannot run in a Server Component: every module under `react/`
 * opens with `'use client'`, so importing one from the server graph yields an
 * opaque client reference rather than a callable. This module is the server
 * half — the same decisions, awaited instead of subscribed to.
 *
 * ```tsx
 * // app/page.tsx — a Server Component, no 'use client'
 * const rt = createServerClient({ tenantId, playbook });
 * const { denied } = await getEntitlement(rt, 'brand_kit', { user: { id: userId } });
 * return denied ? <UpgradePrompt /> : <BrandKitEditor />;
 * ```
 *
 * Three properties are deliberate and load-bearing:
 *
 * - **Local by default.** An RSC tree re-renders per request, so a network hop
 *   per decision is a latency tax the client SDK never paid. With a `playbook`
 *   the decision resolves in-process and keeps working when the control plane
 *   is unreachable. Remote is available by explicit configuration.
 * - **Fail closed.** Any evaluation failure resolves denied / not-visible and
 *   never throws into the render tree — a control-plane outage must not turn
 *   into an error boundary, and must never accidentally grant paid access.
 * - **No lifecycle fields.** The returned {@link EntitlementView} carries no
 *   `isLoading` and no `recheck`: the value is awaited, so it is always
 *   decided and there is nothing to re-run mid-render. Synthesizing them would
 *   be a lie the type system then endorses.
 *
 * The credential passed here — a long-lived `server` api-token — must never
 * reach the browser. It is accepted only by {@link createServerClient}, is
 * never placed on a returned value, and never appears in the hydration payload
 * handed to `RevTurbineProvider`.
 *
 * Plan: docs/dev-lifecycle/inprogress/186-server-rendering-sdk-and-api-token-management.md
 */

import { LocalRuntime, createStaticProviders } from '@revt-eng/core';
import { RevTurbineServer } from '../../server-node';
import { entitlementResultDenies } from '../controllers';
import { configArtifactForRuntime, type ConfigArtifact } from '../config-artifact';
import type { EntitlementView, PlacementView } from '../views';
import type {
  EntitlementResult,
  RevTurbineEntitlementContext,
  PlacementOutput,
} from '../customer-side';

/**
 * The end user a server-side decision is evaluated for.
 *
 * There is no ambient user on the server — a Server Component has no provider
 * to read from — so the caller states it explicitly. Plan 186 TASK-4 adds an
 * optional request-scoped form that supplies this implicitly.
 */
export interface ServerUser {
  /** The end-user identifier decisions are evaluated for. */
  id: string;
  /** The user's current plan handle, used to resolve entitlement rules. */
  planHandle?: string;
  /** Targeting traits for segment evaluation. */
  traits?: Record<string, string | number | boolean>;
}

/** How a {@link RevTurbineServerClient} reaches its decisions. */
export type ServerTransport = 'local' | 'remote';

/**
 * Configuration for {@link createServerClient}.
 *
 * Supply a `playbook` for local mode (the default). Supply `endpoint` +
 * `apiToken` for remote mode, which is selected automatically when no playbook
 * is present and can be forced with `transport: 'remote'`.
 */
export interface ServerClientOptions {
  /** Tenant the decisions belong to. */
  tenantId: string;
  /**
   * The bundled Playbook. Its presence selects local mode, where decisions
   * resolve in-process with no network call.
   */
  playbook?: ConfigArtifact;
  /** Target environment for Playbooks that predate environment stamping. */
  environmentId?: string;
  /**
   * A long-lived `server` api-token, for remote mode.
   *
   * Server-only. Never return it to the browser, never place it in props, and
   * never embed it in a hydration payload.
   */
  apiToken?: string;
  /** Control-plane origin, for remote mode. */
  endpoint?: string;
  /** Force a transport. Defaults to `'local'` whenever a `playbook` is given. */
  transport?: ServerTransport;
}

/** A denied decision — the fail-closed result for any evaluation failure. */
const DENIED: EntitlementView = {
  result: null,
  allowed: false,
  limited: false,
  denied: true,
  gatedPlacement: null,
};

function hidden(placementId: string): PlacementView {
  return { placementId, visible: false, decision: null, content: null };
}

/**
 * Project an evaluator result onto the shared {@link EntitlementView}.
 *
 * `denied` intentionally is not `!allowed`. A blocking at-cap limit resolves
 * `{ status: 'limited', allowed: false }`, so both sides route through
 * `entitlementResultDenies` — the same helper the client `EntitlementGate`
 * uses — rather than re-deriving the rule and drifting from it.
 */
function toEntitlementView(
  result: EntitlementResult | null,
  gatedPlacement: PlacementOutput | null = null,
): EntitlementView {
  if (result === null) return DENIED;
  return {
    result,
    allowed: result.status === 'allowed',
    limited: result.status === 'limited',
    denied: entitlementResultDenies(result),
    gatedPlacement,
  };
}

/**
 * A server-side decision client.
 *
 * Create one per process (or per request) with {@link createServerClient} and
 * pass it to {@link getEntitlement} / {@link getPlacement}. Holds no per-user
 * state, so it is safe to share across concurrent requests.
 */
export class RevTurbineServerClient {
  /** Tenant the decisions belong to. */
  readonly tenantId: string;
  /** How this client reaches its decisions. */
  readonly transport: ServerTransport;

  // ES #private, not TypeScript `private`. The distinction is a security
  // boundary here, not a style choice: TS `private` is erased at compile time,
  // so the field stays enumerable and `JSON.stringify(client)` emits the
  // api-token verbatim. An RSC that passed a client into a client component
  // would then serialize the credential straight into the browser payload.
  // `#` fields are invisible to JSON.stringify, Object.keys, and spread.
  readonly #playbook?: ConfigArtifact;
  readonly #environmentId: string;
  readonly #remote?: RevTurbineServer;

  constructor(options: ServerClientOptions) {
    this.tenantId = options.tenantId;
    this.#environmentId = options.environmentId ?? 'default';
    this.#playbook = options.playbook;
    this.transport = options.transport ?? (options.playbook ? 'local' : 'remote');

    if (this.transport === 'local' && !options.playbook) {
      throw new Error(
        '[RevTurbine] createServerClient: local transport requires a `playbook`. ' +
          'Pass one, or configure `endpoint` + `apiToken` for remote mode.',
      );
    }
    if (this.transport === 'remote') {
      if (!options.endpoint || !options.apiToken) {
        throw new Error(
          '[RevTurbine] createServerClient: remote transport requires both `endpoint` and `apiToken`.',
        );
      }
      this.#remote = new RevTurbineServer({
        tenantId: options.tenantId,
        apiKey: options.apiToken,
        endpoint: options.endpoint,
      });
    }
  }

  /**
   * A runtime bound to one user.
   *
   * Built per call rather than once per client: `LocalRuntime` takes its
   * `userId` at construction and `createStaticProviders` resolves entitlement
   * rules against a specific `planHandle`, so a shared instance would evaluate
   * every request against whichever user built it. (This is also why the
   * existing `LocalEvaluationServer`, whose runtime is constructed once with
   * `userId: '__server__'`, cannot answer a per-user entitlement question.)
   * Plan 186 TASK-4 memoizes this per request via React `cache()`.
   */
  private runtimeFor(user: ServerUser): LocalRuntime {
    const config = configArtifactForRuntime(this.#playbook, 'createServerClient.playbook', {
      tenantId: this.tenantId,
      environmentId: this.#environmentId,
    });
    if (!config) throw new Error('[RevTurbine] server client has no resolvable Playbook');

    return new LocalRuntime({
      tenantId: this.tenantId,
      userId: user.id,
      exportedConfig: config,
      providers: createStaticProviders({ config, planHandle: user.planHandle }),
    });
  }

  /** @internal Resolve one entitlement, fail-closed. */
  async _entitlement(
    handle: string,
    user: ServerUser,
    context?: RevTurbineEntitlementContext,
  ): Promise<EntitlementView> {
    try {
      if (this.transport === 'remote') {
        const result = await this.#remote!.checkEntitlement(user.id, handle, context);
        return toEntitlementView(result as EntitlementResult);
      }
      return toEntitlementView(await this.runtimeFor(user).checkEntitlement(handle, context));
    } catch {
      return DENIED;
    }
  }

  /** @internal Resolve one placement, fail-closed. */
  async _placement(placementId: string, user: ServerUser): Promise<PlacementView> {
    try {
      if (this.transport === 'remote') {
        const item = await this.#remote!.getPlacement(user.id, { slotId: placementId }, user.traits);
        return {
          placementId,
          visible: item.visible ?? false,
          decision: null,
          content: null,
        };
      }
      const decision = await this.runtimeFor(user).getPlacementDecision({
        placementId,
        userId: user.id,
        traits: user.traits,
      });
      return {
        placementId,
        visible: decision.visible,
        decision,
        content: decision.content ?? null,
      };
    } catch {
      return hidden(placementId);
    }
  }
}

/**
 * Create a server-side decision client.
 *
 * @param options - Transport and tenant configuration. A `playbook` selects
 * local mode; `endpoint` + `apiToken` select remote.
 *
 * @example
 * ```ts
 * import playbook from '../revturbine.playbook.json';
 * export const rt = createServerClient({ tenantId: 'tn_acme', playbook });
 * ```
 */
export function createServerClient(options: ServerClientOptions): RevTurbineServerClient {
  return new RevTurbineServerClient(options);
}

/**
 * Resolve one entitlement for one user, from a Server Component.
 *
 * Never throws: an evaluation failure resolves denied, so a control-plane
 * outage cannot become an error boundary and cannot accidentally grant access.
 *
 * Gate paid UI on `denied` rather than on `!allowed` — a `limited` result still
 * grants access when the evaluator permits it.
 *
 * @param client - From {@link createServerClient}.
 * @param handle - The entitlement handle, e.g. `'brand_kit'`.
 * @param input - The user to evaluate for, and optional usage context.
 *
 * @example
 * ```tsx
 * const { denied } = await getEntitlement(rt, 'brand_kit', { user: { id: userId } });
 * if (denied) return <UpgradePrompt />;
 * ```
 */
export function getEntitlement(
  client: RevTurbineServerClient,
  handle: string,
  input: { user: ServerUser; context?: RevTurbineEntitlementContext },
): Promise<EntitlementView> {
  return client._entitlement(handle, input.user, input.context);
}

/**
 * Resolve one placement decision for one user, from a Server Component.
 *
 * Never throws: an evaluation failure resolves not-visible, so a failed
 * decision hides the surface rather than breaking the page.
 *
 * The result carries no interaction callbacks — `dismiss`, `ctaClick` and
 * viewport exposure are inherently client-side. Render the decision on the
 * server and let a client component own the interactions.
 *
 * @param client - From {@link createServerClient}.
 * @param input - The placement to resolve and the user to resolve it for.
 */
export function getPlacement(
  client: RevTurbineServerClient,
  input: { placementId: string; user: ServerUser },
): Promise<PlacementView> {
  return client._placement(input.placementId, input.user);
}
