import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from "jose";
import { normalizeConfigArtifactOrThrow } from "@revturbine/sdk/headless";
import { createCheckExportHandler } from "../src/check-export";
import { createContextVerifier, CONTEXT_TOKEN_TYPE } from "../src/context-token";
import { issueContextToken } from "../issuer/issue-context-token";

const tenantId = "tn_example";
const issuer = "https://auth.example.com";
const audience = "https://api.example.com/edge-entitlements";
const jwksUrl = `${issuer}/.well-known/jwks.json`;
const connection = { apiKey: "test-server-token", endpoint: "https://revturbine.com/app" };
const keys = await generateKeyPair("RS256", { extractable: true });
const privateKeyPem = await exportPKCS8(keys.privateKey);
const publicJwk = { ...await exportJWK(keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
const raw = JSON.parse(await readFile(new URL("./fixtures/playbook.json", import.meta.url), "utf8"));
const playbook = normalizeConfigArtifactOrThrow(raw, "test fixture", {
  tenantId, environmentId: "production",
})!;
function freeze(value: unknown) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
freeze(playbook);

let jwksFetches = 0;
let jwksUnavailable = false;
const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async input => {
    assert.equal(String(input), jwksUrl, "No unexpected network calls from the SDK");
    jwksFetches++;
    if (jwksUnavailable) return new Response("unavailable", { status: 503 });
    return Response.json({ keys: [publicJwk] });
  };
});
after(() => { globalThis.fetch = originalFetch; });

const verifyContext = createContextVerifier({ jwksUrl, issuer, audience, tenantId });
let playbookLoads = 0;
const handler = createCheckExportHandler({
  connection, verifyContext,
  loadPlaybook: async () => { playbookLoads++; return { playbook, sha256: "test-sha" }; },
});
async function token(plan: "free" | "pro", id = `user_${plan}`) {
  return issueContextToken({
    trustedUser: { id, account_id: `account_${id}`, plan_handle: plan },
    contextVersion: "ctx_1",
  }, { privateKeyPem, keyId: "test-key", issuer, audience, tenantId });
}
function request(jwt?: string, body?: unknown) {
  return new Request("https://api.example.com/api/check-export", {
    method: "POST",
    headers: jwt ? { authorization: `Bearer ${jwt}`, "content-type": "application/json" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("verified Pro context grants; untrusted body does not replace signed identity", async () => {
  const response = await handler(request(await token("pro"), {
    user_context: { id: "attacker", account_id: "other", plan_handle: "free" },
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    allowed: true, entitlement: "data_export", userId: "user_pro",
    accountId: "account_user_pro", playbookVersion: "pv_example",
  });
});

test("verified Free context denies despite a forged Pro request body", async () => {
  const response = await handler(request(await token("free"), {
    user_context: { plan_handle: "pro", entitlements: { data_export: true } },
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { allowed: false, entitlement: "data_export" });
  assert.equal(jwksFetches, 1, "warm verifier reuses JWKS public keys");
});

test("missing token is rejected before loading a Playbook", async () => {
  const previousLoads = playbookLoads;
  assert.equal((await handler(request())).status, 401);
  assert.equal(playbookLoads, previousLoads);
});

test("signature tampering is rejected", async () => {
  const parts = (await token("pro")).split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  payload.user_context.account_id = "account_victim";
  parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  assert.equal((await handler(request(parts.join(".")))).status, 401);
});

test("signed but invalid claims are rejected", async t => {
  const now = Math.floor(Date.now() / 1000);
  const valid = {
    iss: issuer, aud: audience, sub: "user_1", iat: now, exp: now + 300,
    tenant_id: tenantId, context_version: "ctx_1",
    user_context: { id: "user_1", account_id: "account_1", plan_handle: "pro" },
  };
  const cases = {
    audience: { ...valid, aud: "other-service" },
    issuer: { ...valid, iss: "https://other.example.com" },
    expiration: { ...valid, iat: now - 400, exp: now - 100 },
    lifetime: { ...valid, exp: now + 3600 },
    subject: { ...valid, sub: "user_2" },
    tenant: { ...valid, tenant_id: "tn_other" },
    "context shape": { ...valid, user_context: { ...valid.user_context, entitlements: {} } },
  };
  for (const [name, claims] of Object.entries(cases)) {
    await t.test(name, async () => {
      const jwt = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: CONTEXT_TOKEN_TYPE })
        .sign(keys.privateKey);
      assert.equal((await handler(request(jwt))).status, 401);
    });
  }
  const wrongType = await new SignJWT(valid)
    .setProtectedHeader({ alg: "RS256", kid: "test-key", typ: "JWT" }).sign(keys.privateKey);
  assert.equal((await handler(request(wrongType))).status, 401);
});

test("concurrent users have isolated identity and entitlement state", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const plan = i % 2 === 0 ? "pro" : "free";
    const id = `concurrent_${i}`;
    const response = await handler(request(await token(plan, id)));
    assert.equal(response.status, plan === "pro" ? 200 : 403);
    const body = await response.json();
    if (plan === "pro") {
      assert.equal(body.userId, id);
      assert.equal(body.accountId, `account_${id}`);
    }
    return response.status;
  }));
  assert.equal(results.filter(status => status === 200).length, 10);
});

test("Playbook outage returns 503 rather than a grant or a plan denial", async () => {
  const unavailable = createCheckExportHandler({ connection, verifyContext,
    loadPlaybook: async () => { throw new Error("simulated CDN outage"); },
  });
  assert.equal((await unavailable(request(await token("pro")))).status, 503);
});

test("wrong Playbook tenant is refused before normalization can override it", async () => {
  const wrongTenant = createCheckExportHandler({ connection, verifyContext,
    loadPlaybook: async () => ({ playbook: { ...playbook, tenant_id: "tn_other" }, sha256: "x" }),
  });
  assert.equal((await wrongTenant(request(await token("pro")))).status, 503);
});

test("missing entitlement is an operational 503", async () => {
  const wrongConfig = createCheckExportHandler({ connection, verifyContext,
    loadPlaybook: async () => ({ playbook: { ...playbook, entitlements: [] }, sha256: "x" }),
  });
  assert.equal((await wrongConfig(request(await token("pro")))).status, 503);
});

test("JWKS outage is an operational 503", async () => {
  jwksUnavailable = true;
  try {
    const verifier = createContextVerifier({ jwksUrl, issuer, audience, tenantId });
    const unavailable = createCheckExportHandler({ connection, verifyContext: verifier,
      loadPlaybook: async () => ({ playbook, sha256: "x" }),
    });
    assert.equal((await unavailable(request(await token("pro")))).status, 503);
  } finally { jwksUnavailable = false; }
});
