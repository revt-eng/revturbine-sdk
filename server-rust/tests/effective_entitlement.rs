//! D-61 (Kent, 2026-10-06): one effective entitlement answer — the shared
//! Playbook + user-context evaluation, merged with app-mirrored data. App wins
//! by default; precedence is configurable per provider and per field. Unknown
//! handles fail closed. Server runtimes and the browser SDK call this same
//! function on the same inputs.
//!
//! Port of revturbine-scaffold
//! `src/entitlements/controllers/effective-entitlement.test.ts`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use revturbine::adapters::{create_static_providers, StaticProviderOptions};
use revturbine::decisions::EntitlementCheckResult;
use revturbine::entitlements::{
    app_entitlement, derive_effective_entitlement, derive_effective_entitlements,
    merge_entitlement_results, reverse_trial_grants, AppEntitlementInputs, EffectiveEntitlement,
    EffectiveEntitlementBase, EntitlementMergeFields, EntitlementMergeOptions, EntitlementSource,
    PartialEntitlement,
};
use revturbine::runtime::{LocalRuntime, PlacementDecisionInput};

fn playbook() -> Value {
    json!({
        "artifact_type": "playbook", "format_version": "1.0.0", "playbook_handle": "default",
        "playbook_version_id": null, "tenant_id": "t", "environment_id": "production",
        "plans": [{ "unique_handle": "free", "name": "Free" }, { "unique_handle": "pro", "name": "Pro" }],
        "entitlements": [
            { "unique_handle": "exports", "name": "Exports", "type": "feature" },
            { "unique_handle": "api_calls", "name": "API calls", "type": "usage_limit" },
        ],
        "entitlement_rules": [
            { "id": "r_exports_pro", "entitlement_id": "exports", "targets": [{ "kind": "plan", "id": "pro" }], "segment_ids": [], "type_fields": { "kind": "feature", "enabled": true } },
            { "id": "r_api_free", "entitlement_id": "api_calls", "targets": [{ "kind": "plan", "id": "free" }], "segment_ids": [], "type_fields": { "kind": "usage_limit", "limit_value": 100, "enforcement": "hard_block" } },
        ],
        "reverse_trial_rules": [{ "id": "rt", "fallback_plan_id": "free", "premium_plan_id": "pro", "entitlements_during_trial": ["exports"], "is_active": true }],
        "segments": [], "content_ui_paths": [], "placements": [],
    })
}

fn base<'a>(playbook: &'a Value, plan: &str) -> EffectiveEntitlementBase<'a> {
    EffectiveEntitlementBase {
        playbook: Some(playbook),
        current_plan_handle: plan.to_string(),
        segment_ids: HashSet::new(),
        usage_balances: HashMap::new(),
        ..EffectiveEntitlementBase::default()
    }
}

/// `toMatchObject`: every expected key is present on the serialized result
/// with that value.
fn assert_matches(actual: &EntitlementCheckResult, expected: Value) {
    let actual = serde_json::to_value(actual).expect("result serializes");
    for (key, value) in expected.as_object().expect("expected is an object") {
        assert_eq!(actual.get(key), Some(value), "{key} in {actual}");
    }
}

fn user_context(grant: Value) -> AppEntitlementInputs {
    AppEntitlementInputs {
        user_context: Some(grant),
        provider: None,
    }
}

