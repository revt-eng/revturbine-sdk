//! Static provider construction.
//!
//! Mirrors `server-python/tests/adapters/test_static.py`. The load-bearing
//! theme is **omission**: a provider absent from the context means something
//! different from a provider present-but-empty, and several downstream
//! behaviours branch on exactly that.

use serde_json::{json, Value};

use revturbine::adapters::{
    apply_server_builtin_dimensions, create_static_providers, EntitlementPolicy,
    StaticProviderOptions,
};

fn opts(plan_handle: Option<&str>) -> StaticProviderOptions {
    StaticProviderOptions {
        plan_handle: plan_handle.map(str::to_string),
        ..Default::default()
    }
}

fn config() -> Value {
    json!({
        "version": "7",
        "entitlements": [
            { "unique_handle": "exports", "type": "usage_limit", "unit": "files" },
            { "unique_handle": "seats", "type": "seats" },
        ],
        "segments": [{ "handle": "paid" }, { "handle": "trialing" }],
    })
}

// ── Omission ────────────────────────────────────────────────────────────────

#[test]
fn a_provider_is_omitted_entirely_when_the_playbook_has_no_data_for_it() {
    // Not merely empty — ABSENT. The entitlement check falls back to
    // config-rule evaluation precisely when the entitlements provider is
    // missing, so an empty state here would silently change behaviour.
    let ctx = create_static_providers(&json!({}), &opts(None));
    let obj = ctx.as_object().expect("object");

    for key in [
        "plan",
        "entitlements",
        "segments",
        "rules",
        "content",
        "theme",
    ] {
        assert!(!obj.contains_key(key), "{key} should be absent");
    }
}

#[test]
fn no_plan_handle_means_no_plan_provider() {
    let ctx = create_static_providers(&config(), &opts(None));
    assert!(ctx.get("plan").is_none());
    assert!(ctx.get("entitlements").is_some(), "others still built");
}

// ── Plan ────────────────────────────────────────────────────────────────────

#[test]
fn plan_name_defaults_to_the_handle() {
    let ctx = create_static_providers(&config(), &opts(Some("starter")));
    assert_eq!(ctx["plan"]["current_plan_handle"], json!("starter"));
    assert_eq!(ctx["plan"]["current_plan_name"], json!("starter"));

    let named = create_static_providers(
        &config(),
        &StaticProviderOptions {
            plan_name: Some("Starter Plan".into()),
            ..opts(Some("starter"))
        },
    );
    assert_eq!(named["plan"]["current_plan_name"], json!("Starter Plan"));
}

#[test]
fn billing_signals_are_omitted_when_not_supplied_not_defaulted_to_false() {
    // The retention qualifiers fail closed on ABSENT state, which is not the
    // same as an explicit `false` — so the distinction has to survive here.
    let plain = create_static_providers(&config(), &opts(Some("starter")));
    let plan = plain["plan"].as_object().unwrap();
    assert!(!plan.contains_key("payment_failed"));
    assert!(!plan.contains_key("payment_at_risk"));

    let flagged = create_static_providers(
        &config(),
        &StaticProviderOptions {
            payment_failed: Some(false),
            ..opts(Some("starter"))
        },
    );
    assert_eq!(
        flagged["plan"]["payment_failed"],
        json!(false),
        "an explicit false is carried through, unlike an absent one",
    );
}

// ── Entitlements ────────────────────────────────────────────────────────────

#[test]
fn every_entitlement_starts_at_the_default_policy() {
    let allow = create_static_providers(&config(), &opts(Some("starter")));
    assert_eq!(
        allow["entitlements"]["entries"]["exports"]["allowed"],
        json!(true)
    );
    assert_eq!(
        allow["entitlements"]["entries"]["exports"]["status"],
        json!("allowed")
    );
    assert_eq!(
        allow["entitlements"]["entries"]["exports"]["reason"],
        json!("static_config_default_allow")
    );

    let deny = create_static_providers(
        &config(),
        &StaticProviderOptions {
            default_entitlement_policy: EntitlementPolicy::Deny,
            ..opts(Some("starter"))
        },
    );
    assert_eq!(
        deny["entitlements"]["entries"]["exports"]["allowed"],
        json!(false)
    );
    assert_eq!(
        deny["entitlements"]["entries"]["exports"]["reason"],
        json!("static_config_default_deny")
    );
}

