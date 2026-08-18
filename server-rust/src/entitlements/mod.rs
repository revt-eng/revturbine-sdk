//! Entitlement evaluation — the §2.6.5 most-permissive evaluator and its
//! supporting predicates.
//!
//! Ported from `server-python/src/revturbine/core/entitlements/`, which is
//! itself a port of `revturbine-scaffold/src/entitlements/controllers/`. The
//! TypeScript remains canonical; a divergence here is a Rust-port bug.

pub mod entitlement_check;
pub mod rules;
pub mod segment_matching;
pub mod unlimited;

pub use entitlement_check::{
    derive_local_entitlement_from_configured_rules, derive_result_from_rule_type_fields,
    is_rule_shaped_kind, LocalEntitlementInput,
};
pub use rules::{
    evaluate_entitlement_rules, evaluate_plan_rules, find_matching_entitlement_rule,
    pick_most_permissive, rule_permissiveness, EntitlementRuleEvaluation, RuleEvaluationContext,
};
pub use segment_matching::matches_rule_segments;
pub use unlimited::{is_unlimited_limit, resolve_limit_value, UNLIMITED_SENTINEL};
