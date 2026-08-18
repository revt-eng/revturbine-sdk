//! The static placement resolver — indexing, filtering, selection, shaping.
//!
//! Mirrors `server-python/tests/placements/test_local_resolver.py`.

use serde_json::{json, Value};

use revturbine::placements::{interpolate_string_tokens, StaticPlacementResolver};

fn config() -> Value {
    json!({
        "format_version": "1.0",
        "plans": [
            { "unique_handle": "starter" },
            { "unique_handle": "enterprise" },
        ],
        "entitlements": [{
            "unique_handle": "seats",
            "tier_definitions": [{ "handle": "free" }, { "handle": "pro" }],
        }],
        "surface_templates": [{ "id": "banner_placement", "surface_type": "banner" }],
    })
}

/// One placement entry with an active payload on the banner template.
fn entry(id: &str, category: &str, order: i64, header: &str) -> Value {
    json!({
        "id": id,
        "category": category,
        "order": order,
        "payloads": [{
            "id": format!("{id}_payload"),
            "status": "active",
            "surfaces": [{
                "template_id": "banner_placement",
                "fields": { "header": header, "body": "Body" },
                "ctas": [{ "label": "Go", "path": "view_plans" }],
            }],
        }],
    })
}

fn slot(template_ids: &[&str]) -> Value {
    json!({ "surface_template_ids": template_ids })
}

fn ctx(plan: Value) -> Value {
    json!({ "__providers": { "plan": plan } })
}

// ── Direct lookup ───────────────────────────────────────────────────────────

#[test]
fn resolves_directly_by_placement_id() {
    let r = StaticPlacementResolver::new(&[entry("pl_banner", "fixed", 0, "Hello")], &config());
    let d = r.resolve("pl_banner", None, None);

    assert_eq!(d["visible"], json!(true));
    assert_eq!(d["content"]["header"], json!("Hello"));
    assert_eq!(d["output"]["surface"]["type"], json!("banner"));
    assert_eq!(d["output"]["cta_path"]["type"], json!("navigate_to_plans"));
}

#[test]
fn a_placement_is_registered_under_both_the_bare_and_prefixed_id() {
    let r = StaticPlacementResolver::new(&[entry("pl_banner", "fixed", 0, "Hello")], &config());
    assert_eq!(r.resolve("banner", None, None)["visible"], json!(true));
    assert_eq!(r.resolve("pl_banner", None, None)["visible"], json!(true));
}

#[test]
fn an_unknown_placement_reports_not_found() {
    let r = StaticPlacementResolver::new(&[], &config());
    let d = r.resolve("nope", None, None);
    assert_eq!(d["visible"], json!(false));
    assert_eq!(d["reason_codes"], json!(["placement_not_found"]));
}

#[test]
fn a_payload_that_is_not_active_is_never_indexed() {
    let mut e = entry("pl_banner", "fixed", 0, "Hello");
    e["payloads"][0]["status"] = json!("draft");
    let r = StaticPlacementResolver::new(&[e], &config());
    assert_eq!(
        r.resolve("pl_banner", None, None)["reason_codes"],
        json!(["placement_not_found"])
    );
}

// ── Slot-based resolution ───────────────────────────────────────────────────

#[test]
fn resolves_through_a_slots_surface_template() {
    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "A")], &config());
    let d = r.resolve("slot_1", Some(&slot(&["banner_placement"])), None);
    assert_eq!(d["visible"], json!(true));
    assert_eq!(d["content"]["header"], json!("A"));
}

#[test]
fn a_slot_with_no_candidates_says_so_specifically() {
    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "A")], &config());
    let d = r.resolve("slot_1", Some(&slot(&["modal_overlay"])), None);
    assert_eq!(d["visible"], json!(false));
    assert_eq!(d["reason_codes"], json!(["no_candidates_for_template"]));
}

#[test]
fn authored_order_decides_among_candidates() {
    let placements = vec![
        entry("pl_second", "fixed", 5, "Second"),
        entry("pl_first", "fixed", 1, "First"),
    ];
    let r = StaticPlacementResolver::new(&placements, &config());
    let d = r.resolve("slot_1", Some(&slot(&["banner_placement"])), None);
    assert_eq!(d["content"]["header"], json!("First"), "lower order wins");
}