#[test]
fn usage_overrides_populate_counters_and_carry_the_unit() {
    let ctx = create_static_providers(
        &config(),
        &StaticProviderOptions {
            usage: Some(json!({ "exports": { "used": 9, "limit": 10 } })),
            ..opts(Some("starter"))
        },
    );
    let u = &ctx["entitlements"]["usage"]["exports"];
    assert_eq!(u["used"], json!(9.0));
    assert_eq!(u["limit"], json!(10.0));
    assert_eq!(u["remaining"], json!(1.0));
    assert_eq!(u["unit"], json!("files"), "unit comes from the entitlement");

    // An entitlement with no unit omits the key rather than nulling it.
    let ctx2 = create_static_providers(
        &config(),
        &StaticProviderOptions {
            usage: Some(json!({ "seats": { "used": 1, "limit": 5 } })),
            ..opts(Some("starter"))
        },
    );
    assert!(!ctx2["entitlements"]["usage"]["seats"]
        .as_object()
        .unwrap()
        .contains_key("unit"));
}

#[test]
fn an_over_consumed_allowance_reports_zero_remaining_not_negative() {
    let ctx = create_static_providers(
        &config(),
        &StaticProviderOptions {
            usage: Some(json!({ "exports": { "used": 15, "limit": 10 } })),
            ..opts(Some("starter"))
        },
    );
    assert_eq!(
        ctx["entitlements"]["usage"]["exports"]["remaining"],
        json!(0.0)
    );
}

#[test]
fn entitlements_without_a_usage_override_get_no_usage_entry() {
    let ctx = create_static_providers(
        &config(),
        &StaticProviderOptions {
            usage: Some(json!({ "exports": { "used": 1, "limit": 2 } })),
            ..opts(Some("starter"))
        },
    );
    let usage = ctx["entitlements"]["usage"].as_object().unwrap();
    assert!(usage.contains_key("exports"));
    assert!(!usage.contains_key("seats"), "no override → no counters");
}

#[test]
fn tiers_are_passed_through_only_when_supplied() {
    let without = create_static_providers(&config(), &opts(Some("starter")));
    assert!(!without["entitlements"]
        .as_object()
        .unwrap()
        .contains_key("tiers"));

    let with = create_static_providers(
        &config(),
        &StaticProviderOptions {
            tiers: Some(json!({ "seats": "pro" })),
            ..opts(Some("starter"))
        },
    );
    assert_eq!(with["entitlements"]["tiers"]["seats"], json!("pro"));
}

// ── Segments ────────────────────────────────────────────────────────────────

// The segments provider reports the user's MEMBERSHIP (BL-0369). It used to
// report every configured segment, so a payload or rule chipped to any segment
// was served to every user. Mirrors server-python's test_static.py.

fn membership_config() -> Value {
    json!({
        "segments": [
            {
                "id": "seg_paid",
                "handle": "rt.subscription_state.paid",
                "dimension_id": "rt.subscription_state",
                "predicates": [{ "field": "rt_subscription_state", "operator": "eq", "value": "paid" }],
            },
            {
                "handle": "power_users",
                "predicates": [{ "field": "sessions", "operator": "gte", "value": "10" }],
            },
            { "handle": "vip_accounts" },
        ],
    })
}

fn membership(segment_ids: Option<Vec<&str>>, user_context: Option<Value>) -> Value {
    let ctx = create_static_providers(
        &membership_config(),
        &StaticProviderOptions {
            segment_ids: segment_ids.map(|ids| ids.into_iter().map(str::to_string).collect()),
            user_context,
            ..Default::default()
        },
    );
    ctx["segments"]["segment_ids"].clone()
}

#[test]
fn segments_report_no_membership_without_inputs() {
    let ctx = create_static_providers(&membership_config(), &opts(Some("starter")));
    assert_eq!(
        ctx["segments"],
        json!({ "segment_ids": [], "segment_slugs": [] })
    );
}

#[test]
fn builtin_segments_match_only_from_builtin_dimensions() {
    // Handles, never the legacy `id` — segment identity is the handle (plan 120).
    let paid = json!({ "id": "u1", "builtin_dimensions": { "subscription_state": "paid" } });
    assert_eq!(
        membership(None, Some(paid)),
        json!(["rt.subscription_state.paid"])
    );
    assert_eq!(membership(None, Some(json!({ "id": "u1" }))), json!([]));
    // A reserved rt_* key arriving through custom is deleted (plan 279 PD-1).
    let shadow = json!({ "id": "u1", "custom": { "rt_subscription_state": "paid" } });
    assert_eq!(membership(None, Some(shadow)), json!([]));
}

