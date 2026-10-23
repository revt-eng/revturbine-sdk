import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EdgeVM } from "@edge-runtime/vm";
import { build } from "esbuild";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

// Node APIs are used by this test runner only. The actual api/check-export.ts
// entry point is bundled for the browser and executed inside the Edge VM.
test("real Vercel entry point verifies JWTs and isolates concurrent users in an Edge VM", async t => {
  const projectDir = fileURLToPath(new URL("../", import.meta.url));
  const endpoint = "https://revturbine.example.test/app";
  const jwksUrl = "https://identity.example.test/.well-known/jwks.json";
  const cdnUrl = "https://cdn.example.test/playbooks/example.json";
  const apiKey = "test-only-server-key";
  const bundle = await build({
    absWorkingDir: projectDir,
    entryPoints: ["api/check-export.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "EntitlementEdge",
    target: "es2022",
    write: false,
    metafile: true,
    logLevel: "silent",
    define: {
      "process.env": JSON.stringify({
        NODE_ENV: "production",
        REVTURBINE_TENANT_ID: "tn_example",
        REVTURBINE_API_KEY: apiKey,
        REVTURBINE_ENDPOINT: endpoint,
        REVTURBINE_CDN_ORIGINS: "https://cdn.example.test",
        CONTEXT_JWKS_URL: jwksUrl,
        CONTEXT_ISSUER: "https://identity.example.test",
        CONTEXT_AUDIENCE: "export-api",
      }),
    },
  });
  assert.ok(bundle.outputFiles?.[0]);
  assert.ok(bundle.metafile);
  assert.equal(Object.values(bundle.metafile.outputs)
    .flatMap(output => output.imports.filter(dependency => dependency.external)).length, 0);
  assert.ok(Object.keys(bundle.metafile.inputs)
    .some(input => input.includes("@revturbine/sdk/dist/headless.js")));

  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = { ...await exportJWK(publicKey), kid: "edge-example", alg: "RS256", use: "sig" };
  const playbookJson = await readFile(new URL("fixtures/playbook.json", import.meta.url), "utf8");
  const sha256 = createHash("sha256").update(playbookJson).digest("hex");
  const now = Math.floor(Date.now() / 1000);
  const manifest = {
    manifest_version: "1.0.0",
    tenant_id: "tn_example",
    config_version: "pv_example",
    schema_version: 18,
    runtime_abi: 2,
    active: { url: cdnUrl, sha256, byte_length: Buffer.byteLength(playbookJson) },
    not_before: new Date((now - 60) * 1000).toISOString(),
    expires_at: new Date((now + 3_600) * 1000).toISOString(),
  };
  const routes = {
    [jwksUrl]: JSON.stringify({ keys: [publicJwk] }),
    [endpoint + "/api/sdk/bootstrap"]: JSON.stringify({
      manifest_url: "https://cdn.example.test/manifests/example.json", manifest,
    }),
    [cdnUrl]: playbookJson,
  };

  const runtime = new EdgeVM();
  assert.deepEqual(JSON.parse(runtime.evaluate<string>(
    "JSON.stringify({ process: typeof process, require: typeof require, Buffer: typeof Buffer, edge: typeof EdgeRuntime })",
  )), { process: "undefined", require: "undefined", Buffer: "undefined", edge: "string" });
  // The VM has Web Crypto, fetch, streams, and Vercel's EdgeRuntime marker.
  // Every network response is a fixture; unexpected network calls fail closed.
  runtime.evaluate(`
    globalThis.__networkCalls = [];
    globalThis.__routes = ${JSON.stringify(routes)};
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      globalThis.__networkCalls.push({ url, authorization: headers.get("authorization") });
      const body = globalThis.__routes[url];
      if (body === undefined) throw new Error("Unexpected network request: " + url);
      await Promise.resolve();
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
  `);
  runtime.evaluate(bundle.outputFiles[0].text);
  assert.equal(runtime.evaluate("EntitlementEdge.config.runtime"), "edge");

  type Invocation = { token?: string; body?: unknown };
  type Result = { status: number; cacheControl: string | null; body: Record<string, unknown> };
  async function invoke(requests: Invocation[]): Promise<Result[]> {
    return JSON.parse(await runtime.evaluate<Promise<string>>(`
      (async () => {
        const requests = ${JSON.stringify(requests)};
        const responses = await Promise.all(requests.map(async item => {
          const response = await EntitlementEdge.default(new Request("https://api.example.test/api/check-export", {
            method: "POST",
            headers: item.token ? { authorization: "Bearer " + item.token } : {},
            body: JSON.stringify(item.body ?? {}),
          }));
          return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.json() };
        }));
        return JSON.stringify(responses);
      })()
    `));
  }
  function networkCalls(): { url: string; authorization: string | null }[] {
    return JSON.parse(runtime.evaluate<string>("JSON.stringify(globalThis.__networkCalls)"));
  }
  async function signContext(userId: string, plan: "pro" | "free", issuedAt = now) {
    return new SignJWT({
      tenant_id: "tn_example",
      context_version: "ctx_1",
      user_context: { id: userId, account_id: "acct_" + userId, plan_handle: plan },
    })
      .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid, typ: "revturbine-context+jwt" })
      .setIssuer("https://identity.example.test")
      .setAudience("export-api")
      .setSubject(userId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(privateKey);
  }

  const [unauthenticated] = await invoke([{}]);
  assert.equal(unauthenticated.status, 401);
  assert.equal(networkCalls().length, 0, "unauthenticated callers do not fetch Playbooks or keys");

  const identities = Array.from({ length: 12 }, (_, i): { userId: string; plan: 'pro' | 'free' } => ({
    userId: "user_" + i,
    plan: i % 2 === 0 ? "pro" : "free",
  }));
  const tokens = await Promise.all(identities.map(({ userId, plan }) => signContext(userId, plan)));
  const results = await invoke(tokens.map(token => ({
    token,
    // Body claims must not override the signed UserContext, including for free users.
    body: { user_context: { id: "forged", plan_handle: "pro" }, allowed: true },
  })));
  for (let index = 0; index < identities.length; index += 1) {
    const identity = identities[index];
    const result = results[index];
    assert.equal(result.status, identity.plan === "pro" ? 200 : 403);
    assert.equal(result.cacheControl, "private, no-store");
    assert.equal(result.body.allowed, identity.plan === "pro");
    if (identity.plan === "pro") {
      assert.equal(result.body.userId, identity.userId);
      assert.equal(result.body.accountId, "acct_" + identity.userId);
      assert.equal(result.body.playbookVersion, "pv_example");
    }
  }

  const calls = networkCalls();
  assert.equal(calls.filter(call => call.url === jwksUrl).length, 1, "concurrent JWT checks share JWKS loading");
  assert.equal(calls.filter(call => call.url === endpoint + "/api/sdk/bootstrap").length, 1,
    "concurrent requests share the connected bootstrap load");
  assert.equal(calls.filter(call => call.url === cdnUrl).length, 1,
    "concurrent requests share one immutable CDN bundle load");
  assert.equal(calls.length, 3, "request-scoped SDK sessions do not duplicate delivery or send analytics");
  assert.equal(calls.find(call => call.url === endpoint + "/api/sdk/bootstrap")?.authorization, "Bearer " + apiKey);
  assert.equal(calls.find(call => call.url === cdnUrl)?.authorization, null);
  assert.equal(calls.find(call => call.url === jwksUrl)?.authorization, null);

  const [warm] = await invoke([{ token: tokens[0] }]);
  assert.equal(warm.status, 200);
  assert.equal(networkCalls().length, 3, "warm requests reuse Playbook and JWKS caches");
  const expired = await signContext("expired_user", "pro", now - 600);
  const [expiredResult] = await invoke([{ token: expired }]);
  assert.equal(expiredResult.status, 401);
  assert.equal(networkCalls().length, 3);

  t.diagnostic("Executed " + bundle.outputFiles[0].contents.byteLength +
    "-byte browser bundle with the real @revturbine/sdk 0.12.4; HTTP services were mocked, not deployed.");
});
