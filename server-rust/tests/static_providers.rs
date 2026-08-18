//! Static provider construction.
//!
//! Mirrors `server-python/tests/adapters/test_static.py`. The load-bearing
//! theme is **omission**: a provider absent from the context means something
//! different from a provider present-but-empty, and several downstream
//! behaviours branch on exactly that.

use serde_json::{json, Value};

use revturbine::adapters::{create_static_providers, EntitlementPolicy, StaticProviderOptions};

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

#[test]
fn segment_ids_fall_back_to_the_handle_when_there_is_no_id() {
    // The canonical Playbook is handle-only (plan 120); `id` is the legacy
    // shape. Both must resolve.
    let ctx = create_static_providers(&config(), &opts(Some("starter")));
    assert_eq!(ctx["segments"]["segment_ids"], json!(["paid", "trialing"]));
    assert_eq!(
        ctx["segments"]["segment_slugs"],
        json!(["paid", "trialing"])
    );

    let legacy = json!({ "segments": [{ "id": "seg_1", "handle": "paid" }] });
    let ctx2 = create_static_providers(&legacy, &opts(Some("starter")));
    assert_eq!(ctx2["segments"]["segment_ids"], json!(["seg_1"]), "id wins");
    assert_eq!(
        ctx2["segments"]["segment_slugs"],
        json!(["paid"]),
        "slugs stay handles either way",
    );
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
