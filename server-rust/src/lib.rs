//! RevTurbine SDK for Rust — the headless, local-mode decision core.
//!
//! A stateless, in-memory port of the same decision substrate the TypeScript
//! core and the Python port implement, proven identical by the cross-language
//! parity gate (`tests/parity/`, plan 185 TASK-1/TASK-10). Construct from a
//! user context plus a Playbook, then ask it two questions:
//!
//! - is a feature or limit allowed for this user? (`check_entitlement`)
//! - which placement payload, if any, should this user see?
//!   (`get_placement_decision` / `get_placement_decisions`)
//!
//! # Scope
//!
//! This crate mirrors [`server-python`] exactly: the
//! `create_static_providers` → `LocalRuntime` substrate plus a thin
//! pass-through public type. It is deliberately **not** a port of the browser
//! SDK. Out of scope, and intentionally absent (plan 33 REQ-14, inherited by
//! plan 185 REQ-2): `identify`, dismiss/snooze/convert, treatment-interaction
//! tracking, `capture`, `bootstrap_placement_decisions`, decision-cache and
//! interaction-state hydration, HTTP-backed dual-mode dispatch, segment and
//! personalization-token derivation from raw traits, analytics, theming, and
//! browser storage.
//!
//! The decision core is **synchronous** — it performs no I/O, so there is no
//! runtime dependency and no `async` on the public surface (plan 185 REQ-9).
//!
//! [`server-python`]: https://pypi.org/project/revturbine/
//!
//! # Status
//!
//! Complete and parity-locked. The decision core is byte-identical to the
//! canonical TypeScript across the whole shared fixture corpus, enforced on
//! every commit by `tests/parity/` (plan 185 TASK-10).
//!
//! Start at [`sdk::RevTurbineCustomerSdk`] — the public surface — or drop to
//! [`runtime::LocalRuntime`] for the composition layer beneath it.

// The generated type surface is a mechanical projection of the JSON Schema and
// is not ours to hand-fix, so its lints are suppressed at the MODULE BOUNDARY —
// never by editing the generated file, and never by relaxing the crate-wide
// settings that guard hand-written code.
//
// - `missing_docs`: the schema documents these types; typify does not emit
//   per-field doc comments.
// - `dead_code`: typify emits its full `defaults` helper set regardless of
//   which ones a given schema bundle uses.
// - `clippy::all`: generated code trips ~33 style lints (`derivable_impls`,
//   etc). Fixing them would mean editing a file the next `sync:rust-types`
//   overwrites.
pub mod adapters;
pub mod canonical_json;
pub mod config;
pub mod crypto;
pub mod decisions;
pub mod entitlements;
pub mod helpers;
pub mod js_num;
pub mod placements;
pub mod rules;
pub mod runtime;
pub mod sdk;
pub mod state;
pub mod trials;

#[allow(missing_docs, dead_code, clippy::all)]
pub mod types;

/// The crate version, kept in lockstep with the TypeScript and Python SDKs.
///
/// All three packages carry the same version number by release policy, so this
/// is a reliable way to report which contract generation a service is running.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_populated() {
        // Lockstep versions are plain semver — no pre-release suffixes.
        assert_eq!(
            VERSION.split('.').count(),
            3,
            "expected X.Y.Z, got {VERSION}"
        );
    }

    /// A minimal but *valid* `Plan` — every field the schema marks required,
    /// and nothing it does not know about (the generated structs reject
    /// unknown fields).
    fn plan_json() -> serde_json::Value {
        serde_json::json!({
            "anchor_id": "plan_anchor_starter",
            "created_at": "2026-08-14T00:00:00Z",
            "handle": "starter",
            "id": "plan_starter",
            "name": "Starter",
            "tenant_id": "tenant_parity",
            "updated_at": "2026-08-14T00:00:00Z",
        })
    }

    #[test]
    fn generated_types_are_reachable_and_deserialize() {
        // The skeleton's real assertion: the vendored artifact is not merely
        // present, it is a usable serde surface for a representative domain
        // type. Also pins the field names — `handle`, not `unique_handle`.
        let plan: types::Plan =
            serde_json::from_value(plan_json()).expect("Plan should deserialize");
        assert_eq!(&*plan.handle, "starter");
        assert_eq!(&*plan.name, "Starter");
    }

    #[test]
    fn schema_defaults_are_applied() {
        // Fields the schema defaults must materialize without being supplied —
        // this is what makes the generated surface faithful rather than merely
        // structurally similar.
        let plan: types::Plan = serde_json::from_value(plan_json()).unwrap();
        assert!(plan.is_current, "is_current should default to true");
        assert!(!plan.is_deleted, "is_deleted should default to false");
        assert_eq!(plan.sequence.get(), 1, "sequence should default to 1");
    }

    #[test]
    fn unknown_fields_are_rejected() {
        // The wire contract is closed: a Playbook carrying a field this
        // contract generation does not know about must fail loudly rather than
        // decide on a silently-dropped value.
        let mut json = plan_json();
        json["not_a_real_field"] = serde_json::json!(true);
        assert!(serde_json::from_value::<types::Plan>(json).is_err());
    }
}
