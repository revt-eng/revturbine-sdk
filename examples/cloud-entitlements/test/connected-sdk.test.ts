import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { initRevTurbine, RuntimeMode } from "@revturbine/sdk/headless";
import { evaluateWithNativeConnectedSdk } from "../src/native-connected-example";

const ENDPOINT = "https://revturbine.example/app";
const SERVER_KEY = "rtk_test_server_key_not_a_real_secret";
const BOOTSTRAP_URL = `${ENDPOINT}/api/sdk/bootstrap`;
const MANIFEST_URL = "https://cdn.example/manifest.json";

async function mockConnectedDelivery(t: TestContext) {
  const bundleText = await readFile(new URL("./fixtures/playbook.json", import.meta.url), "utf8");
  const sha256 = createHash("sha256").update(bundleText, "utf8").digest("hex");
  const bundleUrl = `https://cdn.example/bundles/${sha256}.json`;
  const now = Date.now();
  const manifest = {
    manifest_version: "1.0.0",
    tenant_id: "tn_example",
    config_version: "pv_example",
    schema_version: 18,
    runtime_abi: 2,
    active: {
      url: bundleUrl,
      sha256,
      byte_length: Buffer.byteLength(bundleText, "utf8"),
    },
    not_before: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 3_600_000).toISOString(),
  };
  const requests: Array<{ url: string; method: string; authorization: string | null }> = [];

  // Only transport is mocked. The published SDK parses the manifest, verifies
  // the bundle's real SHA-256 digest, loads its Playbook, and evaluates rules.
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
    });
    if (request.url === BOOTSTRAP_URL) {
      return Response.json({ manifest_url: MANIFEST_URL });
    }
    if (request.url === MANIFEST_URL) return Response.json(manifest);
    if (request.url === bundleUrl) {
      return new Response(bundleText, { headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected SDK network request: ${request.url}`);
  };
  t.mock.method(globalThis, "fetch", fetcher);
  return { requests, bundleUrl };
}

function createNativeConnectedSession(plan_handle: "pro" | "free") {
  // Deliberately omit configProvider and localRuntime: this must exercise the
  // SDK's built-in connected bootstrap/CDN provider, not the custom cache.
  return initRevTurbine({
    tenantId: "tn_example",
    apiKey: SERVER_KEY,
    endpoint: ENDPOINT,
    environmentId: "production",
    runtimeMode: RuntimeMode.Server,
    user: {
      id: `usr_${plan_handle}`,
      account_id: `acct_${plan_handle}`,
      plan_handle,
    },
    analytics: false,
    anonymousTelemetry: false,
    contextPolicy: { inferUser: false, inferPage: false, routerAutoTrack: false },
  });
}

test("native connected SDK grants Pro and denies Free through bootstrap/CDN without bearer leakage or fallback", async (t) => {
  const { requests, bundleUrl } = await mockConnectedDelivery(t);

  const plans: Array<'pro' | 'free'> = ['pro', 'free'];
  for (const plan of plans) {
    const session = await createNativeConnectedSession(plan);
    try {
      const result = await session.can("data_export");
      assert.equal(result.allowed, plan === "pro");
      assert.equal(result.rule_handle, `data_export_${plan}`);
      if (plan === "free") assert.equal(result.reason, "feature_not_enabled_for_plan");
      assert.equal(session.sdk.getPlaybookLoadFailure(), undefined);
    } finally {
      session.sdk.dispose();
    }
  }

  const expectedDelivery = [
    { url: BOOTSTRAP_URL, method: "GET", authorization: `Bearer ${SERVER_KEY}` },
    { url: MANIFEST_URL, method: "GET", authorization: null },
    { url: bundleUrl, method: "GET", authorization: null },
  ];
  // A fresh session performs its own delivery. Exact matching also proves no
  // legacy /api/sdk/config fallback or per-check entitlement RPC occurred.
  assert.deepEqual(requests, [...expectedDelivery, ...expectedDelivery]);
});

test("native connected SDK reuses its built-in Playbook cache within one instance", async (t) => {
  const { requests } = await mockConnectedDelivery(t);
  const session = await createNativeConnectedSession("pro");
  try {
    assert.equal((await session.can("data_export")).allowed, true);
    assert.equal(requests.length, 3);
    const afterLoad = [...requests];
    assert.equal((await session.can("data_export")).allowed, true);
    assert.equal((await session.can("data_export")).allowed, true);
    assert.deepEqual(requests, afterLoad);
  } finally {
    session.sdk.dispose();
  }
});

test("native helper allows the configured tenant and rejects an API key that delivers another tenant", async (t) => {
  await mockConnectedDelivery(t);
  // The SDK warns when it adopts the delivered tenant. The application must
  // reject the mismatch even though the Pro rule itself would allow access.
  t.mock.method(console, "warn", () => {});
  const user = { id: "usr_pro", account_id: "acct_pro", plan_handle: "pro" };
  const connection = { tenantId: "tn_example", apiKey: SERVER_KEY, endpoint: ENDPOINT };

  assert.equal((await evaluateWithNativeConnectedSdk(user, connection)).allowed, true);
  await assert.rejects(
    evaluateWithNativeConnectedSdk(user, { ...connection, tenantId: "tn_other" }),
    { message: "Playbook tenant mismatch" },
  );
});
