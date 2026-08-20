//! Playbook-rule entitlement evaluation.
//!
//! Mirrors `server-python/tests/entitlements/test_entitlement_check.py` case
//! for case, so a behavioural divergence between the two ports shows up here
//! rather than only as an opaque parity byte-diff at TASK-10.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use revturbine::decisions::EntitlementCheckResult;
use revturbine::entitlements::{
    derive_local_entitlement_from_configured_rules, derive_result_from_rule_type_fields,
    is_rule_shaped_kind, LocalEntitlementInput,
};

/// A config with one entitlement and the given rules, all targeting `pro`.
///
/// Every reference — the entitlement's and the plan's — is authored by
/// `unique_handle`, and that is load-bearing rather than incidental: the plan
/// deliberately carries a DB-internal `id` (`plan_pro`) that differs from its
/// handle, so a rule that referenced the id would match nothing. See
/// `rule_entitlement_id_must_reference_the_handle_not_a_separate_id` and
/// `plan_identity_is_the_handle_never_the_db_id` below (plan 191 REQ-1).
fn config(entitlement_type: &str, rules: Value) -> Value {
    json!({
        "entitlements": [
            { "unique_handle": "feat_x", "type": entitlement_type }
        ],
        "plans": [{ "id": "plan_pro", "unique_handle": "pro" }],
        "entitlement_rules": rules,
    })
}

fn input<'a>(handle: &'a str, plan: &'a str) -> LocalEntitlementInput<'a> {
    LocalEntitlementInput {
        handle,
        current_plan_handle: plan,
        segment_ids: HashSet::new(),
        usage_balances: HashMap::new(),
        context_used: None,
        user_usage: None,
    }
}

fn derive(cfg: &Value, inp: &LocalEntitlementInput) -> EntitlementCheckResult {
    derive_local_entitlement_from_configured_rules(inp, cfg).expect("config present")
}

// ── feature ─────────────────────────────────────────────────────────────────

#[test]
fn feature_enabled_is_allowed_with_no_reason() {
    let cfg = config(
        "feature",
        json!([{ "entitlement_id": "feat_x", "plan_ids": ["pro"], "enabled": true }]),
    );
    let r = derive(&cfg, &input("feat_x", "pro"));
    assert_eq!(r.status, "allowed");
    assert!(r.allowed);
    // The TS omits `reason` here, so the Rust side must too — the parity
    // byte-diff depends on absence, not on a null.
    assert_eq!(r.reason, None);
}

#[test]
fn feature_disabled_is_denied() {
    let cfg = config(
        "feature",
        json!([{ "entitlement_id": "feat_x", "plan_ids": ["pro"], "enabled": false }]),
    );
    let r = derive(&cfg, &input("feat_x", "pro"));
    assert_eq!(r.status, "denied");
    assert!(!r.allowed);
    assert_eq!(r.reason.as_deref(), Some("feature_not_enabled_for_plan"));
}

#[test]
fn feature_enabled_defaults_true_when_unset() {
    // `!== false`, not truthiness: an absent flag grants.
    let cfg = config(
        "feature",
        json!([{ "entitlement_id": "feat_x", "plan_ids": ["pro"] }]),
    );
    assert!(derive(&cfg, &input("feat_x", "pro")).allowed);
}

// ── matching / fail-closed ──────────────────────────────────────────────────

#[test]
fn no_rule_for_handle_denies_fail_closed() {
    let cfg = config(
        "feature",
        json!([{ "entitlement_id": "ent_other", "plan_ids": ["pro"], "enabled": true }]),
    );
    let r = derive(&cfg, &input("feat_x", "pro"));
    assert_eq!(r.status, "denied");
    assert!(!r.allowed);
    assert_eq!(r.reason.as_deref(), Some("no_matching_entitlement_rule"));
}

#[test]
fn plan_targeting_is_explicit_only() {
    // Plan 34 REQ-9: an empty plan target grants NOTHING. The old implicit
    // "empty ⇒ all plans" is exactly the fail-open this guards against.
    let cfg = config(
        "feature",
        json!([{ "entitlement_id": "feat_x", "plan_ids": [], "enabled": true }]),
    );
    let r = derive(&cfg, &input("feat_x", "pro"));
    assert_eq!(r.reason.as_deref(), Some("no_matching_entitlement_rule"));
}