#[test]
fn trait_segments_evaluate_their_predicates() {
    let power = json!({ "id": "u1", "custom": { "sessions": 12 } });
    let casual = json!({ "id": "u1", "custom": { "sessions": 3 } });
    assert_eq!(membership(None, Some(power)), json!(["power_users"]));
    assert_eq!(membership(None, Some(casual)), json!([]));
}

#[test]
fn supplied_segment_ids_come_first_deduplicated() {
    let power = json!({ "id": "u1", "custom": { "sessions": 12 } });
    assert_eq!(
        membership(Some(vec!["vip_accounts", "power_users"]), Some(power)),
        json!(["vip_accounts", "power_users"]),
    );
}

// The server built-in dimension overlay (BL-0366, plan 279 PD-3). Mirrors
// server-python's test_static.py and scaffold's static.test.ts.

fn overlaid_membership(user_context: Option<Value>, server: Value) -> Value {
    let ctx = create_static_providers(
        &membership_config(),
        &StaticProviderOptions {
            user_context,
            server_builtin_dimensions: Some(server),
            ..Default::default()
        },
    );
    ctx["segments"]["segment_ids"].clone()
}

#[test]
fn server_builtin_dimensions_win_over_the_app_set_value() {
    let free = json!({ "id": "u1", "builtin_dimensions": { "subscription_state": "free" } });
    assert_eq!(
        overlaid_membership(Some(free), json!({ "subscription_state": "paid" })),
        json!(["rt.subscription_state.paid"])
    );
    // And the reverse: a server value demotes an app-set paid.
    let paid = json!({ "id": "u1", "builtin_dimensions": { "subscription_state": "paid" } });
    assert_eq!(
        overlaid_membership(Some(paid), json!({ "subscription_state": "trial" })),
        json!([])
    );
}

#[test]
fn server_overlay_keeps_app_leaves_the_server_did_not_deliver() {
    let app = json!({
        "id": "u1",
        "builtin_dimensions": { "subscription_state": "trial", "seat_type": "admin" },
    });
    let overlaid =
        apply_server_builtin_dimensions(Some(&app), Some(&json!({ "activity_level": "high" })))
            .expect("a context in is a context out");
    assert_eq!(
        overlaid["builtin_dimensions"],
        json!({ "subscription_state": "trial", "seat_type": "admin", "activity_level": "high" })
    );
    // Pure: the app context is untouched.
    assert_eq!(
        app["builtin_dimensions"]["subscription_state"],
        json!("trial")
    );
}

#[test]
fn server_overlay_applies_onto_a_context_with_no_dimensions() {
    assert_eq!(
        overlaid_membership(
            Some(json!({ "id": "u1" })),
            json!({ "subscription_state": "paid" })
        ),
        json!(["rt.subscription_state.paid"])
    );
}

#[test]
fn server_overlay_is_ignored_without_a_user_context() {
    assert_eq!(
        overlaid_membership(None, json!({ "subscription_state": "paid" })),
        json!([])
    );
    assert_eq!(
        apply_server_builtin_dimensions(None, Some(&json!({}))),
        None
    );
    let app = json!({ "id": "u1" });
    assert_eq!(
        apply_server_builtin_dimensions(Some(&app), None),
        Some(app.clone())
    );
}

#[test]
fn supplied_segment_ids_build_the_provider_without_configured_segments() {
    let ctx = create_static_providers(
        &json!({ "segments": [] }),
        &StaticProviderOptions {
            segment_ids: Some(vec!["vip_accounts".into()]),
            ..Default::default()
        },
    );
    assert_eq!(
        ctx["segments"],
        json!({ "segment_ids": ["vip_accounts"], "segment_slugs": ["vip_accounts"] }),
    );
}

#[test]
fn rules_carry_segment_dimensions_and_the_playbook_version() {
    let mut c = membership_config();
    c["format_version"] = json!("1.0.0");
    c["entitlement_rules"] = json!([{ "id": "r1", "entitlement_id": "x", "segment_ids": [] }]);
    let ctx = create_static_providers(&c, &opts(None));
    assert_eq!(
        ctx["rules"]["segment_dimensions"],
        json!({ "rt.subscription_state.paid": "rt.subscription_state" }),
    );
    assert_eq!(ctx["rules"]["config_version"], json!("1.0.0"));
}

