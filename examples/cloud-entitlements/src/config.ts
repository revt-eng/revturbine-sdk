import { createCheckExportHandler } from './check-export';
import { createContextVerifier } from './context-token';
import { createPlaybookCache } from './playbook-cache';

/** Deployment-owned settings. Never populate these from a caller's request. */
export type Environment = Readonly<Record<string, string | undefined>>;
/** A transport adapter calls this handler; it never owns a shared SDK session. */
export type Handler = (request: Request) => Promise<Response>;

/** Reuse immutable Playbooks and public signing keys across warm invocations. */
export function createConfiguredHandler(environment: Environment): Handler {
  function required(name: string): string {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`Missing configuration: ${name}`);
    return value;
  }
  const tenantId = required('REVTURBINE_TENANT_ID');
  const endpoint = environment.REVTURBINE_ENDPOINT ?? 'https://revturbine.com/app';
  const apiKey = required('REVTURBINE_API_KEY');
  const playbooks = createPlaybookCache({ endpoint, apiKey, tenantId,
    environmentId: environment.REVTURBINE_ENVIRONMENT_ID ?? 'production',
    allowedCdnOrigins: required('REVTURBINE_CDN_ORIGINS').split(',').map(value => value.trim()),
  });
  const verifyContext = createContextVerifier({tenantId,
    jwksUrl: required('CONTEXT_JWKS_URL'), issuer: required('CONTEXT_ISSUER'),
    audience: required('CONTEXT_AUDIENCE'),
  });
  return createCheckExportHandler({verifyContext, loadPlaybook: () => playbooks.get(), connection:{endpoint,apiKey}});
}

/** Safe configuration failure response, shared by provider adapters. */
export function unavailable(): Response {
  return Response.json({error:'entitlement_service_unavailable'}, {status:503, headers:{'cache-control':'private, no-store'}});
}

/** Initialize once per warm runtime, after provider secrets are available. */
export function createLazyHandler(readEnvironment: () => Environment): Handler {
  let handle: Handler | undefined;
  return async request => {
    try { handle ??= createConfiguredHandler(readEnvironment()); return await handle(request); }
    catch { return unavailable(); }
  };
}
