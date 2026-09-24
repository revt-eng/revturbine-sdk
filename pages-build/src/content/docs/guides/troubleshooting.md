---
title: Troubleshooting
description: Common SDK integration failures — symptoms, causes, and fixes.
sidebar:
  order: 4
---

## Troubleshooting Matrix

| Symptom | Likely Cause | Fix |
|---|---|---|
| `getPlacement` returns `null` unexpectedly | Slot/component mismatch or no eligible payload | Verify `slotId`, `componentType`, and payload targeting. Start with `createSlotPlacementRequest(...)`. |
| A slot renders nothing, with no error and no reason code | The placement targets a slot your code never mounts — it can **never** show | Run [`sdk.diagnoseSlotInventory()`](#nothing-renders-and-nothing-explains-why). Comparing slot ids by eye is what this replaces. |
| A slot renders its fallback forever | Your code mounts a slot no placement targets | Same probe — it reports this direction too. |
| Entitlement check denies with `config_unavailable` or `sdk_disabled_provider_failure` | Playbook fetch or configured provider failed | Verify endpoint availability, auth headers, and provider health. See [Client vs Server Enforcement](/concepts/enforcement/) for the authoritative fallback contract. |
| CTA path not firing expected action | Payload action field mismatch (`cta_path` vs legacy shape) | Use canonical `cta_path` in payloads and parse via `PlacementRenderer`. |
| Decisions feel stale | Cache TTL too long | Lower `ttlMs` in decision requests or call refresh flows explicitly. |
| Interactions not visible in backend telemetry | Ingestion endpoint misconfigured | Validate `ingestEvents`/`touchpointTransition` endpoint wiring and auth. |
| Runtime mode behavior is incorrect | Wrong mode or incomplete mode config | Re-check mode selection in the [runtime modes guide](/guides/runtime-modes/) and use mode helper builders. |
| Console warns primary provider failed | The provider chain is failing: entitlement checks deny with `sdk_disabled_provider_failure` and slots follow `providerFailureSlotBehavior` | Configure `providerFallbacks`, verify provider health, and choose `providerFailureSlotBehavior` intentionally. |
| Type is `unknown` from SDK route | Contract/schema title mismatch | Ensure the SDK version matches the schema version and reinstall. |
| Build fails after SDK API changes | Missing migration updates in caller code | Migrate to object-style request helpers and rerun typecheck. |

## Nothing renders, and nothing explains why

This is the hardest symptom to debug, because **there is no error**. Almost
nothing in the SDK throws — a mismatch degrades instead of erroring — so a
placement that can never show looks exactly like a user who is not eligible.

The usual cause is that a placement targets a slot id your code does not mount,
or your code mounts a slot id no placement targets. Neither is visible from the
Playbook alone: **a config-side audit cannot see your call sites.** Only the
running app knows what it mounted, so ask it:

```ts
const diagnosis = sdk.diagnoseSlotInventory();

if (!diagnosis.configAvailable) {
  // No Playbook reached the SDK. `authored` is empty for a completely
  // different reason than "nothing is authored" — check this FIRST, because
  // the two look identical in the lists below.
  console.warn('No Playbook available; fix initialization before reading the rest.');
}

// Placements that can never show: they target a slot nothing renders.
console.log(diagnosis.authoredButUnmounted);

// Slots that render their fallback forever: nothing targets them.
console.log(diagnosis.mountedButUnauthored);
```

Each finding names the placement id and category, so it points at the thing to
fix rather than telling you something is wrong somewhere.

If both lists are empty, `configAvailable` is `true`, targeting matches the
user, and the placement still does not render — stop. That is a correct
configuration producing silence, which is not a configuration problem.
[Open an issue](https://github.com/revt-eng/revturbine-sdk/issues/new) with the
diagnostics output above and the SDK version, rather than working around it.

Requires `@revturbine/sdk` 0.8.0 or newer.

## Provider Failure Behavior

When all configured providers fail for `getPlacement`, `checkEntitlement`, or `identify`, the SDK disables itself to avoid inconsistent behavior.

In this state:

1. The SDK logs warning messages to the console.
2. Placements render as hidden (`invisible`) or safe placeholders (`placeholder`) depending on `providerFailureSlotBehavior`.
3. Entitlement checks return a denied result with `sdk_disabled_provider_failure`; see [Client vs Server Enforcement](/concepts/enforcement/) for why checks and placements have different fallback behavior.

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