// ── Rules ───────────────────────────────────────────────────────────────────

fn config_with_rules(rule: Value) -> Value {
    let mut c = config();
    c["entitlement_rules"] = json!([rule]);
    c
}

#[test]
fn rules_are_grouped_by_entitlement_and_inherit_kind_from_the_entitlement() {
    let ctx = create_static_providers(
        &config_with_rules(json!({ "id": "r1", "entitlement_id": "exports" })),
        &opts(Some("starter")),
    );
    let rules = &ctx["rules"]["entitlement_rules"]["exports"];
    assert_eq!(rules[0]["rule_id"], json!("r1"));
    assert_eq!(
        rules[0]["kind"],
        json!("usage_limit"),
        "kind derives from the parent entitlement's type",
    );
    assert_eq!(ctx["rules"]["config_version"], json!("7"));
}

#[test]
fn an_explicit_kind_beats_the_inherited_one() {
    let ctx = create_static_providers(
        &config_with_rules(json!({ "id": "r1", "entitlement_id": "exports", "kind": "feature" })),
        &opts(Some("starter")),
    );
    assert_eq!(
        ctx["rules"]["entitlement_rules"]["exports"][0]["kind"],
        json!("feature")
    );
}

#[test]
fn plan_targets_are_read_from_kind_discriminated_targets() {
    let ctx = create_static_providers(
        &config_with_rules(json!({
            "id": "r1",
            "entitlement_id": "exports",
            "targets": [
                { "kind": "plan", "id": "pro" },
                { "kind": "segment", "id": "paid" },
            ],
        })),
        &opts(Some("starter")),
    );
    assert_eq!(
        ctx["rules"]["entitlement_rules"]["exports"][0]["plan_ids"],
        json!(["pro"]),
        "only plan-kind targets become plan_ids",
    );
}

#[test]
fn a_legacy_flat_plan_ids_array_is_still_honoured() {
    // Under the fail-closed ruling an unmapped legacy rule would DENY the
    // entitlement rather than merely fail to enrich it.
    let ctx = create_static_providers(
        &config_with_rules(json!({
            "id": "r1", "entitlement_id": "exports", "plan_ids": ["pro", "ent"],
        })),
        &opts(Some("starter")),
    );
    assert_eq!(
        ctx["rules"]["entitlement_rules"]["exports"][0]["plan_ids"],
        json!(["pro", "ent"])
    );
}

#[test]
fn flat_rule_fields_win_over_a_legacy_nested_type_fields_bag() {
    let ctx = create_static_providers(
        &config_with_rules(json!({
            "id": "r1",
            "entitlement_id": "exports",
            "limit": 100,
            "type_fields": { "limit": 5, "legacy_only": true },
        })),
        &opts(Some("starter")),
    );
    let fields = &ctx["rules"]["entitlement_rules"]["exports"][0]["fields"];
    assert_eq!(fields["limit"], json!(100), "the flat wire wins");
    assert_eq!(fields["legacy_only"], json!(true), "nested extras survive");
}

// ── Content + theme ─────────────────────────────────────────────────────────

#[test]
fn message_block_overrides_are_rekeyed_to_segment_id() {
    let mut c = config();
    c["message_blocks"] = json!([{
        "block_id": "blk_1",
        "name": "Block",
        "status": "active",
        "default_content": { "header": "Hi" },
        "segment_overrides": [{ "segment_value_id": "paid", "content": { "header": "Paid" } }],
    }]);
    let ctx = create_static_providers(&c, &opts(Some("starter")));
    let block = &ctx["content"]["message_blocks"]["blk_1"];

    assert_eq!(block["status"], json!("active"));
    assert_eq!(
        block["segment_overrides"][0]["segment_id"],
        json!("paid"),
        "segment_value_id is rekeyed to segment_id for provider state",
    );
    assert_eq!(
        block["segment_overrides"][0]["content"]["header"],
        json!("Paid")
    );
}

#[test]
fn an_empty_theme_object_does_not_create_a_theme_provider() {
    let mut c = config();
    c["theme"] = json!({});
    assert!(create_static_providers(&c, &opts(Some("starter")))
        .get("theme")
        .is_none());

    c["theme"] = json!({ "primary": "#000" });
    let ctx = create_static_providers(&c, &opts(Some("starter")));
    assert_eq!(ctx["theme"]["overrides"]["primary"], json!("#000"));
}
