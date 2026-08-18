//! Playbook → gate-input normalization, and CTA path mapping.
//!
//! Mirrors the `local-resolver.ts` reader cases. These sit directly upstream
//! of the four gates, so a reader that silently produces a *default* instead
//! of `None` turns "this placement has no such trigger" into "this placement
//! fires immediately" — which is why each rejection is asserted individually.

use serde_json::{json, Value};

use revturbine::placements::{
    decision_content, header_str, is_finite_number, matches_threshold_trigger, normalize_cta_path,
    read_entitlement_handle_from_trigger, read_json_entitlement_gate_trigger,
    read_json_qualifier_trigger, read_json_threshold_trigger, read_slot_id_from_trigger,
};

// ── Field readers ───────────────────────────────────────────────────────────

#[test]
fn field_readers_require_a_string() {
    let t = json!({ "entitlement_handle": "exports", "slot_id": "banner_top" });
    assert_eq!(
        read_entitlement_handle_from_trigger(Some(&t)),
        Some("exports")
    );
    assert_eq!(read_slot_id_from_trigger(Some(&t)), Some("banner_top"));

    let wrong = json!({ "entitlement_handle": 42, "slot_id": null });
    assert_eq!(read_entitlement_handle_from_trigger(Some(&wrong)), None);
    assert_eq!(read_slot_id_from_trigger(Some(&wrong)), None);
    assert_eq!(read_entitlement_handle_from_trigger(None), None);
}

// ── Threshold ───────────────────────────────────────────────────────────────

#[test]
fn reads_each_recognized_threshold_kind() {
    for kind in ["usage_threshold", "credit_threshold", "seat_threshold"] {
        let t = json!({ "type": kind, "threshold_percent": 80 });
        let out = read_json_threshold_trigger(Some(&t), Some("exports")).expect(kind);
        assert_eq!(out.kind, kind);
        assert_eq!(out.entitlement_handle, "exports");
        assert_eq!(out.threshold_percent, 80.0);
    }
}

#[test]
fn a_threshold_with_no_percent_is_rejected_not_defaulted() {
    // Defaulting to 0 would make the placement fire at ANY usage.
    let no_percent = json!({ "type": "usage_threshold" });
    assert!(read_json_threshold_trigger(Some(&no_percent), Some("exports")).is_none());

    let boolean = json!({ "type": "usage_threshold", "threshold_percent": true });
    assert!(
        read_json_threshold_trigger(Some(&boolean), Some("exports")).is_none(),
        "`true` must not coerce to 1%",
    );

    let stringy = json!({ "type": "usage_threshold", "threshold_percent": "80" });
    assert!(
        read_json_threshold_trigger(Some(&stringy), Some("exports")).is_none(),
        "no string coercion — TS tests typeof === 'number'",
    );
}

#[test]
fn a_threshold_without_an_entitlement_handle_is_rejected() {
    let t = json!({ "type": "usage_threshold", "threshold_percent": 80 });
    assert!(read_json_threshold_trigger(Some(&t), None).is_none());
    assert!(read_json_threshold_trigger(Some(&t), Some("")).is_none());
}

#[test]
fn a_non_threshold_type_reads_as_none_so_the_gate_passes_through() {
    let t = json!({ "type": "qualifier", "threshold_percent": 80 });
    let read = read_json_threshold_trigger(Some(&t), Some("exports"));
    assert!(read.is_none());
    // And `None` is precisely what the gate treats as pass-through.
    assert!(matches_threshold_trigger(read.as_ref(), None));
}

// ── Qualifier ───────────────────────────────────────────────────────────────

#[test]
fn reads_a_qualifier_trigger() {
    let t = json!({ "type": "qualifier", "qualifier": "payment_failed" });
    assert_eq!(
        read_json_qualifier_trigger(Some(&t))
            .expect("read")
            .qualifier,
        "payment_failed"
    );
}

#[test]
fn a_qualifier_trigger_needs_a_non_empty_name() {
    for t in [
        json!({ "type": "qualifier" }),
        json!({ "type": "qualifier", "qualifier": "" }),
        json!({ "type": "qualifier", "qualifier": 7 }),
        json!({ "type": "usage_threshold", "qualifier": "payment_failed" }),
    ] {
        assert!(read_json_qualifier_trigger(Some(&t)).is_none(), "{t}");
    }
}

// ── Entitlement gate ────────────────────────────────────────────────────────

#[test]
fn reads_a_tier_scoped_entitlement_gate() {
    let t = json!({ "type": "entitlement_gate", "tier_threshold": "pro" });
    let out = read_json_entitlement_gate_trigger(Some(&t), Some("seats")).expect("read");
    assert_eq!(out.entitlement_handle, "seats");
    assert_eq!(out.tier_threshold, Some("pro".into()));
}

