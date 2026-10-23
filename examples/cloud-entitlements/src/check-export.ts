import { initRevTurbine, RuntimeMode, type Playbook } from "@revturbine/sdk/headless";
import type { VerifiedContext } from "./context-token";
import { HttpError } from "./http-error";

const ENTITLEMENT = "data_export";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", ...headers },
  });
}

/** Authenticate and evaluate one export operation with a disposable user session. */
export function createCheckExportHandler(dependencies: {
  verifyContext: (request: Request) => Promise<VerifiedContext>;
  loadPlaybook: () => Promise<{ playbook: Playbook; sha256: string }>;
  connection: { apiKey: string; endpoint: string };
}) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" }, { Allow: "POST" });
    }

    try {
      // Authentication happens before any Playbook load or entitlement work.
      // UserContext comes entirely from the verified JWT, never request.json().
      const context = await dependencies.verifyContext(request);
      const snapshot = await dependencies.loadPlaybook();
      if (snapshot.playbook.tenant_id !== context.tenantId) {
        throw new HttpError(503, "playbook_tenant_mismatch");
      }
      if (snapshot.playbook.entitlements.find(e => e.unique_handle === ENTITLEMENT)?.type !== "feature") {
        throw new HttpError(503, "expected_boolean_entitlement");
      }

      // Only the immutable Playbook is shared. Identity, usage, and decisions
      // live in a fresh SDK session for this request.
      const session = await initRevTurbine({
        tenantId: context.tenantId,
        environmentId: snapshot.playbook.environment_id,
        ...dependencies.connection,
        runtimeMode: RuntimeMode.Server,
        // Public extension point: this request uses the already-validated
        // snapshot from RevTurbine's connected-mode bootstrap/CDN delivery.
        configProvider: { getPlaybook: () => snapshot.playbook },
        user: context.user,
        analytics: false,
        anonymousTelemetry: false,
        contextPolicy: {
          inferUser: false,
          inferPage: false,
          routerAutoTrack: false,
        },
      });

      try {
        const result = await session.can(ENTITLEMENT);
        if (
          result.reason === "config_unavailable" ||
          result.reason === "entitlement_not_in_playbook" ||
          result.reason === "not_access_entitlement_kind" ||
          result.reason === "unknown_entitlement_kind" ||
          result.reason === "malformed_entitlement_result" ||
          result.reason === "sdk_disabled_provider_failure" ||
          result.reason?.startsWith("provider_")
        ) {
          throw new HttpError(503, "entitlement_configuration_unavailable");
        }
        if (!result.allowed) {
          return json(403, { allowed: false, entitlement: ENTITLEMENT });
        }

        // To protect an actual export, execute it HERE, after checking account
        // membership / resource ownership, within this same trusted handler.
        return json(200, {
          allowed: true,
          entitlement: ENTITLEMENT,
          userId: context.user.id,
          accountId: context.user.account_id,
          playbookVersion: snapshot.playbook.playbook_version_id,
        });
      } finally {
        session.sdk.dispose();
      }
    } catch (error) {
      if (error instanceof HttpError) {
        return json(error.status, { error: error.code });
      }
      // Avoid logging tokens, user context, server keys, or signed CDN URLs.
      console.error("Entitlement evaluation failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return json(503, { error: "entitlement_service_unavailable" });
    }
  };
}
