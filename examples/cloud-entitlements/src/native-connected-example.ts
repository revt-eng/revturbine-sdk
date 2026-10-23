import { initRevTurbine, RuntimeMode, type RevTurbineUserContext } from "@revturbine/sdk/headless";

// Call only AFTER the application has verified and validated its context token.
// This baseline delegates all Playbook delivery to the SDK's built-in provider.
/** Evaluate verified context through the SDK's native hosted Playbook delivery. */
export async function evaluateWithNativeConnectedSdk(
  verifiedUser: RevTurbineUserContext,
  connection: { tenantId: string; apiKey: string; endpoint: string },
) {
  const session = await initRevTurbine({
    ...connection,
    runtimeMode: RuntimeMode.Server,
    user: verifiedUser,
    analytics: false,
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
  });
  try {
    const result = await session.can("data_export");
    if (session.sdk.getPlaybookLoadFailure() || result.reason === "config_unavailable") {
      throw new Error("Playbook unavailable");
    }
    // Native delivery can adopt the API key's tenant; enforce this app's
    // configured scope explicitly before using a decision.
    const playbook = session.sdk.getPlaybook();
    if (!playbook || playbook.tenant_id !== connection.tenantId) {
      throw new Error("Playbook tenant mismatch");
    }
    return result; // The caller gates the operation on result.allowed.
  } finally {
    session.sdk.dispose();
  }
}
