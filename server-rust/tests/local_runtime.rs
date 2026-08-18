//! `LocalRuntime` — the composition layer.
//!
//! Mirrors `server-python/tests/runtime/test_local_runtime.py` and
//! `tests/decisions/test_engine.py`. The pipeline is **suppression →
//! providers → resolver → caps**, and most of what matters here is *which*
//! stage answers first.

use serde_json::{json, Value};

use revturbine::adapters::{create_static_providers, EntitlementPolicy, StaticProviderOptions};
use revturbine::runtime::{LocalRuntime, PlacementDecisionInput};
use revturbine::state::TreatmentInteractionInput;

fn config() -> Value {
    json!({
        "version": "1",
        "entitlements": [{ "unique_handle": "exports", "type": "usage_limit" }],
        "placements": [{
            "id": "pl_banner",
            "category": "fixed",
            "order": 0,
            "payloads": [{
                "id": "pay_1",
                "status": "active",
                "surfaces": [{
                    "template_id": "banner_placement",
                    "fields": { "header": "Hello", "body": "Body" },
                    "ctas": [{ "label": "Go", "path": "view_plans" }],
                }],
            }],
        }],
    })
}

fn runtime(opts: StaticProviderOptions) -> LocalRuntime {
    let cfg = config();
    let providers = create_static_providers(&cfg, &opts);
    LocalRuntime::new(cfg, providers, "tenant_1", "user_1")
}

fn plan_opts() -> StaticProviderOptions {
    StaticProviderOptions {
        plan_handle: Some("starter".into()),
        ..Default::default()
    }
}

fn input() -> PlacementDecisionInput {
    PlacementDecisionInput {
        placement_id: "pl_banner".into(),
        user_id: "user_1".into(),
    }
}

fn dismissal() -> TreatmentInteractionInput<'static> {
    TreatmentInteractionInput {
        placement_id: "pl_banner",
        user_id: "user_1",
        treatment_id: None,
        interaction_type: "dismiss",
        interaction_at: None,
        metadata: None,
    }
}

// ── Placement pipeline ──────────────────────────────────────────────────────

#[test]
fn resolves_a_placement_through_the_full_pipeline() {
    let mut rt = runtime(plan_opts());
    let d = rt.get_placement_decision(&input());

    assert_eq!(d["visible"], json!(true));
    assert_eq!(d["content"]["header"], json!("Hello"));
    assert_eq!(d["decision_source"], json!("fallback"));
}

#[test]
fn interaction_suppression_answers_before_the_resolver_runs() {
    // A dismissed placement must not even be resolved — the suppression is
    // the earlier and more specific answer.
    let mut rt = runtime(plan_opts());
    assert_eq!(rt.get_placement_decision(&input())["visible"], json!(true));

    rt.track_interaction(&dismissal());
    let d = rt.get_placement_decision(&input());

    assert_eq!(d["visible"], json!(false));
    assert_eq!(
        d["decision_source"],
        json!("cache"),
        "not the resolver's 'fallback'"
    );
    assert_eq!(d["reason_codes"], json!(["suppressed_by_dismiss_cooldown"]));
    assert_eq!(
        d["suppression_reason"],
        json!("suppressed_by_dismiss_cooldown")
    );
    assert!(
        d.get("output").is_none(),
        "no output — nothing was resolved"
    );
}

#[test]
fn clearing_suppression_restores_the_decision() {
    let mut rt = runtime(plan_opts());
    rt.track_interaction(&dismissal());
    assert_eq!(rt.get_placement_decision(&input())["visible"], json!(false));

    rt.clear_suppression("pl_banner", "user_1");
    assert_eq!(rt.get_placement_decision(&input())["visible"], json!(true));
}

