import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { z } from "zod";
import type { RevTurbineUserContext } from "@revturbine/sdk/headless";
import { HttpError } from "./http-error";

/** Application context JWT type, distinct from general access tokens. */
export const CONTEXT_TOKEN_TYPE = "revturbine-context+jwt";
/** Maximum context lifetime before the application must reissue authoritative facts. */
export const CONTEXT_TOKEN_TTL_SECONDS = 300;

// This application deliberately signs only the fields its access rules use.
// Add other SDK fields with explicit validation when your rules require them.
/** Deliberately narrow signed context schema for this application's rules. */
export const TokenUserContextSchema = z.object({
  id: z.string().min(1).max(200),
  account_id: z.string().min(1).max(200),
  plan_handle: z.string().min(1).max(100),
  custom: z.record(
    z.string(),
    z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  ).optional(),
}).strict();

/** Validated application claims that also satisfy the SDK user shape. */
export type TokenUserContext = z.infer<typeof TokenUserContextSchema>;

const ContextClaimsSchema = z.object({
  sub: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  tenant_id: z.string().min(1),
  context_version: z.string().min(1),
  user_context: TokenUserContextSchema,
});

/** Identity and tenant scope established by signature and claim verification. */
export interface VerifiedContext {
  tenantId: string;
  contextVersion: string;
  user: TokenUserContext;
}

/** Create a reusable public-key resolver and per-request JWT verifier. */
export function createContextVerifier(options: {
  jwksUrl: string;
  issuer: string;
  audience: string;
  tenantId: string;
}) {
  const url = new URL(options.jwksUrl);
  if (url.protocol !== "https:") throw new Error("JWKS must use HTTPS");

  // Keep this resolver outside the request handler to reuse public keys.
  const jwks = createRemoteJWKSet(url, { timeoutDuration: 3_000 });

  return async (request: Request): Promise<VerifiedContext> => {
    const authorization = request.headers.get("authorization") ?? "";
    const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
    if (!token || token.length > 16_384) {
      throw new HttpError(401, "invalid_context_token");
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(token, async (header, input) => {
        try {
          return await jwks(header, input);
        } catch (error) {
          if (error instanceof errors.JWKSNoMatchingKey) throw error;
          throw new HttpError(503, "identity_keys_unavailable");
        }
      }, {
        algorithms: ["RS256"],
        issuer: options.issuer,
        audience: options.audience,
        typ: CONTEXT_TOKEN_TYPE,
        requiredClaims: ["sub", "iat", "exp"],
        maxTokenAge: CONTEXT_TOKEN_TTL_SECONDS,
        clockTolerance: 5,
      }));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof errors.JOSEError) {
        throw new HttpError(401, "invalid_context_token");
      }
      throw new HttpError(503, "identity_verification_unavailable");
    }

    const parsed = ContextClaimsSchema.safeParse(payload);
    if (!parsed.success) throw new HttpError(401, "invalid_context_token");
    const claims = parsed.data;
    if (
      claims.sub !== claims.user_context.id ||
      claims.tenant_id !== options.tenantId ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > CONTEXT_TOKEN_TTL_SECONDS
    ) {
      throw new HttpError(401, "invalid_context_token");
    }

    // Compile-time check that our validated DTO is an SDK UserContext input.
    const user = claims.user_context satisfies RevTurbineUserContext;
    return {
      tenantId: claims.tenant_id,
      contextVersion: claims.context_version,
      user,
    };
  };
}