fn partial(value: Value) -> PartialEntitlement {
    let num = |k: &str| value.get(k).and_then(Value::as_number).cloned();
    PartialEntitlement {
        status: value
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string),
        allowed: value.get("allowed").and_then(Value::as_bool),
        limit: num("limit"),
        used: num("used"),
        remaining: num("remaining"),
        reason: value
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

// ── mergeEntitlementResults ─────────────────────────────────────────────────

fn evaluated() -> EntitlementCheckResult {
    serde_json::from_value(json!({
        "status": "denied", "allowed": false, "reason": "no_matching_entitlement_rule",
        "limit": 100, "used": 10, "remaining": 90,
    }))
    .expect("evaluated result deserializes")
}

#[test]
fn merge_app_wins_by_default_and_reports_a_mirrored_reason() {
    let merged = merge_entitlement_results(
        Some(&evaluated()),
        Some(&partial(json!({ "status": "allowed", "allowed": true }))),
        &EntitlementMergeOptions::default(),
    )
    .expect("merged");
    assert_matches(
        &merged,
        json!({ "status": "allowed", "allowed": true, "reason": "entitlement_mirrored", "limit": 100, "used": 10 }),
    );
}

#[test]
fn merge_provider_level_precedence_can_make_the_playbook_win() {
    let merged = merge_entitlement_results(
        Some(&evaluated()),
        Some(&partial(json!({ "status": "allowed", "used": 99 }))),
        &EntitlementMergeOptions {
            precedence: Some(EntitlementSource::Playbook),
            ..EntitlementMergeOptions::default()
        },
    )
    .expect("merged");
    assert_matches(&merged, json!({ "status": "denied", "used": 10 }));
}

#[test]
fn merge_field_level_precedence_mixes_sources() {
    let merged = merge_entitlement_results(
        Some(&evaluated()),
        Some(&partial(
            json!({ "status": "allowed", "used": 95, "remaining": 5 }),
        )),
        &EntitlementMergeOptions {
            precedence: Some(EntitlementSource::App),
            fields: EntitlementMergeFields {
                status: Some(EntitlementSource::Playbook),
                ..EntitlementMergeFields::default()
            },
        },
    )
    .expect("merged");
    assert_matches(
        &merged,
        json!({ "status": "denied", "reason": "no_matching_entitlement_rule", "used": 95, "remaining": 5, "limit": 100 }),
    );
}

#[test]
fn merge_a_partial_app_entry_usage_only_keeps_the_playbook_status() {
    let merged = merge_entitlement_results(
        Some(&evaluated()),
        Some(&partial(json!({ "used": 50 }))),
        &EntitlementMergeOptions::default(),
    )
    .expect("merged");
    assert_matches(&merged, json!({ "status": "denied", "used": 50 }));
}

// ── appEntitlement ──────────────────────────────────────────────────────────

#[test]
fn app_entitlement_reads_booleans_and_grants_provider_overrides_user_context_field_by_field() {
    assert_eq!(
        app_entitlement(Some(&user_context(json!(true)))),
        Some(partial(json!({ "status": "allowed", "allowed": true }))),
    );
    assert_eq!(
        app_entitlement(Some(&user_context(
            json!({ "status": "limited", "limit": 10, "used": 4 })
        ))),
        Some(partial(
            json!({ "status": "limited", "allowed": true, "limit": 10, "used": 4, "remaining": 6 })
        )),
    );
    let both = app_entitlement(Some(&AppEntitlementInputs {
        user_context: Some(json!({ "status": "allowed", "used": 1 })),
        provider: Some(json!({ "status": "denied", "allowed": false })),
    }))
    .expect("app view");
    assert_eq!(both.status.as_deref(), Some("denied"));
    assert_eq!(both.allowed, Some(false));
    assert_eq!(both.used, Some(1.into()));
}

// ── deriveEffectiveEntitlement ──────────────────────────────────────────────

#[test]
fn evaluates_the_playbook_when_the_app_is_silent() {
    let pb = playbook();
    let free = derive_effective_entitlement("exports", &base(&pb, "free"), None);
    assert_matches(&free.result, json!({ "status": "denied" }));
    let pro = derive_effective_entitlement("exports", &base(&pb, "pro"), None);
    assert_matches(&pro.result, json!({ "status": "allowed" }));
}

#[test]
fn a_mirrored_grant_overrides_the_playbook() {
    let pb = playbook();
    let out = derive_effective_entitlement(
        "exports",
        &base(&pb, "free"),
        Some(&user_context(json!(true))),
    );
    assert_eq!(
        out,
        EffectiveEntitlement {
            result: EntitlementCheckResult::with_reason("allowed", true, "entitlement_mirrored"),
            unknown_handle: false,
        }
    );
}

#[test]
fn an_app_only_entitlement_the_playbook_does_not_define_is_valid() {
    let pb = playbook();
    let out = derive_effective_entitlement(
        "custom_seats",
        &base(&pb, "free"),
        Some(&user_context(json!({ "status": "allowed", "limit": 5 }))),
    );
    assert_matches(&out.result, json!({ "status": "allowed", "limit": 5 }));
}

#[test]
fn an_unknown_handle_fails_closed_and_is_flagged() {
    let pb = playbook();
    assert_eq!(
        derive_effective_entitlement("nope", &base(&pb, "pro"), None),
        EffectiveEntitlement {
            result: EntitlementCheckResult::with_reason(
                "denied",
                false,
                "entitlement_not_in_playbook"
            ),
            unknown_handle: true,
        }
    );
}

#[test]
fn mirrored_usage_feeds_the_evaluation_so_status_and_remaining_stay_coherent() {
    let pb = playbook();
    let near = derive_effective_entitlement(
        "api_calls",
        &base(&pb, "free"),
        Some(&user_context(json!({ "used": 95 }))),
    );
    assert_matches(
        &near.result,
        json!({ "status": "allowed", "used": 95, "remaining": 5, "limit": 100 }),
    );
    let over = derive_effective_entitlement(
        "api_calls",
        &base(&pb, "free"),
        Some(&user_context(json!({ "used": 120 }))),
    );
    assert_matches(&over.result, json!({ "status": "denied", "used": 120 }));
}

#[test]
fn reverse_trial_grants_come_from_the_shared_helper() {
    let pb = playbook();
    let grants = reverse_trial_grants(
        &pb,
        Some(&json!({ "in_trial": true, "trial_type": "reverse", "plan_handle": "free" })),
    );
    let out = derive_effective_entitlement(
        "exports",
        &base(&pb, "free").with_reverse_trial_grants(grants),
        None,
    );
    assert_matches(&out.result, json!({ "status": "allowed" }));
}

#[test]
fn derive_effective_entitlements_covers_playbook_and_app_handles() {
    let pb = playbook();
    let app: BTreeMap<String, AppEntitlementInputs> =
        BTreeMap::from([("custom_seats".to_string(), user_context(json!(true)))]);
    let map = derive_effective_entitlements(&base(&pb, "free"), &app);
    let keys: Vec<&str> = map.keys().map(String::as_str).collect();
    assert_eq!(keys, vec!["api_calls", "custom_seats", "exports"]);
}

// ── LocalRuntime — server verifies with the same evaluation (D-61) ──────────

fn runtime(plan: &str) -> LocalRuntime {
    let pb = playbook();
    let providers = create_static_providers(
        &pb,
        &StaticProviderOptions {
            plan_handle: Some(plan.to_string()),
            ..StaticProviderOptions::default()
        },
    );
    LocalRuntime::new(pb, providers, "t", "u")
}

#[test]
fn runtime_decides_from_the_playbook_rules_not_a_blanket_default() {
    assert_eq!(
        runtime("free").check_entitlement("exports", None).status,
        "denied"
    );
    assert_eq!(
        runtime("pro").check_entitlement("exports", None).status,
        "allowed"
    );
}

#[test]
fn runtime_honours_reverse_trial_grants_on_the_server() {
    let r = runtime("free").with_trial_status(
        json!({ "in_trial": true, "trial_type": "reverse", "plan_handle": "free" }),
    );
    assert_eq!(r.check_entitlement("exports", None).status, "allowed");
}

#[test]
fn runtime_applies_user_context_mirroring_and_the_configured_precedence() {
    let grants = json!({ "exports": true })
        .as_object()
        .cloned()
        .expect("object");
    let mirrored = runtime("free").with_user_entitlements(grants.clone());
    assert_eq!(
        mirrored.check_entitlement("exports", None).status,
        "allowed"
    );
    let playbook_wins = runtime("free")
        .with_user_entitlements(grants)
        .with_entitlement_merge(EntitlementMergeOptions {
            precedence: Some(EntitlementSource::Playbook),
            ..EntitlementMergeOptions::default()
        });
    assert_eq!(
        playbook_wins.check_entitlement("exports", None).status,
        "denied"
    );
}

#[test]
fn runtime_an_app_entitlement_provider_mirrors_too() {
    // TS `updateProviders([...])` replaces every provider with one app
    // entitlement provider — an entitlements state WITHOUT the
    // `playbook_default` origin, and no plan provider at all.
    let providers = json!({
        "entitlements": { "entries": { "exports": { "status": "allowed", "allowed": true } } },
    });
    let r = LocalRuntime::new(playbook(), providers, "t", "u");
    assert_eq!(r.check_entitlement("exports", None).status, "allowed");
}

#[test]
fn runtime_denies_an_unknown_handle_warns_once_and_reports_it() {
    let reported = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&reported);
    let r = runtime("pro").with_on_unknown_entitlement(move |handle| {
        sink.lock().expect("sink").push(handle.to_string());
    });
    let first = r.check_entitlement("nope", None);
    assert_matches(
        &first,
        json!({ "status": "denied", "reason": "entitlement_not_in_playbook" }),
    );
    let second = r.check_entitlement("nope", None);
    assert_eq!(
        second, first,
        "the verdict repeats; only the report is once"
    );
    // The stderr warning and the hook share one once-per-handle guard, so one
    // report proves one warning.
    assert_eq!(
        *reported.lock().expect("reported"),
        vec!["nope".to_string()]
    );
}

