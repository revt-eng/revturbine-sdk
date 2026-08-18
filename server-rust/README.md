# revturbine — RevTurbine SDK for Rust

Headless, local-mode placement and entitlement decisioning. A stateless,
in-memory port of the same decision core the TypeScript SDK and the Python port
implement, held **byte-identical** to them by a cross-language parity gate.

Given a user context and a Playbook, it answers two questions:

- **`check_entitlement`** — is a feature or limit allowed for this user?
- **`get_placement_decision`** / **`get_placement_decisions`** — which placement
  payload, if any, should this user see?

No network call, no persistence, no async runtime. An entitlement gate is a
pure in-process computation, safe on a request hot path.

## Install

```toml
[dependencies]
revturbine = "0.2"
```

MSRV is **1.88**, declared as `rust-version` in `Cargo.toml`.

## Quick start

Construct one SDK per `(user_context, playbook)`:

```rust
use revturbine::runtime::PlacementDecisionInput;
use revturbine::sdk::{RevTurbineCustomerSdk, UserContext};
use serde_json::json;

let playbook: serde_json::Value =
    serde_json::from_str(&std::fs::read_to_string("playbook.json")?)?;

let user = UserContext {
    tenant_id: "tenant_abc".to_string(),
    user_id: "user_123".to_string(),
    // Optional — the user's current plan and usage:
    plan_handle: Some("pro".to_string()),
    usage: Some(json!({ "api_calls": { "used": 900, "limit": 1000 } })),
    ..Default::default()
};

let mut sdk = RevTurbineCustomerSdk::new(&user, &playbook)?;

// Entitlement gate. Read `allowed`, not `status` — the `degrade` enforcement
// mode is `limited` AND allowed.
let check = sdk.check_entitlement("advanced_analytics", None);
if !check.allowed {
    return Err(check.reason.unwrap_or_else(|| "denied".to_string()).into());
}

// Placement decision — which payload, if any, to show.
let decision = sdk.get_placement_decision(&PlacementDecisionInput {
    placement_id: "pl_dashboard_upsell".to_string(),
    user_id: "user_123".to_string(),
});
if decision["visible"] == true {
    render(&decision["output"]);
}
```

### User context

| Field | Required | Meaning |
|---|---|---|
| `tenant_id` | ✅ | Tenant identifier. |
| `user_id` | ✅ | Current user identifier. |
| `plan_handle` | — | The user's current plan handle (feeds the plan + entitlements providers). |
| `plan_name` | — | Display name; defaults to `plan_handle`. |
| `usage` | — | Per-entitlement overrides: `{handle: {used, limit}}`. |
| `trial_status` | — | Already-derived `UserTrialStatus`; overlaid onto the plan provider so `trial_*` gates can evaluate. |
| `payment_failed` | — | Billing-recovery signal for the retention qualifiers. |
| `payment_at_risk` | — | Billing-recovery signal for the retention qualifiers. |
| `tiers` | — | Current tier per `capability_tier` entitlement, for the tier gate. |

Everything but `tenant_id` / `user_id` is optional, and every optional field
that is absent decides as "not set" rather than as a default value.

Omitting `trial_status` is the one easy mistake: without it every `trial_*`
gate reads "no trial" and silently declines rather than erroring.

### Public surface

| Method | Returns |
|---|---|
| `check_entitlement(handle, context)` | `EntitlementCheckResult` |
| `get_placement_decision(input)` | `serde_json::Value` |
| `get_placement_decisions(inputs)` | `Vec<Value>`, order preserved |
| `get_placement(config)` | `Option<Value>` — surface-keyed slot resolution |

That is the entire public API. There is no storage or persistence parameter —
the instance is stateless by construction, so "refresh the Playbook" is just
"build a new SDK" and atomically swap the reference your handlers read.

A malformed Playbook is an **error at construction**, not a degraded decision:
`RevTurbineCustomerSdk::new` returns `Err`. A partially-understood Playbook can
silently over-grant, so it fails closed instead.

## Scope

This crate mirrors [`server-python`](../server-python/) exactly: the
`create_static_providers` → `LocalRuntime` substrate plus a thin,
output-transparent public type that adds zero decision logic of its own.

It is deliberately **not** a port of the browser SDK. Intentionally absent
(plan 33 REQ-14, inherited by plan 185 REQ-2): `identify`,
dismiss/snooze/convert, treatment-interaction tracking, `capture`,
`bootstrap_placement_decisions`, decision-cache and interaction-state
hydration, HTTP-backed dual-mode dispatch, segment and personalization-token
derivation from raw traits, analytics, theming, and browser storage.

## Parity guarantee

Every public method delegates to the same decision substrate the TypeScript SDK
uses. `tests/parity/` drives all three languages through one shared fixture
corpus and asserts **byte-identical** normalized output on every commit.

A divergence is a **Rust-port bug, never a fixture to loosen.** TypeScript is
canonical — including where it is arguably wrong, because a port that is "more
correct" in isolation is still divergent. Where the shared contract itself
needs to change, it changes in all three ports together.

## Naming and versioning

Distribution name and import name are both `revturbine`, unscoped — the Python
port's scheme verbatim. crates.io has no scoping mechanism, which makes the
unscoped PyPI name the exact analog rather than a compromise. (The TypeScript
packages stay scoped: `@revt-eng/sdk` internally, `@revturbine/sdk` publicly.)

The version is **lockstep** with `web-sdk/package.json` and
`server-python/pyproject.toml` — all three always carry the same number.

## Generated code

Two modules are generated and committed. Never hand-edit either; the next sync
silently discards the change.

| Module | Source of truth | Regenerate with |
|---|---|---|
| `src/types.rs` | scaffold Zod schemas → JSON Schema → typify | `node scripts/sync-rust-types.mjs` (repo root) |

The generator resolves revturbine-scaffold from `$REVTURBINE_SCAFFOLD_DIR`,
falling back to the sibling checkout. Set the env var when working from a git
worktree, where the sibling path does not resolve.

### Lints and generated code

The crate denies `unsafe_code` and `clippy::all`, and warns on `missing_docs`.
Generated modules are exempted **at the module boundary** in `src/lib.rs` —
never by editing the generated file and never by relaxing the crate-wide
setting.

## Development

```bash
cargo test
cargo clippy --all-targets   # denies clippy::all in hand-written code
cargo fmt --check
```

Raise the MSRV deliberately, never incidentally — customers pin against it.
