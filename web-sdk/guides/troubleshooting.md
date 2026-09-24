# SDK Troubleshooting Matrix

Use this table for common integration failures.

| Symptom | Likely Cause | Fix |
|---|---|---|
| `getPlacement` returns `null` unexpectedly | Slot/surface mismatch or no eligible payload | Verify `slotId`, `surfaceType`, and payload targeting. Start with `createSlotPlacementRequest(...)`. |
| Entitlement check denies with `config_unavailable` or `sdk_disabled_provider_failure` | Playbook fetch or configured provider failed | Verify endpoint availability, auth headers, and provider health. See [Client vs Server Enforcement](https://revturbine.com/docs/concepts/enforcement/) for the authoritative fallback contract. |
| A gate denies on a cold load and never flips | Nothing — the SDK absorbs this now (BL-0179). `checkEntitlement` waits out an in-flight Playbook load and re-evaluates, and a mounted gate stays `isLoading` (no `gate_evaluated`) until the real verdict lands, so a deny you still see means no config is coming | Do **not** add a caller-side `recheck()`. Gate paywall UI on `!can && !isLoading`, never on `!can` alone, and check that a Playbook actually reaches the SDK. |
| A slot renders its `fallback` on a cold load and never updates | Nothing — the SDK absorbs this now (BL-0177). A placement decision waits out an in-flight Playbook load and re-decides when a late one lands, so a `config_unavailable` a slot still ends on means no config is coming | Do **not** add a caller-side retry. Check that a Playbook actually reaches the SDK: the `publicKey` / `endpoint` the launched Playbook is served from, or the `configProvider` you supplied. The resolution-failure diagnostic names the placement. |
| CTA path not firing expected action | Payload action field mismatch (`cta_path` vs legacy shape) | Use canonical `cta_path` in payloads and parse via `PlacementRenderer`. |
| Decisions feel stale | Cache TTL too long | Lower `ttlMs` in decision requests or call refresh flows explicitly. |
| Interactions not visible in backend telemetry | Ingestion endpoint misconfigured | Validate `ingestEvents`/`touchpointTransition` endpoint wiring and auth. |
| Runtime mode behavior is incorrect | Wrong mode or incomplete mode config | Re-check mode selection in the runtime guide and use mode helper builders. |
| Console warns primary provider failed, then SDK behavior changes | Provider chain is failing and SDK entered fail-closed mode after fallback exhaustion | Configure `providerFallbacks`, verify provider health, and choose `providerFailureSlotBehavior` (`placeholder` or `invisible`) intentionally. |
| Type is `unknown` from SDK route | Contract/schema title mismatch | Fix source schema title alignment in `revturbine-scaffold` and regenerate. |
| Build fails after SDK API changes | Missing migration updates in caller code | Migrate to object-style request helpers and rerun typecheck. |

## Provider Failure Notes

When all configured providers fail for `getPlacement`, `checkEntitlement`, or `identify`, the SDK disables itself to avoid inconsistent behavior.

In this state:

1. The SDK logs warning messages to the console.
2. Placements render as hidden (`invisible`) or safe placeholders (`placeholder`) depending on `providerFailureSlotBehavior`.
3. Entitlement checks return a denied result with `sdk_disabled_provider_failure`; see [Client vs Server Enforcement](https://revturbine.com/docs/concepts/enforcement/) for why checks and additive placements have different fallback behavior.

## Quick Checks

1. Run API type checks:

```bash
npm --prefix web run typecheck:sdk-api
```

2. Run web build:

```bash
npm --prefix web run build
```

3. Validate SDK docs generation:

```bash
npm --prefix web run docs:sdk
```