#[test]
fn a_blank_tier_threshold_yields_a_non_tier_gate_not_a_rejection() {
    // A gate with no tier boundary is governed by entitlement status and must
    // pass through — dropping the whole trigger would silently disable it.
    for t in [
        json!({ "type": "entitlement_gate" }),
        json!({ "type": "entitlement_gate", "tier_threshold": "" }),
        json!({ "type": "entitlement_gate", "tier_threshold": null }),
    ] {
        let out = read_json_entitlement_gate_trigger(Some(&t), Some("seats"))
            .unwrap_or_else(|| panic!("{t} should still read as a gate"));
        assert_eq!(out.tier_threshold, None, "{t}");
    }
}

#[test]
fn an_entitlement_gate_without_a_handle_is_rejected() {
    let t = json!({ "type": "entitlement_gate", "tier_threshold": "pro" });
    assert!(read_json_entitlement_gate_trigger(Some(&t), None).is_none());
    assert!(read_json_entitlement_gate_trigger(Some(&t), Some("")).is_none());
}

// ── CTA path mapping ────────────────────────────────────────────────────────

#[test]
fn a_missing_cta_or_path_becomes_dismiss() {
    for cta in [
        None,
        Some(json!({})),
        Some(json!({ "path": "" })),
        Some(json!("nope")),
    ] {
        let out = normalize_cta_path(cta.as_ref());
        assert_eq!(out["type"], json!("dismiss"), "{cta:?}");
    }
}

#[test]
fn known_paths_map_to_their_resolved_types() {
    let checkout = normalize_cta_path(Some(&json!({
        "path": "open_checkout",
        "config": { "purchase": "pro" },
    })));
    assert_eq!(checkout["type"], json!("open_checkout_modal"));
    assert_eq!(checkout["plan_handle"], json!("pro"));

    let plans = normalize_cta_path(Some(&json!({ "path": "view_plans" })));
    assert_eq!(plans["type"], json!("navigate_to_plans"));

    let placement = normalize_cta_path(Some(&json!({
        "path": "open_rt_placement",
        "config": { "placement_handle": "pl_x" },
    })));
    assert_eq!(placement["type"], json!("open_rt_placement"));
    assert_eq!(placement["placement_handle"], json!("pl_x"));
}

#[test]
fn optional_config_fields_are_omitted_not_nulled() {
    // Mirrors JSON.stringify dropping `undefined`. The parity contract treats
    // an absent key and an explicit null as different output, so emitting
    // null here would diverge.
    let no_purchase = normalize_cta_path(Some(&json!({ "path": "open_checkout" })));
    assert_eq!(no_purchase["type"], json!("open_checkout_modal"));
    assert!(
        !no_purchase.contains_key("plan_handle"),
        "absent purchase must omit plan_handle entirely",
    );

    let wrong_type = normalize_cta_path(Some(&json!({
        "path": "open_checkout",
        "config": { "purchase": 42 },
    })));
    assert!(
        !wrong_type.contains_key("plan_handle"),
        "non-string is omitted too"
    );
}

#[test]
fn a_custom_path_passes_through_with_its_config_spread() {
    // A custom CTA's params must reach the SDK resolver intact.
    let out = normalize_cta_path(Some(&json!({
        "path": "open_intercom",
        "config": { "article_id": "123", "mode": "sidebar" },
    })));
    assert_eq!(out["type"], json!("open_intercom"));
    assert_eq!(out["article_id"], json!("123"));
    assert_eq!(out["mode"], json!("sidebar"));
}

// ── Content helpers ─────────────────────────────────────────────────────────

#[test]
fn decision_content_mirrors_both_namings() {
    // Consumers exist for each spelling; dropping either breaks one of them.
    let c = decision_content("Head", "Body", "Go");
    assert_eq!(c["header"], json!("Head"));
    assert_eq!(c["title"], json!("Head"));
    assert_eq!(c["cta_label"], json!("Go"));
    assert_eq!(c["cta"], json!("Go"));
    assert_eq!(c["body"], json!("Body"));
}

#[test]
fn header_str_coerces_non_strings_to_empty() {
    assert_eq!(header_str(Some(&json!("Hi"))), "Hi");
    assert_eq!(header_str(Some(&json!(42))), "");
    assert_eq!(header_str(Some(&Value::Null)), "");
    assert_eq!(header_str(None), "");
}

#[test]
fn is_finite_number_matches_js_semantics() {
    assert!(is_finite_number(Some(&json!(1))));
    assert!(is_finite_number(Some(&json!(1.5))));
    assert!(is_finite_number(Some(&json!(0))));
    // No string coercion, and booleans are excluded — JS Number.isFinite("1")
    // is false, unlike Number("1").
    assert!(!is_finite_number(Some(&json!("1"))));
    assert!(!is_finite_number(Some(&json!(true))));
    assert!(!is_finite_number(Some(&Value::Null)));
    assert!(!is_finite_number(None));
}
