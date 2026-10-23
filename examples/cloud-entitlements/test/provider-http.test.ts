import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { CONTEXT_TOKEN_TYPE } from '../src/context-token';
import { normalizeConfigArtifactOrThrow } from '@revturbine/sdk/headless';
import fixture from './fixtures/playbook.json' with {type:'json'};
import { createCheckExportHandler } from '../src/check-export';
import { HttpError } from '../src/http-error';
import { nodeHttpHandler } from '../src/node-http';

const playbook=normalizeConfigArtifactOrThrow(fixture,'HTTP fixture',{tenantId:'tn_example',environmentId:'production'});
if(!playbook) throw new Error('Fixture must normalize');

test('real Node HTTP transport preserves deny/no-store and never consumes a forged body as context',async()=>{
 const handle=createCheckExportHandler({connection:{endpoint:'https://unused.example.test',apiKey:'test-key'},
  loadPlaybook:async()=>({playbook,sha256:'fixture'}),
  // Authentication itself is exercised with real JWTs in auth-handler/provider-adapters.
  verifyContext:async request=>{
   const token=request.headers.get('authorization');
   if(token!=='Bearer test_free'&&token!=='Bearer test_pro')throw new HttpError(401,'invalid_context_token');
   const plan=token==='Bearer test_pro'?'pro':'free';
   return {tenantId:'tn_example',contextVersion:'ctx1',user:{id:plan,account_id:'account_'+plan,plan_handle:plan}};
  }});
 const server=createServer(nodeHttpHandler(handle));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();if(!address||typeof address==='string')throw new Error('Missing listener');
 try{
  const url=`http://127.0.0.1:${address.port}/check-export`;
  const [pro,free]=await Promise.all(['pro','free'].map(plan=>fetch(url,{method:'POST',headers:{authorization:`Bearer test_${plan}`},body:JSON.stringify({user_context:{plan_handle:'pro'}})})));
  assert.equal(pro.status,200);assert.equal(free.status,403);
  assert.equal(pro.headers.get('cache-control'),'private, no-store');
  assert.equal(free.headers.get('cache-control'),'private, no-store');
  assert.equal((await pro.json()).userId,'pro');await free.text();
  const unauthorized=await fetch(url,{method:'POST'});assert.equal(unauthorized.status,401);await unauthorized.text();
  const method=await fetch(url);assert.equal(method.status,405);assert.equal(method.headers.get('allow'),'POST');await method.text();
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('built Firebase entry exports a real function and responds fail-closed over Node HTTP',async()=>{
 const require=createRequire(import.meta.url);
 const {checkExport}=require('../dist/firebase/index.cjs');
 assert.equal(typeof checkExport,'function');
 assert.equal(checkExport.__endpoint.platform,'gcfv2');
 const server=createServer(checkExport);server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();if(!address||typeof address==='string')throw new Error('Missing listener');
 try{const response=await fetch(`http://127.0.0.1:${address.port}/`,{method:'POST'});
 assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'private, no-store');await response.text();
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('built Cloud Run container entry binds PORT and fails closed without configuration',async()=>{
 const child=spawn(process.execPath,['dist/google-cloud-run/index.cjs'],{env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',data=>{stderr+=String(data);});
 try{
  const port=await new Promise<number>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('No listening receipt: '+stderr)),5000);
   let stdout='';child.stdout.on('data',data=>{stdout+=String(data);const match=/Listening on port (\d+)/.exec(stdout);if(match){clearTimeout(timer);resolve(Number(match[1]));}});
   child.once('error',e=>{clearTimeout(timer);reject(e);});
   child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Container exited ${code}: ${stderr}`));});
  });
  const response=await fetch(`http://127.0.0.1:${port}/check-export`,{method:'POST'});
  assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal((await response.json()).error,'entitlement_service_unavailable');
 }finally{child.kill();await once(child,'exit');}
});

test('configured built Firebase and Cloud Run entries enforce signed users over real HTTP', async () => {
 const env = { PORT: '0', REVTURBINE_TENANT_ID: 'tn_example', REVTURBINE_API_KEY: 'test-server-key',
  REVTURBINE_ENDPOINT: 'https://control.example.test/app', REVTURBINE_CDN_ORIGINS: 'https://cdn.example.test',
  CONTEXT_JWKS_URL: 'https://identity.example.test/jwks', CONTEXT_ISSUER: 'https://identity.example.test', CONTEXT_AUDIENCE: 'export-api' };
 const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
 const originalFetch = globalThis.fetch;
 const keys = await generateKeyPair('RS256', { extractable: true });
 const jwk = { ...await exportJWK(keys.publicKey), kid: 'http-test', alg: 'RS256', use: 'sig' };
 const bytes = new TextEncoder().encode(JSON.stringify(fixture));
 const sha256 = createHash('sha256').update(bytes).digest('hex');
 let bootstrapCalls = 0;
 globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith('http://127.0.0.1:')) return originalFetch(input, init);
  if (url === env.CONTEXT_JWKS_URL) return Response.json({ keys: [jwk] });
  if (url === `${env.REVTURBINE_ENDPOINT}/api/sdk/bootstrap`) {
   bootstrapCalls++;
   assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-server-key');
   return Response.json({ manifest: { manifest_version: '1.0.0', tenant_id: 'tn_example', config_version: 'pv_example', schema_version: 18, runtime_abi: 2,
    active: { url: 'https://cdn.example.test/playbook.json', sha256, byte_length: bytes.length },
    not_before: new Date(Date.now() - 60000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() } });
  }
  if (url === 'https://cdn.example.test/playbook.json') {
   assert.equal(new Headers(init?.headers).get('authorization'), null);
   return new Response(bytes);
  }
  throw new Error(`Unexpected upstream ${url}`);
 };
 Object.assign(process.env, env);
 const servers: ReturnType<typeof createServer>[] = [];
 try {
  const require = createRequire(import.meta.url);
  const firebase = createServer(require('../dist/firebase/index.cjs').checkExport);
  firebase.listen(0, '127.0.0.1'); await once(firebase, 'listening'); servers.push(firebase);
  const cloudRun = require('../dist/google-cloud-run/index.cjs').server;
  servers.push(cloudRun); if (!cloudRun.listening) await once(cloudRun, 'listening');
  for (const server of servers) {
   const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
   const url = `http://127.0.0.1:${address.port}/check-export`;
   const before = bootstrapCalls;
   const missing = await fetch(url, { method: 'POST' }); assert.equal(missing.status, 401); await missing.text();
   assert.equal(bootstrapCalls, before);
   for (const plan of ['pro', 'free']) {
    const jwt = await new SignJWT({ tenant_id: 'tn_example', context_version: 'ctx1', user_context: { id: plan, account_id: `acct_${plan}`, plan_handle: plan } })
     .setProtectedHeader({ alg: 'RS256', kid: 'http-test', typ: CONTEXT_TOKEN_TYPE }).setIssuer(env.CONTEXT_ISSUER)
     .setAudience(env.CONTEXT_AUDIENCE).setSubject(plan).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: JSON.stringify({ user_context: { plan_handle: 'pro' } }) });
    assert.equal(response.status, plan === 'pro' ? 200 : 403);
    assert.equal(response.headers.get('cache-control'), 'private, no-store'); await response.text();
   }
  }
 } finally {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
 }
});
