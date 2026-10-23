import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { HttpRequest } from '@azure/functions';
import type { APIGatewayProxyEventV2, CloudFrontRequestEvent } from 'aws-lambda';
import { createConfiguredHandler } from '../src/config';
import { createLambdaHandler } from '../providers/aws-lambda';
import { createLambdaEdgeHandler } from '../providers/aws-lambda-edge';
import { createAzureHandler } from '../providers/azure-functions';
import { CONTEXT_TOKEN_TYPE } from '../src/context-token';

// Provider fixtures follow the published HTTP API v2 and Lambda@Edge event schemas:
// https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html
const endpoint='https://control.example.test/app';
const jwksUrl='https://identity.example.test/jwks';
const cdn='https://cdn.example.test/playbook.json';
const env={REVTURBINE_TENANT_ID:'tn_example',REVTURBINE_API_KEY:'server-test-key',
 REVTURBINE_ENDPOINT:endpoint,REVTURBINE_CDN_ORIGINS:'https://cdn.example.test',
 CONTEXT_JWKS_URL:jwksUrl,CONTEXT_ISSUER:'https://identity.example.test',CONTEXT_AUDIENCE:'export-api'};
const keys=await generateKeyPair('RS256',{extractable:true});
const jwk={...await exportJWK(keys.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
const bytes=await readFile(new URL('./fixtures/playbook.json',import.meta.url));
const digest=createHash('sha256').update(bytes).digest('hex');
const originalFetch=globalThis.fetch;
let unavailable=false;
let bootstrapCalls=0;
before(()=>{globalThis.fetch=async(input,init)=>{
 const url=input instanceof Request?input.url:String(input);
 const headers=new Headers(init?.headers);
 if(url===jwksUrl){assert.equal(headers.get('authorization'),null);return Response.json({keys:[jwk]});}
 if(url===endpoint+'/api/sdk/bootstrap'){
  bootstrapCalls++;assert.equal(headers.get('authorization'),'Bearer server-test-key');
  if(unavailable)return new Response(null,{status:503});
  return Response.json({manifest:{manifest_version:'1.0.0',tenant_id:'tn_example',config_version:'pv_example',
   schema_version:18,runtime_abi:2,active:{url:cdn,sha256:digest,byte_length:bytes.length},
   not_before:new Date(Date.now()-60000).toISOString(),expires_at:new Date(Date.now()+3600000).toISOString()}});
 }
 if(url===cdn){assert.equal(headers.get('authorization'),null);return new Response(bytes);}
 throw new Error('Unexpected network URL');
};});
after(()=>{globalThis.fetch=originalFetch;});
async function token(plan:'pro'|'free'){
 return new SignJWT({tenant_id:'tn_example',context_version:'ctx1',user_context:{id:plan,account_id:'acct_'+plan,plan_handle:plan}})
  .setProtectedHeader({alg:'RS256',kid:'test-key',typ:CONTEXT_TOKEN_TYPE}).setIssuer(env.CONTEXT_ISSUER)
  .setAudience(env.CONTEXT_AUDIENCE).setSubject(plan).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
}
function awsEvent(authorization?:string,method='POST'):APIGatewayProxyEventV2 {
 return {version:'2.0',routeKey:'POST /check-export',rawPath:'/check-export',rawQueryString:'',
 headers:authorization?{authorization}:{},isBase64Encoded:false,
 body:JSON.stringify({user_context:{id:'attacker',plan_handle:'pro'}}),
 requestContext:{accountId:'123456789012',apiId:'example',domainName:'example.test',domainPrefix:'example',
  http:{method,path:'/check-export',protocol:'HTTP/1.1',sourceIp:'192.0.2.1',userAgent:'test'},
  requestId:'request1',routeKey:'POST /check-export',stage:'$default',time:'23/Oct/2026:00:00:00 +0000',timeEpoch:1792713600000}};
}
function edgeEvent(authorization?:string,method='POST'):CloudFrontRequestEvent {
 return {Records:[{cf:{config:{distributionDomainName:'example.cloudfront.net',distributionId:'EXAMPLE',eventType:'origin-request',requestId:'request1'},
  request:{clientIp:'192.0.2.1',headers:authorization?{authorization:[{key:'Authorization',value:authorization}]}:{},method,querystring:'',uri:'/check-export'}}}]};
}

test('AWS HTTP API, Lambda@Edge and Azure carry real signed contexts into the real SDK',async()=>{
 const lambda=createLambdaHandler(createConfiguredHandler(env));
 const edge=createLambdaEdgeHandler(async()=>env);
 const azure=createAzureHandler(createConfiguredHandler(env));
 for(const [name,invoke] of Object.entries({
  lambda:async(auth?:string,method='POST')=>{const r=await lambda(awsEvent(auth,method));return {status:r.statusCode,body:r.body,cache:r.headers?.['cache-control']};},
  edge:async(auth?:string,method='POST')=>{const r=await edge(edgeEvent(auth,method));return {status:Number(r.status),body:r.body,cache:r.headers?.['cache-control']?.[0].value};},
  azure:async(auth?:string,method='POST')=>{const r=await azure(new HttpRequest({url:'https://example.test/api/check-export',method,headers:auth?{authorization:auth}:{}}));return {status:r.status,body:r.body,cache:new Headers(r.headers).get('cache-control')};},
 })){
  const before=bootstrapCalls;
  assert.equal((await invoke()).status,401,name);assert.equal(bootstrapCalls,before,'authentication precedes Playbook fetch');
  assert.equal((await invoke(undefined,'GET')).status,405,name);
  const [pro,free]=await Promise.all([invoke('Bearer '+await token('pro')),invoke('Bearer '+await token('free'))]);
  assert.equal(pro.status,200,name);assert.equal(free.status,403,name);
  assert.equal(pro.cache,'private, no-store',name);assert.equal(free.cache,'private, no-store',name);
  assert.equal(typeof pro.body,'string');assert.match(String(pro.body),/"userId":"pro"/);
  assert.equal((await invoke('Bearer invalid')).status,401,name);
 }
});
test('provider configuration and Playbook outages fail closed',async()=>{
 unavailable=true;
 const lambda=createLambdaHandler(createConfiguredHandler(env));
 assert.equal((await lambda(awsEvent('Bearer '+await token('pro')))).statusCode,503);
 const edge=createLambdaEdgeHandler(async()=>{throw new Error('Secret unavailable');});
 assert.equal((await edge(edgeEvent())).status,'503');
 unavailable=false;
});