#[test]
fn runtime_a_server_side_access_gate_fires_for_a_rule_denied_user() {
    let mut with_gate = playbook();
    with_gate["placements"] = json!([{
        "id": "pl_gate", "name": "gate", "category": "gated", "order": 0,
        "trigger": { "type": "entitlement_gate", "entitlement_handle": "exports" },
        "payloads": [{
            "id": "p_gate",
            "target": { "plan_ids": [], "segment_ids": [] },
            "surfaces": [{ "template_id": "modal_overlay", "fields": { "header": "Unlock exports" }, "ctas": [] }],
        }],
    }]);
    let decide = |plan: &str| {
        let providers = create_static_providers(
            &with_gate,
            &StaticProviderOptions {
                plan_handle: Some(plan.to_string()),
                ..StaticProviderOptions::default()
            },
        );
        LocalRuntime::new(with_gate.clone(), providers, "t", "u").get_placement_decision(
            &PlacementDecisionInput {
                placement_id: "pl_gate".into(),
                user_id: "u".into(),
            },
        )
    };
    assert_eq!(decide("free")["visible"], json!(true));
    assert_eq!(decide("pro")["visible"], json!(false));
}

// ── D-61 — app provides BOTH plan and entitlements (server runtime) ─────────
//
// exports: Playbook only (Pro rule). api_calls: Playbook (Pro, limit 1000)
// AND the app (billing hold + usage). custom_seats: app only.