#[test]
fn a_batch_preserves_input_order() {
    // Order is decision-semantic — the batch fixture asserts it end to end.
    let mut rt = runtime(plan_opts());
    let inputs = vec![
        PlacementDecisionInput {
            placement_id: "missing_a".into(),
            user_id: "user_1".into(),
        },
        input(),
        PlacementDecisionInput {
            placement_id: "missing_b".into(),
            user_id: "user_1".into(),
        },
    ];
    let out = rt.get_placement_decisions(&inputs);

    assert_eq!(out.len(), 3);
    assert_eq!(out[0]["placement_id"], json!("missing_a"));
    assert_eq!(out[1]["placement_id"], json!("pl_banner"));
    assert_eq!(out[1]["visible"], json!(true));
    assert_eq!(out[2]["placement_id"], json!("missing_b"));
}

// ── Cap enforcement ─────────────────────────────────────────────────────────

fn config_with_caps() -> Value {
    let mut c = config();
    c["placements"][0]["payloads"][0]["surfaces"][0]["fields"]["caps"] =
        json!({ "max_per_period": { "count": 1, "period": "day" } });
    c
}

#[test]
fn caps_suppress_a_repeat_presentation_but_keep_the_output() {
    let cfg = config_with_caps();
    let providers = create_static_providers(&cfg, &plan_opts());
    let mut rt = LocalRuntime::new(cfg, providers, "tenant_1", "user_1");

    let first = rt.get_placement_decision(&input());
    assert_eq!(first["visible"], json!(true), "first presentation allowed");

    let second = rt.get_placement_decision(&input());
    assert_eq!(second["visible"], json!(false));
    assert_eq!(
        second["suppression_reason"],
        json!("suppressed_by_payload_cap_day")
    );
    assert!(
        second.get("output").is_some(),
        "the output stays attached — the decision was made, then capped",
    );
}

#[test]
fn cap_enforcement_can_be_turned_off() {
    let cfg = config_with_caps();
    let providers = create_static_providers(&cfg, &plan_opts());
    let mut rt =
        LocalRuntime::new(cfg, providers, "tenant_1", "user_1").with_caps_enforcement(false);

    for _ in 0..5 {
        assert_eq!(rt.get_placement_decision(&input())["visible"], json!(true));
    }
}

#[test]
fn an_invisible_decision_does_not_consume_the_cap_budget() {
    // Otherwise a suppressed placement would burn the user's allowance and
    // never recover.
    let cfg = config_with_caps();
    let providers = create_static_providers(&cfg, &plan_opts());
    let mut rt = LocalRuntime::new(cfg, providers, "tenant_1", "user_1");

    rt.track_interaction(&dismissal());
    for _ in 0..3 {
        rt.get_placement_decision(&input()); // suppressed, never presented
    }
    rt.clear_suppression("pl_banner", "user_1");

    assert_eq!(
        rt.get_placement_decision(&input())["visible"],
        json!(true),
        "the cap budget was untouched while suppressed",
    );
}

// ── Entitlements ────────────────────────────────────────────────────────────

#[test]
fn a_provider_backed_entitlement_reports_its_default_policy() {
    let rt = runtime(plan_opts());
    let r = rt.check_entitlement("exports", None);
    assert!(r.allowed);
    assert_eq!(r.status, "allowed");
    assert_eq!(r.reason.as_deref(), Some("static_config_default_allow"));
}

#[test]
fn an_unknown_handle_falls_to_the_default_policy() {
    let allow = runtime(plan_opts());
    let r = allow.check_entitlement("not_configured", None);
    assert!(r.allowed);
    assert_eq!(
        r.reason.as_deref(),
        Some("entitlement_not_found_default_allow")
    );

    let cfg = config();
    let providers = create_static_providers(&cfg, &plan_opts());
    let deny = LocalRuntime::new(cfg, providers, "tenant_1", "user_1")
        .with_entitlement_policy(EntitlementPolicy::Deny);
    let r2 = deny.check_entitlement("not_configured", None);
    assert!(!r2.allowed);
    assert_eq!(
        r2.reason.as_deref(),
        Some("entitlement_not_found_default_deny")
    );
}

