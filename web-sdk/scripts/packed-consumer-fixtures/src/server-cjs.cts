// BUG-711 consumer fixture — a CommonJS TypeScript server (NodeNext resolves
// the `require` condition for this file).
import { RevTurbineServer } from '@revturbine/sdk/headless';
import type { CreateClientSessionInput, ClientSessionResult } from '@revturbine/sdk/headless';

const input: CreateClientSessionInput = { subject: 'user_1' };
const server = new RevTurbineServer({ tenantId: 'tenant_1', apiKey: 'rtk_server_key', endpoint: 'https://revturbine.com/app' });

export async function mint(): Promise<ClientSessionResult> {
  return server.createClientSession(input);
}
