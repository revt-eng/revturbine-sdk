import { importPKCS8, SignJWT } from "jose";
import {
  CONTEXT_TOKEN_TTL_SECONDS,
  CONTEXT_TOKEN_TYPE,
  TokenUserContextSchema,
  type TokenUserContext,
} from "../src/context-token";

// Invoke ONLY from your authenticated application backend, after it loads
// the current user, account membership, and plan from authoritative data.
// This is a helper, not a public endpoint that signs arbitrary request JSON.
/** Sign authoritative application context; call only after authentication and membership checks. */
export async function issueContextToken(input: {
  trustedUser: TokenUserContext;
  contextVersion: string;
}, config: {
  privateKeyPem: string;
  keyId: string;
  issuer: string;
  audience: string;
  tenantId: string;
}) {
  const user = TokenUserContextSchema.parse(input.trustedUser);
  const key = await importPKCS8(config.privateKeyPem, "RS256");
  const issuedAt = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    tenant_id: config.tenantId,
    context_version: input.contextVersion,
    user_context: user,
  })
    .setProtectedHeader({ alg: "RS256", kid: config.keyId, typ: CONTEXT_TOKEN_TYPE })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setSubject(user.id)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + CONTEXT_TOKEN_TTL_SECONDS)
    .setJti(crypto.randomUUID())
    .sign(key);
}