#[test]
fn fixed_only_is_a_hard_filter_that_may_leave_nothing() {
    // A slot reserved for PM-wired content must never render an RT-initiated
    // nudge — even at the cost of rendering nothing.
    let placements = vec![entry("pl_upsell", "other_conversion", 0, "Upsell")];
    let r = StaticPlacementResolver::new(&placements, &config());

    let mut s = slot(&["banner_placement"]);
    s["fixed_only"] = json!(true);
    let d = r.resolve("slot_1", Some(&s), None);
    assert_eq!(d["visible"], json!(false));
    assert_eq!(
        d["reason_codes"],
        json!(["no_eligible_candidate"]),
        "filtered to empty rather than falling back",
    );

    // Without the flag the same candidate resolves.
    let open = r.resolve("slot_1", Some(&slot(&["banner_placement"])), None);
    assert_eq!(open["visible"], json!(true));
}

#[test]
fn a_slot_hint_that_matches_nothing_does_not_empty_the_set() {
    // Narrowing filters apply only if they leave something — otherwise a
    // stale slot hint would silently blank a working surface.
    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "A")], &config());
    let mut s = slot(&["banner_placement"]);
    s["entitlement_handle"] = json!("nothing_matches_this");
    let d = r.resolve("slot_1", Some(&s), None);
    assert_eq!(d["visible"], json!(true), "hint ignored rather than fatal");
    assert_eq!(d["content"]["header"], json!("A"));
}

// ── Gating on the direct path ───────────────────────────────────────────────

#[test]
fn direct_lookup_reports_which_gate_rejected_it() {
    let mut e = entry("pl_x", "usage_credit_seat", 0, "H");
    e["trigger"] = json!({
        "type": "usage_threshold",
        "entitlement_handle": "exports",
        "threshold_percent": 80,
    });
    let r = StaticPlacementResolver::new(&[e], &config());

    // No usage state → threshold gate fails closed.
    let d = r.resolve("pl_x", None, None);
    assert_eq!(d["visible"], json!(false));
    assert_eq!(d["reason_codes"], json!(["threshold_trigger_unmet"]));

    // At the threshold it resolves.
    let c = json!({ "__providers": {
        "entitlements": { "usage": { "exports": { "used": 90, "limit": 100 } } }
    }});
    assert_eq!(r.resolve("pl_x", None, Some(&c))["visible"], json!(true));
}

#[test]
fn a_trial_trigger_gates_the_direct_path_too() {
    let mut e = entry("pl_t", "trials", 0, "H");
    e["trigger"] = json!({ "type": "trial_ended" });
    let r = StaticPlacementResolver::new(&[e], &config());

    let no_trial = ctx(json!({ "trial_state": "active" }));
    assert_eq!(
        r.resolve("pl_t", None, Some(&no_trial))["reason_codes"],
        json!(["trial_trigger_unmet"])
    );

    let ended = ctx(json!({ "trial_state": "expired" }));
    assert_eq!(
        r.resolve("pl_t", None, Some(&ended))["visible"],
        json!(true)
    );
}

// ── Usage enrichment ────────────────────────────────────────────────────────

#[test]
fn usage_tokens_are_injected_and_percent_uses_js_rounding() {
    let mut e = entry(
        "pl_u",
        "usage_credit_seat",
        0,
        "{{usage_current}} of {{usage_limit}}",
    );
    e["trigger"] = json!({ "type": "usage_threshold", "entitlement_handle": "exports", "threshold_percent": 0 });
    let r = StaticPlacementResolver::new(&[e], &config());

    let c = json!({ "__providers": {
        "entitlements": { "usage": { "exports": { "used": 7, "limit": 8 } } }
    }});
    let d = r.resolve("pl_u", None, Some(&c));

    let content = &d["output"]["content"];
    assert_eq!(content["usage_current"], json!(7));
    assert_eq!(content["usage_limit"], json!(8));
    assert_eq!(
        content["usage_remaining"],
        json!(0),
        "absent `remaining` → 0"
    );
    // 87.5 rounds to 88 — js_math_round, which breaks ties toward +inf.
    assert_eq!(content["usage_percent"], json!(88));
    // ...and the tokens rendered into the header.
    assert_eq!(d["content"]["header"], json!("7 of 8"));
}

#[test]
fn usage_percent_is_zero_when_the_limit_is_not_positive() {
    let mut e = entry("pl_u", "usage_credit_seat", 0, "H");
    e["trigger"] = json!({ "type": "usage_threshold", "entitlement_handle": "exports", "threshold_percent": 0 });
    let r = StaticPlacementResolver::new(&[e], &config());

    let c = json!({ "__providers": {
        "entitlements": { "usage": { "exports": { "used": 5, "limit": 0 } } }
    }});
    // The threshold gate fails closed on a non-positive limit, so this asserts
    // via the direct-path reason rather than the content.
    assert_eq!(
        r.resolve("pl_u", None, Some(&c))["reason_codes"],
        json!(["threshold_trigger_unmet"])
    );
}

