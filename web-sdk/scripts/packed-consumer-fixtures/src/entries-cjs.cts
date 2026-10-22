// BUG-711 / 0.12.2 consumer fixture — a CommonJS TypeScript project reaching
// EVERY public entry point through the `require` condition. Before 0.12.2 each
// import here failed with TS1479 on TypeScript older than 5.8 (an ES module
// cannot be imported from a CommonJS file); the package now resolves the
// `require` condition to CommonJS-typed `.d.cts` declarations.
import { RevTurbineProvider, initRevTurbine as initRoot } from '@revturbine/sdk';
import type { RevTurbineProviderProps, EntitlementResult } from '@revturbine/sdk';
import { RevTurbineServer, initRevTurbine } from '@revturbine/sdk/headless';
import type { ClientSessionResult, CreateClientSessionInput } from '@revturbine/sdk/headless';
import * as growthbook from '@revturbine/sdk/growthbook';
import * as optimizely from '@revturbine/sdk/optimizely';

type IsAny<T> = 0 extends 1 & T ? true : false;
export const notAny: [IsAny<RevTurbineProviderProps>, IsAny<EntitlementResult>, IsAny<ClientSessionResult>, IsAny<typeof RevTurbineServer>] = [
  false,
  false,
  false,
  false,
];

const input: CreateClientSessionInput = { subject: 'user_1' };
const server = new RevTurbineServer({ tenantId: 'tenant_1', apiKey: 'rtk_server_key', endpoint: 'https://revturbine.com/app' });

export async function mint(): Promise<ClientSessionResult> {
  return server.createClientSession(input);
}

export async function hostedServer(): Promise<boolean> {
  const session = await initRevTurbine({ apiKey: 'rtk_server_key', user: { id: 'user_1' } });
  const result = await session.sdk.can('sso');
  return result.allowed;
}

export const entries = [typeof RevTurbineProvider, typeof initRoot, Object.keys(growthbook).length, Object.keys(optimizely).length];
