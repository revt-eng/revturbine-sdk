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

## Warnings that need an integration fix

| Warning or reason | What to inspect |
| --- | --- |
| Blank user ID | Wait for authentication or intentionally omit `user` for a visitor; never pass an empty ID as a loading placeholder. |
| Email-shaped identity | Use a stable internal user/account ID; keep email in its dedicated context field. |
| Dropped context keys | Use the flat canonical UserContext shape; free-form targeting belongs under `custom`, not an extra `context` wrapper. |
| Missing UI-path resolver | Register the authored action type or remove the unused action. A tracked click alone does not navigate or open checkout. |
| `entitlement_not_in_playbook` | Compare the exact handle with the loaded Playbook and confirm the correct tenant/version. |
| `not_access_entitlement_kind` | `price_per_unit` and `rate_limit` are parameter kinds; gate on an access entitlement. |
| `config_unavailable` | Diagnose delivery/authentication/version admission; do not turn an unavailable policy into a paid grant. |
| `VAL-PLN-07` | A numeric cap has no explicit enforcement choice. The default blocks at the cap. Choose `hard_block`, `block_with_upsell`, `degrade`, or `allow_overage` intentionally in the authored rule. |
| Playbook `tenant_id` differs from the SDK initialization target (for example, `local`) | Check the imported artifact and the explicit `tenantId` option. For local input, the init target wins and a mismatch warns; align them with the intended tenant rather than suppressing the warning. This is not an instruction to rewrite a signed hosted artifact. |
| The server's schema is newer than this CLI's bundled snapshot | Offline validation may lack newer rules. Update the repository's pinned CLI (`npm install -D @revturbine/cli@latest`, or your package manager's equivalent). The warning clears when that CLI's bundled schema version is at least the server stamp; reinstalling the same version does not resolve the lag. |

Read `initStatus` inside the actual provider and inspect `getPlaybookLoadFailure()`
on an initialized SDK when delivery fails. A once-per-session warning may not
repeat on every render; fix the cause and rerun the relevant transition. Do not
disable validation globally to hide a warning. See
[identity lifecycle](/guides/identity-lifecycle/) and
[SDK upgrades](/guides/sdk-upgrades/).

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