// ── Visibility ──────────────────────────────────────────────────────────────

#[test]
fn upsell_surfaces_are_suppressed_for_enterprise() {
    // Suppression happens at ELIGIBILITY, not at the later visibility step:
    // `evaluate_plan_eligibility` already rejects upsell / trial_conversion
    // for the enterprise handle (`enterprise_upsell_suppressed`), so the
    // candidate never reaches selection.
    //
    // That makes the resolver's own `plan_tier_suppressed` visibility branch
    // unreachable for these categories — a redundancy that exists identically
    // in the TS and Python ports. Preserved rather than "fixed": collapsing it
    // would be a behaviour change dressed as a cleanup, and any real
    // divergence belongs to the shared eligibility rule, not to one port.
    let r = StaticPlacementResolver::new(&[entry("pl_up", "upsell", 0, "Upgrade")], &config());

    let starter = ctx(json!({ "current_plan_handle": "starter" }));
    assert_eq!(
        r.resolve("pl_up", None, Some(&starter))["visible"],
        json!(true)
    );

    let ent = ctx(json!({ "current_plan_handle": "enterprise" }));
    let d = r.resolve("pl_up", None, Some(&ent));
    assert_eq!(d["visible"], json!(false));
    assert_eq!(
        d["reason_codes"],
        json!(["plan_target_mismatch"]),
        "rejected by eligibility, so it never reaches plan_tier_suppressed",
    );
}

#[test]
fn a_non_upsell_category_is_visible_to_enterprise() {
    let r = StaticPlacementResolver::new(&[entry("pl_f", "fixed", 0, "Notice")], &config());
    let ent = ctx(json!({ "current_plan_handle": "enterprise" }));
    assert_eq!(r.resolve("pl_f", None, Some(&ent))["visible"], json!(true));
}

// ── Plan targeting ──────────────────────────────────────────────────────────

#[test]
fn a_plan_targeted_payload_is_skipped_for_other_plans() {
    let mut e = entry("pl_t", "fixed", 0, "Targeted");
    e["payloads"][0]["target"] = json!({ "plan_ids": ["enterprise"] });
    let r = StaticPlacementResolver::new(&[e], &config());

    let starter = ctx(json!({ "current_plan_handle": "starter" }));
    assert_eq!(
        r.resolve("pl_t", None, Some(&starter))["reason_codes"],
        json!(["plan_target_mismatch"])
    );

    let ent = ctx(json!({ "current_plan_handle": "enterprise" }));
    assert_eq!(r.resolve("pl_t", None, Some(&ent))["visible"], json!(true));
}

// ── Token interpolation ─────────────────────────────────────────────────────

#[test]
fn an_unresolved_token_collapses_its_whitespace() {
    // This is where the resolver DIFFERS from payload_resolution, which keeps
    // the original match verbatim. The difference is load-bearing for parity.
    let tokens = serde_json::Map::new();
    assert_eq!(
        interpolate_string_tokens("Hi {{ name }}!", &tokens),
        "Hi {{name}}!"
    );
    assert_eq!(
        interpolate_string_tokens("Hi {{name}}!", &tokens),
        "Hi {{name}}!"
    );

    let mut with = serde_json::Map::new();
    with.insert("name".into(), json!("Ada"));
    assert_eq!(
        interpolate_string_tokens("Hi {{ name }}!", &with),
        "Hi Ada!"
    );

    // A null value is treated as absent here, unlike payload_resolution where
    // present-but-null renders "null".
    let mut nulled = serde_json::Map::new();
    nulled.insert("name".into(), Value::Null);
    assert_eq!(
        interpolate_string_tokens("Hi {{name}}!", &nulled),
        "Hi {{name}}!"
    );
}

// ── Decision shape ──────────────────────────────────────────────────────────

#[test]
fn the_decision_carries_both_content_namings_and_provenance() {
    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "Head")], &config());
    let d = r.resolve("pl_a", None, None);

    assert_eq!(d["content"]["header"], json!("Head"));
    assert_eq!(d["content"]["title"], json!("Head"), "legacy mirror");
    assert_eq!(d["content"]["cta"], d["content"]["cta_label"]);
    assert_eq!(d["decision_source"], json!("fallback"));
    assert_eq!(d["placement_id"], json!("pl_a"));
    assert_eq!(d["output"]["config_version"], json!("1.0"));
}

// ── Content-linked overlay (plan 77) ────────────────────────────────────────

