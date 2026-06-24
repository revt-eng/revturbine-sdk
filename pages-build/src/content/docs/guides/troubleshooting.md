---
title: Troubleshooting
description: Common SDK integration failures — symptoms, causes, and fixes.
sidebar:
  order: 4
---

## Troubleshooting Matrix

| Symptom | Likely Cause | Fix |
|---|---|---|
| `getPlacement` returns `null` unexpectedly | Slot/surface mismatch or no eligible payload | Verify `slotId`, `surfaceType`, and payload targeting. Start with `createSlotPlacementRequest(...)`. |
| Entitlement checks always allow | Runtime fallback path active due to endpoint failure | Verify endpoint availability and auth headers. In local-only mode, seed `entitlementByHandle`. |
| CTA path not firing expected action | Payload action field mismatch (`cta_path` vs legacy shape) | Use canonical `cta_path` in payloads and parse via `PlacementRenderer`. |
| Decisions feel stale | Cache TTL too long | Lower `ttlMs` in decision requests or call refresh flows explicitly. |
| Interactions not visible in backend telemetry | Ingestion endpoint misconfigured | Validate `ingestEvents`/`touchpointTransition` endpoint wiring and auth. |
| Runtime mode behavior is incorrect | Wrong mode or incomplete mode config | Re-check mode selection in the [runtime modes guide](/guides/runtime-modes/) and use mode helper builders. |
| Console warns primary provider failed | Provider chain is failing and SDK entered fail-closed mode | Configure `providerFallbacks`, verify provider health, and choose `providerFailureSlotBehavior` intentionally. |
| Type is `unknown` from SDK route | Contract/schema title mismatch | Ensure the SDK version matches the schema version and reinstall. |
| Build fails after SDK API changes | Missing migration updates in caller code | Migrate to object-style request helpers and rerun typecheck. |

## Provider Failure Behavior

When all configured providers fail for `getPlacement`, `checkEntitlement`, or `identify`, the SDK disables itself to avoid inconsistent behavior.

In this state:

1. The SDK logs warning messages to the console.
2. Placements render as hidden (`invisible`) or safe placeholders (`placeholder`) depending on `providerFailureSlotBehavior`.
3. Entitlement checks return allowed with a fallback reason so the app can keep functioning safely.

## Quick Checks

1. **Run API type checks:**

   ```bash
   pnpm typecheck:sdk-api
   ```

2. **Run web build:**

   ```bash
   pnpm build
   ```

3. **Validate SDK docs generation:**

   ```bash
   pnpm docs:sdk
   ```