#[test]
fn usage_counters_ride_along_on_the_result() {
    let rt = runtime(StaticProviderOptions {
        usage: Some(json!({ "exports": { "used": 3, "limit": 10 } })),
        ..plan_opts()
    });
    let r = rt.check_entitlement("exports", None);
    assert!(r.allowed);
    assert_eq!(
        r.limit.as_ref().and_then(serde_json::Number::as_f64),
        Some(10.0)
    );
    assert_eq!(
        r.used.as_ref().and_then(serde_json::Number::as_f64),
        Some(3.0)
    );
    assert_eq!(
        r.remaining.as_ref().and_then(serde_json::Number::as_f64),
        Some(7.0)
    );
}

#[test]
fn caller_supplied_usage_enforces_the_limit() {
    let rt = runtime(StaticProviderOptions {
        usage: Some(json!({ "exports": { "used": 0, "limit": 10 } })),
        ..plan_opts()
    });

    let under = rt.check_entitlement("exports", Some(&json!({ "used": 9 })));
    assert!(under.allowed, "under the limit");

    let at = rt.check_entitlement("exports", Some(&json!({ "used": 10 })));
    assert!(!at.allowed, "AT the limit is exceeded — the check is >=");
    assert_eq!(at.reason.as_deref(), Some("usage_limit_exceeded"));
    assert_eq!(
        at.remaining.as_ref().and_then(serde_json::Number::as_f64),
        Some(0.0)
    );
}

#[test]
fn a_configured_rule_is_authoritative_over_the_provider_default() {
    // Plan 133. A rule assigning the entitlement to the user's plan shapes
    // the result; the provider's default-policy status does not survive it.
    let mut cfg = config();
    cfg["entitlement_rules"] = json!([{
        "id": "r1",
        "entitlement_id": "exports",
        "targets": [{ "kind": "plan", "id": "starter" }],
        "kind": "feature",
        "enabled": true,
    }]);
    let providers = create_static_providers(&cfg, &plan_opts());
    let rt = LocalRuntime::new(cfg, providers, "tenant_1", "user_1");

    let r = rt.check_entitlement("exports", None);
    assert!(r.allowed);
    assert_ne!(
        r.reason.as_deref(),
        Some("static_config_default_allow"),
        "the rule shaped the result, not the provider default",
    );
}

#[test]
fn a_configured_entitlement_with_no_matching_rule_is_denied() {
    // Kent's 2026-07-13 ruling: fail closed. A rules provider that assigns
    // the entitlement to some OTHER plan denies it here.
    let mut cfg = config();
    cfg["entitlement_rules"] = json!([{
        "id": "r1",
        "entitlement_id": "exports",
        "targets": [{ "kind": "plan", "id": "enterprise" }],
        "kind": "feature",
    }]);
    let providers = create_static_providers(&cfg, &plan_opts());
    let rt = LocalRuntime::new(cfg, providers, "tenant_1", "user_1");

    let r = rt.check_entitlement("exports", None);
    assert!(!r.allowed);
    assert_eq!(r.reason.as_deref(), Some("no_matching_entitlement_rule"));
}

#[test]
fn with_no_entitlements_provider_the_config_evaluator_takes_over() {
    // An ABSENT provider — not an empty one — is what routes to the
    // ExportedConfig-rule fallback.
    let cfg = json!({
        "version": "1",
        "entitlements": [{ "unique_handle": "exports", "type": "feature" }],
        "entitlement_rules": [{
            "id": "r1", "entitlement_id": "exports", "kind": "feature",
            "targets": [{ "kind": "plan", "id": "starter" }], "enabled": true,
        }],
    });
    // Providers built from a config with NO entitlements array → no provider.
    let providers = create_static_providers(&json!({}), &plan_opts());
    assert!(providers.get("entitlements").is_none());

    let rt = LocalRuntime::new(cfg, providers, "tenant_1", "user_1");
    let r = rt.check_entitlement("exports", None);
    assert_ne!(
        r.reason.as_deref(),
        Some("no_entitlement_provider"),
        "the fallback answered rather than the provider-absent default",
    );
}