#[test]
fn entitlement_matched_by_unique_handle() {
    let cfg = config(
        "feature",
        json!([{ "entitlement_id": "feat_x", "plan_ids": ["pro"], "enabled": true }]),
    );
    assert!(derive(&cfg, &input("feat_x", "pro")).allowed);
}

#[test]
fn rule_entitlement_id_must_reference_the_handle_not_a_separate_id() {
    // This test used to pin a fail-open: because the port resolved
    // `entitlement_id` to the entitlement's DB `id` while deriving `kind` from
    // a map keyed by `unique_handle`, an id-referencing rule MATCHED but
    // derived no kind, fell through to the unknown-kind default, and silently
    // returned allowed. Plan 191 TASK-5 removed the `id` resolution (TS has
    // matched by handle alone since plan 120 TASK-4), so the id-referencing
    // rule now simply does not match — and the absence of a matching rule
    // fails CLOSED.
    let cfg = json!({
        "entitlements": [
            { "id": "ent_x", "unique_handle": "feat_x", "type": "feature" }
        ],
        "plans": [{ "id": "plan_pro", "unique_handle": "pro" }],
        "entitlement_rules": [
            { "entitlement_id": "ent_x", "plan_ids": ["pro"], "enabled": false }
        ],
    });
    let r = derive(&cfg, &input("feat_x", "pro"));
    assert_eq!(
        r.reason.as_deref(),
        Some("no_matching_entitlement_rule"),
        "a rule referencing the DB id matches nothing and fails closed",
    );
    assert!(!r.allowed);

    // Authored by handle, the same rule enforces — an entitlement carrying a
    // separate `id` no longer changes anything, because the id is inert.
    let by_handle = json!({
        "entitlements": [
            { "id": "ent_x", "unique_handle": "feat_x", "type": "feature" }
        ],
        "plans": [{ "id": "plan_pro", "unique_handle": "pro" }],
        "entitlement_rules": [
            { "entitlement_id": "feat_x", "plan_ids": ["pro"], "enabled": false }
        ],
    });
    assert_eq!(
        derive(&by_handle, &input("feat_x", "pro"))
            .reason
            .as_deref(),
        Some("feature_not_enabled_for_plan"),
    );
}

/// Plan 194 REQ-1 — an unresolvable plan identity DENIES.
///
/// The rule filter used to skip the plan check when no identity resolved, so
/// every plan-targeted rule matched and a plan-gated entitlement came back
/// allowed for a user with no plan. Byte parity with TS and Python is locked
/// by the `entitlement_no_plan_identity_denies` fixture.
#[test]
fn no_plan_identity_fails_closed() {
    let cfg = config(
        "feature",
        json!([{ "entitlement_id": "feat_x", "plan_ids": ["pro"], "enabled": true }]),
    );

    // Control: the targeted handle still grants, so a blanket deny cannot pass.
    assert!(derive(&cfg, &input("feat_x", "pro")).allowed);

    for unresolvable in ["", "   ", "\t"] {
        let r = derive(&cfg, &input("feat_x", unresolvable));
        assert!(!r.allowed, "identity {unresolvable:?} must not grant");
        assert_eq!(r.reason.as_deref(), Some("no_plan_identity"));
    }

    // Both deny, but a dashboard has to tell a broken integration apart from a
    // correctly-gated user, so the reasons must not collapse.
    let no_identity = derive(&cfg, &input("feat_x", ""));
    let untargeted = derive(&cfg, &input("feat_x", "starter"));
    assert!(!untargeted.allowed);
    assert_ne!(no_identity.reason, untargeted.reason);
}