/// A Playbook that ships content-linked payloads + the blocks they point at.
fn config_with_content_link() -> Value {
    let mut c = config();
    c["placement_payloads"] = json!([{
        "payload_id": "cp_1",
        "placement_id": "pl_a",
        "status": "active",
        "content_link": { "message_block_id": "blk_1" },
    }]);
    c["message_blocks"] = json!([{
        "block_id": "blk_1",
        "status": "active",
        "default_content": { "header": "Linked default" },
        "segment_overrides": [
            { "segment_value_id": "s_paid", "content": { "header": "Linked paid" } }
        ],
    }]);
    c
}

fn ctx_with_segments(slugs: &[&str]) -> Value {
    json!({ "__providers": { "segments": { "segment_slugs": slugs } } })
}

#[test]
fn content_linked_copy_overlays_the_inline_content() {
    let r = StaticPlacementResolver::new(
        &[entry("pl_a", "fixed", 0, "Inline header")],
        &config_with_content_link(),
    );
    let d = r.resolve("pl_a", None, Some(&ctx_with_segments(&[])));
    assert_eq!(
        d["content"]["header"],
        json!("Linked default"),
        "the linked block's copy replaces the inline surface copy",
    );
}

#[test]
fn the_overlay_resolves_against_segment_handles_not_ids() {
    // Plan 120: content overrides reference `segment_value_id` HANDLES, so the
    // user's set must key off `segment_slugs`. Reading `segment_ids` here
    // would match nothing and silently fall back to the default copy.
    let r = StaticPlacementResolver::new(
        &[entry("pl_a", "fixed", 0, "Inline header")],
        &config_with_content_link(),
    );

    let by_slug = r.resolve("pl_a", None, Some(&ctx_with_segments(&["s_paid"])));
    assert_eq!(by_slug["content"]["header"], json!("Linked paid"));

    let by_id = r.resolve(
        "pl_a",
        None,
        Some(&json!({ "__providers": { "segments": { "segment_ids": ["s_paid"] } } })),
    );
    assert_eq!(
        by_id["content"]["header"],
        json!("Linked default"),
        "segment_ids is deliberately NOT consulted",
    );
}

#[test]
fn the_overlay_preserves_the_meta_keys_usage_enrichment_reads() {
    // The `__`-prefixed keys ride on content; if the overlay replaced the map
    // wholesale instead of merging, usage enrichment would lose its handle.
    let mut e = entry("pl_a", "usage_credit_seat", 0, "Inline");
    e["trigger"] = json!({
        "type": "usage_threshold", "entitlement_handle": "exports", "threshold_percent": 0
    });
    let r = StaticPlacementResolver::new(&[e], &config_with_content_link());

    let c = json!({ "__providers": {
        "segments": { "segment_slugs": [] },
        "entitlements": { "usage": { "exports": { "used": 5, "limit": 10 } } },
    }});
    let d = r.resolve("pl_a", None, Some(&c));

    assert_eq!(
        d["content"]["header"],
        json!("Linked default"),
        "overlay applied"
    );
    assert_eq!(
        d["output"]["content"]["usage_percent"],
        json!(50),
        "usage enrichment still found its entitlement handle",
    );
}

#[test]
fn a_playbook_without_content_links_keeps_the_inline_copy() {
    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "Inline header")], &config());
    let d = r.resolve("pl_a", None, Some(&ctx_with_segments(&["s_paid"])));
    assert_eq!(d["content"]["header"], json!("Inline header"));
}

#[test]
fn an_inline_studio_payload_is_not_treated_as_content_linked() {
    // No `content_link` → nothing to overlay, so the inline copy stands.
    let mut c = config();
    c["message_blocks"] = json!([{ "block_id": "blk_1", "status": "active",
        "default_content": { "header": "Linked" } }]);
    c["placement_payloads"] = json!([{ "payload_id": "cp_1", "placement_id": "pl_a",
        "status": "active" }]);

    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "Inline header")], &c);
    assert_eq!(
        r.resolve("pl_a", None, None)["content"]["header"],
        json!("Inline header")
    );
}

#[test]
fn a_non_active_content_linked_payload_is_not_overlaid() {
    let mut c = config_with_content_link();
    c["placement_payloads"][0]["status"] = json!("draft");
    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "Inline header")], &c);
    assert_eq!(
        r.resolve("pl_a", None, None)["content"]["header"],
        json!("Inline header"),
    );
}

#[test]
fn an_unrecognized_status_is_treated_as_inactive_not_publishable() {
    let mut c = config_with_content_link();
    c["placement_payloads"][0]["status"] = json!("something_new");
    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "Inline header")], &c);
    assert_eq!(
        r.resolve("pl_a", None, None)["content"]["header"],
        json!("Inline header"),
        "an unknown status must not read as publishable",
    );
}
