// BUG-711 consumer fixture — the headless (server) entry loads in plain Node
// through both module systems, without React installed in its import graph.
import { createRequire } from 'node:module';

const viaImport = await import('@revturbine/sdk/headless');
const viaRequire = createRequire(import.meta.url)('@revturbine/sdk/headless');

for (const [how, mod] of [['import', viaImport], ['require', viaRequire]]) {
  if (typeof mod.RevTurbineServer !== 'function') {
    throw new Error(`${how}: RevTurbineServer is not exported`);
  }
  const server = new mod.RevTurbineServer({ tenantId: 't', apiKey: 'rtk_server_key', endpoint: 'https://revturbine.com/app' });
  if (typeof server.createClientSession !== 'function') throw new Error(`${how}: createClientSession missing`);
}
console.log('headless entry loads via import() and require()');