/// Plan 191 REQ-1 / AC-1 — plan identity IS the handle; `plans[].id` is
/// DB-internal and matches nothing. Mirrors
/// `TestHandleIsTheOnlyIdentity` in the Python port and the
/// `entitlement_plan_identity_is_handle` parity fixture.
#[test]
fn plan_identity_is_the_handle_never_the_db_id() {
    let cfg = config(
        "feature",
        json!([{ "entitlement_id": "feat_x", "plan_ids": ["pro"], "enabled": true }]),
    );

    // The handle matches.
    assert!(derive(&cfg, &input("feat_x", "pro")).allowed);

    // A context whose only plan signal is the DB id matches no plan-targeted
    // rule, and the absence of a matching rule fails closed.
    let by_db_id = derive(&cfg, &input("feat_x", "plan_pro"));
    assert!(!by_db_id.allowed);
    assert_eq!(
        by_db_id.reason.as_deref(),
        Some("no_matching_entitlement_rule"),
    );

    // Symmetrically: a rule that targets the DB id matches nobody.
    let targets_db_id = config(
        "feature",
        json!([{ "entitlement_id": "feat_x", "plan_ids": ["plan_pro"], "enabled": true }]),
    );
    assert_eq!(
        derive(&targets_db_id, &input("feat_x", "pro"))
            .reason
            .as_deref(),
        Some("no_matching_entitlement_rule"),
    );
}

#[test]
fn plan_handle_matching_is_case_insensitive() {
    let cfg = config(
        "feature",
        json!([{ "entitlement_id": "feat_x", "plan_ids": ["pro"], "enabled": true }]),
    );
    assert!(derive(&cfg, &input("feat_x", "PRO")).allowed);
}

// ── usage_limit + the plan-34 REQ-3 enforcement matrix ──────────────────────

fn usage_cfg(enforcement: Option<&str>) -> Value {
    let mut rule = json!({
        "entitlement_id": "feat_x",
        "plan_ids": ["pro"],
        "kind": "usage_limit",
        "limit_value": 10,
    });
    if let Some(e) = enforcement {
        rule["enforcement"] = json!(e);
    }
    config("usage_limit", json!([rule]))
}

fn at_usage(used: f64) -> LocalEntitlementInput<'static> {
    LocalEntitlementInput {
        context_used: Some(used),
        ..input("feat_x", "pro")
    }
}

#[test]
fn under_the_limit_is_allowed_regardless_of_enforcement() {
    for mode in [None, Some("hard_block"), Some("degrade")] {
        let r = derive(&usage_cfg(mode), &at_usage(5.0));
        assert_eq!(r.status, "allowed", "mode {mode:?}");
        assert!(r.allowed);
    }
}

#[test]
fn hard_block_denies_at_the_limit() {
    let r = derive(&usage_cfg(Some("hard_block")), &at_usage(10.0));
    assert_eq!(r.status, "denied");
    assert!(!r.allowed);
    assert_eq!(r.reason.as_deref(), Some("usage_limit_reached"));
}

#[test]
fn soft_block_denies_with_a_suffixed_reason() {
    let r = derive(&usage_cfg(Some("soft_block")), &at_usage(10.0));
    assert_eq!(r.status, "denied");
    assert!(!r.allowed);
    assert_eq!(r.reason.as_deref(), Some("usage_limit_reached_soft_block"));
}

#[test]
fn degrade_is_limited_but_allowed() {
    // The one mode where `limited` still grants access — easy to get backwards.
    let r = derive(&usage_cfg(Some("degrade")), &at_usage(10.0));
    assert_eq!(r.status, "limited");
    assert!(r.allowed, "degrade must ALLOW");
    assert_eq!(r.reason.as_deref(), Some("usage_limit_reached_degraded"));
}

#[test]
fn allow_overage_stays_allowed() {
    let r = derive(&usage_cfg(Some("allow_overage")), &at_usage(99.0));
    assert_eq!(r.status, "allowed");
    assert!(r.allowed);
    assert_eq!(r.reason.as_deref(), Some("usage_limit_reached_overage"));
}

#[test]
fn unset_enforcement_is_limited_and_not_allowed() {
    // Contrast with `degrade`: same status, opposite `allowed`.
    let r = derive(&usage_cfg(None), &at_usage(10.0));
    assert_eq!(r.status, "limited");
    assert!(!r.allowed, "unset enforcement must DENY");
    assert_eq!(r.reason.as_deref(), Some("usage_limit_reached"));
}