fn both_runtime(merge: Option<EntitlementMergeOptions>) -> LocalRuntime {
    let mut mixed = playbook();
    mixed["entitlement_rules"] = json!([
        { "id": "r_exports_pro", "entitlement_id": "exports", "targets": [{ "kind": "plan", "id": "pro" }], "segment_ids": [], "type_fields": { "kind": "feature", "enabled": true } },
        { "id": "r_api_pro", "entitlement_id": "api_calls", "targets": [{ "kind": "plan", "id": "pro" }], "segment_ids": [], "type_fields": { "kind": "usage_limit", "limit_value": 1000, "enforcement": "hard_block" } },
    ]);
    // No static adapter: the app is the only provider of plan and
    // entitlements, so the entitlements state carries no origin marker.
    let providers = json!({
        "plan": { "current_plan_handle": "pro" },
        "entitlements": {
            "entries": {
                "api_calls": { "status": "denied", "allowed": false, "reason": "billing_hold" },
                "custom_seats": { "status": "allowed", "allowed": true, "limit": 5 },
            },
            "usage": { "api_calls": { "used": 10, "limit": 1000, "remaining": 990 } },
        },
    });
    let rt = LocalRuntime::new(mixed, providers, "t", "u");
    match merge {
        Some(m) => rt.with_entitlement_merge(m),
        None => rt,
    }
}

#[test]
fn both_playbook_only_handle_evaluates_the_rules_against_the_app_provided_plan() {
    assert_matches(
        &both_runtime(None).check_entitlement("exports", None),
        json!({ "status": "allowed", "rule_handle": "r_exports_pro" }),
    );
}

#[test]
fn both_overlapping_handle_the_app_entry_wins_by_default_playbook_numbers_fill_the_gaps() {
    assert_matches(
        &both_runtime(None).check_entitlement("api_calls", None),
        json!({ "status": "denied", "allowed": false, "reason": "billing_hold", "limit": 1000, "used": 10, "remaining": 990 }),
    );
}

#[test]
fn both_overlapping_handle_provider_level_precedence_playbook_lets_the_pro_rule_decide() {
    let rt = both_runtime(Some(EntitlementMergeOptions {
        precedence: Some(EntitlementSource::Playbook),
        ..EntitlementMergeOptions::default()
    }));
    assert_matches(
        &rt.check_entitlement("api_calls", None),
        json!({ "status": "allowed", "limit": 1000, "used": 10, "remaining": 990 }),
    );
}

#[test]
fn both_overlapping_handle_field_level_status_from_the_playbook_usage_from_the_app() {
    let rt = both_runtime(Some(EntitlementMergeOptions {
        fields: EntitlementMergeFields {
            status: Some(EntitlementSource::Playbook),
            ..EntitlementMergeFields::default()
        },
        ..EntitlementMergeOptions::default()
    }));
    assert_matches(
        &rt.check_entitlement("api_calls", None),
        json!({ "status": "allowed", "used": 10, "limit": 1000 }),
    );
}

#[test]
fn both_app_only_handle_comes_from_the_app_provider() {
    assert_matches(
        &both_runtime(None).check_entitlement("custom_seats", None),
        json!({ "status": "allowed", "limit": 5, "reason": "entitlement_mirrored" }),
    );
}

#[test]
fn both_a_handle_neither_side_knows_is_denied() {
    assert_matches(
        &both_runtime(None).check_entitlement("never_defined", None),
        json!({ "status": "denied", "reason": "entitlement_not_in_playbook" }),
    );
}
