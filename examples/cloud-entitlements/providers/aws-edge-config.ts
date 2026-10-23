import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import type { Environment } from '../src/config';
// Deployment identifiers only. Replace these before building; never embed a key.
const secretId = 'REPLACE_WITH_SECRETS_MANAGER_ARN';
const region = 'us-east-1';
const client = new SecretsManagerClient({region, maxAttempts:2});
const configSchema = z.record(z.string(), z.string());
let configuration: Environment | undefined;
let expiresAt = 0;
let pending: Promise<Environment> | undefined;
/** Lambda@Edge has no custom environment variables. Read settings with its IAM role. */
export async function loadEdgeConfiguration(): Promise<Environment> {
  if(configuration && Date.now()<expiresAt) return configuration;
  if(pending) return pending;
  if(secretId.startsWith('REPLACE_')) throw new Error('Configure the secret ARN before deployment');
  pending = (async () => {
    const result = await client.send(new GetSecretValueCommand({SecretId:secretId}), {abortSignal:AbortSignal.timeout(4000)});
    if(!result.SecretString) throw new Error('Missing configuration');
    configuration = Object.freeze(configSchema.parse(JSON.parse(result.SecretString)));
    expiresAt = Date.now()+300000;
    return configuration;
  })().finally(()=>{pending=undefined;});
  return pending;
}