#[test]
fn limit_bearing_results_carry_limit_used_remaining_as_integers() {
    let r = derive(&usage_cfg(Some("hard_block")), &at_usage(10.0));
    // Integral values must serialize as `10`, not `10.0` — JS has one number
    // type and the byte-diff would fail on the decimal point.
    assert_eq!(r.limit.as_ref().unwrap().to_string(), "10");
    assert_eq!(r.used.as_ref().unwrap().to_string(), "10");
    assert_eq!(r.remaining.as_ref().unwrap().to_string(), "0");
}

#[test]
fn remaining_never_goes_negative() {
    let r = derive(&usage_cfg(Some("allow_overage")), &at_usage(99.0));
    assert_eq!(r.remaining.as_ref().unwrap().to_string(), "0");
}

#[test]
fn unlimited_limit_is_allowed_without_limit_fields() {
    let cfg = config(
        "usage_limit",
        json!([{
            "entitlement_id": "feat_x", "plan_ids": ["pro"],
            "kind": "usage_limit", "limit_value": "unlimited",
        }]),
    );
    let r = derive(&cfg, &at_usage(1_000_000.0));
    assert_eq!(r.status, "allowed");
    assert_eq!(r.limit, None, "unlimited carries no limit fields");
}

// ── credits ─────────────────────────────────────────────────────────────────

#[test]
fn credits_allowance_exhausted() {
    let cfg = config(
        "credits",
        json!([{
            "entitlement_id": "feat_x", "plan_ids": ["pro"],
            "kind": "credits", "allowance_value": 100, "enforcement": "hard_block",
        }]),
    );
    let r = derive(&cfg, &at_usage(100.0));
    assert_eq!(r.status, "denied");
    assert_eq!(r.reason.as_deref(), Some("credit_balance_exhausted"));
}

#[test]
fn credits_fall_back_to_initial_grant_only_when_allowance_absent() {
    let cfg = config(
        "credits",
        json!([{
            "entitlement_id": "feat_x", "plan_ids": ["pro"],
            "kind": "credits", "initial_grant": 25, "enforcement": "hard_block",
        }]),
    );
    let r = derive(&cfg, &at_usage(25.0));
    assert_eq!(r.status, "denied");
    assert_eq!(r.limit.as_ref().unwrap().to_string(), "25");
}

#[test]
fn an_explicit_null_allowance_means_unlimited_and_beats_initial_grant() {
    // Presence, not resolution, picks the source: a null allowance_value is an
    // EXPLICIT unlimited and must not fall through to initial_grant.
    let cfg = config(
        "credits",
        json!([{
            "entitlement_id": "feat_x", "plan_ids": ["pro"],
            "kind": "credits", "allowance_value": null, "initial_grant": 5,
        }]),
    );
    let r = derive(&cfg, &at_usage(1_000.0));
    assert_eq!(r.status, "allowed");
    assert_eq!(r.limit, None);
}

// ── capability_tier ─────────────────────────────────────────────────────────

#[test]
fn capability_tier_emits_current_tier() {
    let cfg = config(
        "capability_tier",
        json!([{
            "entitlement_id": "feat_x", "plan_ids": ["pro"],
            "kind": "capability_tier", "tier_name": "gold",
        }]),
    );
    let r = derive(&cfg, &input("feat_x", "pro"));
    assert_eq!(r.status, "allowed");
    assert_eq!(r.current_tier.as_deref(), Some("gold"));
}

#[test]
fn capability_tier_without_a_name_omits_current_tier() {
    let cfg = config(
        "capability_tier",
        json!([{
            "entitlement_id": "feat_x", "plan_ids": ["pro"],
            "kind": "capability_tier",
        }]),
    );
    assert_eq!(derive(&cfg, &input("feat_x", "pro")).current_tier, None);
}

// ── §2.6.5 most-permissive selection ────────────────────────────────────────

#[test]
fn most_permissive_rule_wins_over_array_order() {
    // Both rules match; the SECOND is more permissive, so array order must not
    // decide. This is the §2.6.5 guarantee.
    let cfg = config(
        "usage_limit",
        json!([
            { "entitlement_id": "feat_x", "plan_ids": ["pro"], "kind": "usage_limit", "limit_value": 5 },
            { "entitlement_id": "feat_x", "plan_ids": ["pro"], "kind": "usage_limit", "limit_value": 500 },
        ]),
    );
    let r = derive(&cfg, &at_usage(10.0));
    assert_eq!(r.status, "allowed", "the 500 limit should govern");
    assert_eq!(r.limit.as_ref().unwrap().to_string(), "500");
}

#[test]
fn kind_is_derived_from_the_parent_entitlement_when_the_rule_omits_it() {
    // Plan 147: the wire is flat and `kind` comes from the entitlement's
    // `type`. Without the derivation this would fall to the unknown-kind
    // default (allowed) and silently stop enforcing.
    let cfg = config(
        "usage_limit",
        json!([{
            "entitlement_id": "feat_x", "plan_ids": ["pro"], "limit_value": 10,
            "enforcement": "hard_block",
        }]),
    );
    let inp = LocalEntitlementInput {
        context_used: Some(10.0),
        ..input("feat_x", "pro")
    };
    // entitlement_id here is the HANDLE, which is what the type map is keyed by.
    let r = derive(&cfg, &inp);
    assert_eq!(r.status, "denied", "derived kind must enforce the limit");
}

// ── `used` resolution precedence ────────────────────────────────────────────

#[test]
fn context_used_wins_over_balances_and_usage() {
    let cfg = usage_cfg(Some("hard_block"));
    let mut balances = HashMap::new();
    balances.insert("feat_x".to_string(), 0.0);
    let inp = LocalEntitlementInput {
        context_used: Some(10.0),
        usage_balances: balances,
        ..input("feat_x", "pro")
    };
    assert_eq!(derive(&cfg, &inp).status, "denied");
}

#[test]
fn a_zero_balance_is_used_not_skipped() {
    // The nullish-coalescing subtlety: `0` is a legitimate value and must not
    // fall through to the next source the way a truthiness check would let it.
    let cfg = usage_cfg(Some("hard_block"));
    let mut balances = HashMap::new();
    balances.insert("feat_x".to_string(), 0.0);
    let usage = json!({ "feat_x": { "amount": 99 } });
    let inp = LocalEntitlementInput {
        usage_balances: balances,
        user_usage: Some(&usage),
        ..input("feat_x", "pro")
    };
    let r = derive(&cfg, &inp);
    assert_eq!(r.status, "allowed", "balance 0 must win over usage 99");
    assert_eq!(r.used.as_ref().unwrap().to_string(), "0");
}

#[test]
fn falls_through_to_user_usage_when_no_balance() {
    let cfg = usage_cfg(Some("hard_block"));
    let usage = json!({ "feat_x": { "amount": 10 } });
    let inp = LocalEntitlementInput {
        user_usage: Some(&usage),
        ..input("feat_x", "pro")
    };
    assert_eq!(derive(&cfg, &inp).status, "denied");
}

// ── shaper + helper surface ─────────────────────────────────────────────────

#[test]
fn rule_shaped_kinds_are_exactly_the_five() {
    for k in [
        "feature",
        "usage_limit",
        "limit",
        "credits",
        "capability_tier",
    ] {
        assert!(is_rule_shaped_kind(k), "{k} should be rule-shaped");
    }
    // `metered` proves a plan assignment but must fall through to provider
    // logic rather than the shaper's default.
    for k in ["metered", "seat", "", "unknown"] {
        assert!(!is_rule_shaped_kind(k), "{k} should NOT be rule-shaped");
    }
}

#[test]
fn limit_is_the_authoring_shorthand_for_usage_limit() {
    let a = derive_result_from_rule_type_fields(
        &json!({ "kind": "usage_limit", "limit_value": 10, "enforcement": "hard_block" }),
        10.0,
    );
    let b = derive_result_from_rule_type_fields(
        &json!({ "kind": "limit", "limit_value": 10, "enforcement": "hard_block" }),
        10.0,
    );
    assert_eq!(a, b);
}

#[test]
fn unknown_kinds_default_to_allowed() {
    let r = derive_result_from_rule_type_fields(&json!({ "kind": "mystery" }), 0.0);
    assert_eq!(r.status, "allowed");
    assert!(r.allowed);
}

#[test]
fn results_serialize_with_absent_optional_fields() {
    // The wire shape the parity byte-diff compares: no nulls for unset fields.
    let r = derive_result_from_rule_type_fields(&json!({ "kind": "feature" }), 0.0);
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v, json!({ "status": "allowed", "allowed": true }));
}
