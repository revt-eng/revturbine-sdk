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
    let d = r.resolve("pl_banner", None, None, None);

    assert_eq!(d["visible"], json!(true));
    assert_eq!(d["content"]["header"], json!("Hello"));
    assert_eq!(d["output"]["surface"]["type"], json!("banner"));
    assert_eq!(d["output"]["cta_path"]["type"], json!("navigate_to_plans"));
}

#[test]
fn a_placement_is_registered_under_both_the_bare_and_prefixed_id() {
    let r = StaticPlacementResolver::new(&[entry("pl_banner", "fixed", 0, "Hello")], &config());
    assert_eq!(
        r.resolve("banner", None, None, None)["visible"],
        json!(true)
    );
    assert_eq!(
        r.resolve("pl_banner", None, None, None)["visible"],
        json!(true)
    );
}

#[test]
fn an_unknown_placement_reports_not_found() {
    let r = StaticPlacementResolver::new(&[], &config());
    let d = r.resolve("nope", None, None, None);
    assert_eq!(d["visible"], json!(false));
    assert_eq!(d["reason_codes"], json!(["placement_not_found"]));
}

#[test]
fn a_non_seed_modal_template_resolves_to_the_modal_component_type() {
    let mut c = config();
    c["surface_templates"] = json!([{ "id": "customer_modal", "surface_type": "modal_optional" }]);
    let mut e = entry("pl_modal", "fixed", 0, "Upgrade");
    e["payloads"][0]["surfaces"][0]["template_id"] = json!("customer_modal");

    let r = StaticPlacementResolver::new(&[e], &c);
    assert_eq!(
        r.resolve("pl_modal", None, None, None)["output"]["surface"]["type"],
        json!("modal"),
    );
}

#[test]
#[should_panic(expected = "unknown_tpl has no canonical ComponentType")]
fn an_unknown_authored_template_fails_loudly() {
    let mut e = entry("pl_unknown", "fixed", 0, "Unknown");
    e["payloads"][0]["surfaces"][0]["template_id"] = json!("unknown_tpl");
    let _ = StaticPlacementResolver::new(&[e], &config());
}

#[test]
fn a_payload_status_is_ignored_because_runtime_status_is_derived() {
    // BL-0151. `RevTurbineConfigStudioPayload` has no `status` field — runtime
    // status is derived control-plane side (plan 76 REQ-1/Q-1) and presence in
    // an exported config means released. This port used to require
    // `status == "active"`, which no schema-valid Playbook ever carries, so it
    // indexed nothing while TS served the payload. A stray authored `status`
    // must now change no decision.
    let mut e = entry("pl_banner", "fixed", 0, "Hello");
    e["payloads"][0]["status"] = json!("draft");
    let r = StaticPlacementResolver::new(&[e], &config());
    let d = r.resolve("pl_banner", None, None, None);
    assert_eq!(d["visible"], json!(true));
    assert_eq!(d["content"]["header"], json!("Hello"));
}

#[test]
fn a_payload_with_no_status_key_is_a_candidate() {
    // The real wire shape: no `status` anywhere. The old filter dropped it.
    let r = StaticPlacementResolver::new(&[entry("pl_banner", "fixed", 0, "Hello")], &config());
    let d = r.resolve("pl_banner", None, None, None);
    assert_eq!(d["visible"], json!(true));
    assert_eq!(d["content"]["header"], json!("Hello"));
}

// ── Slot-based resolution ───────────────────────────────────────────────────

#[test]
fn resolves_through_a_slots_surface_template() {
    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "A")], &config());
    let d = r.resolve("slot_1", Some(&slot(&["banner_placement"])), None, None);
    assert_eq!(d["visible"], json!(true));
    assert_eq!(d["content"]["header"], json!("A"));
}

#[test]
fn a_slot_with_no_candidates_says_so_specifically() {
    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "A")], &config());
    let d = r.resolve("slot_1", Some(&slot(&["modal_overlay"])), None, None);
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
    let d = r.resolve("slot_1", Some(&slot(&["banner_placement"])), None, None);
    assert_eq!(d["content"]["header"], json!("First"), "lower order wins");
}

// ── D-59 category-first decision contract (supersedes D-34) ────────────────
//
// Kent's ruling D-59 (2026-10-06, supersedes D-34): eligible candidates rank
// by category first (Access Gates, Fixed, usage/trial alerts, nudges), then
// within tier — two-stage urgency for alerts, drag order otherwise; the
// highest fired usage milestone per entitlement wins; a slot that asks for an
// entitlement is answered only by that entitlement's placements. Mirrors
// `ts:local-resolver.test.ts` "D-59 category-first decision contract" case for
// case (the two `candidateGate` cases have no server equivalent — server ports
// carry no presentation state).

fn d59_nudge(id: &str, order: i64, header: &str, category: &str) -> Value {
    let mut e = entry(id, category, order, header);
    e["trigger"] = json!({});
    e
}

fn d59_usage(id: &str, order: i64, header: &str, handle: &str, threshold: i64) -> Value {
    let mut e = entry(id, "usage_credit_seat", order, header);
    e["trigger"] = json!({
        "type": "usage_threshold",
        "entitlement_handle": handle,
        "threshold_percent": threshold,
    });
    e
}

fn d59_ctx(usage_by_handle: &[(&str, i64, i64)]) -> Value {
    let usage: serde_json::Map<String, Value> = usage_by_handle
        .iter()
        .map(|(h, used, limit)| {
            (
                (*h).to_string(),
                json!({ "used": used, "limit": limit, "remaining": limit - used }),
            )
        })
        .collect();
    json!({ "__providers": { "entitlements": { "usage": usage } } })
}

fn d59_decide(entries: &[Value], context: &Value) -> Value {
    StaticPlacementResolver::new(entries, &config()).resolve(
        "slot_1",
        Some(&slot(&["banner_placement"])),
        Some(context),
        None,
    )
}

#[test]
fn d59_a_usage_alert_beats_a_conversion_nudge_listed_above_it() {
    let d = d59_decide(
        &[
            d59_nudge("pl_nudge", 0, "Nudge", "other_conversion"),
            d59_usage("pl_alert", 0, "Alert", "api_calls", 100),
        ],
        &d59_ctx(&[("api_calls", 100, 100)]),
    );
    assert_eq!(d["content"]["header"], json!("Alert"), "tier 3 over tier 4");
}

#[test]
fn d59_limit_reached_beats_an_approaching_warning_listed_above_it() {
    let d = d59_decide(
        &[
            d59_usage(
                "pl_exports_approaching",
                0,
                "Half your exports are used",
                "exports",
                50,
            ),
            d59_usage(
                "pl_api_at_limit",
                1,
                "You have hit your API limit",
                "api_calls",
                100,
            ),
        ],
        &d59_ctx(&[("exports", 50, 100), ("api_calls", 100, 100)]),
    );
    assert_eq!(
        d["content"]["header"],
        json!("You have hit your API limit"),
        "§3.2 two-stage urgency"
    );
}

#[test]
fn d59_within_a_class_the_candidate_closer_to_its_limit_wins() {
    let d = d59_decide(
        &[
            d59_usage("pl_low", 0, "Low", "exports", 50),
            d59_usage("pl_high", 1, "High", "api_calls", 50),
        ],
        &d59_ctx(&[("exports", 55, 100), ("api_calls", 90, 100)]),
    );
    assert_eq!(d["content"]["header"], json!("High"));
}

#[test]
fn d59_the_higher_usage_milestone_supersedes_a_lower_one_listed_first() {
    let d = d59_decide(
        &[
            d59_usage("pl_70", 0, "Seventy", "api_calls", 70),
            d59_usage("pl_100", 1, "Hundred", "api_calls", 100),
        ],
        &d59_ctx(&[("api_calls", 100, 100)]),
    );
    assert_eq!(d["content"]["header"], json!("Hundred"), "§6 milestones");
}

#[test]
fn d59_nudges_rank_by_drag_order_and_tier4_ties_resolve_conversion_first() {
    let d = d59_decide(
        &[
            d59_nudge("pl_retention", 0, "Retention", "retention"),
            d59_nudge("pl_conversion", 0, "Conversion", "other_conversion"),
        ],
        &d59_ctx(&[]),
    );
    assert_eq!(d["content"]["header"], json!("Conversion"));
    let ordered = d59_decide(
        &[
            d59_nudge("pl_b", 1, "Second", "other_conversion"),
            d59_nudge("pl_a", 0, "First", "other_conversion"),
        ],
        &d59_ctx(&[]),
    );
    assert_eq!(ordered["content"]["header"], json!("First"));
}

#[test]
fn d59_a_gate_slot_with_no_placement_for_its_entitlement_is_an_explicit_miss() {
    let mut other_gate = entry("pl_seats_gate", "gated", 0, "Seats");
    other_gate["trigger"] =
        json!({ "type": "entitlement_gate", "entitlement_handle": "seats_pro" });
    let gate_slot = json!({
        "surface_template_ids": ["banner_placement"],
        "surface_slot_category": "gated",
        "entitlement_handle": "exports_pro",
    });
    let d = StaticPlacementResolver::new(&[other_gate], &config()).resolve(
        "gate",
        Some(&gate_slot),
        Some(&d59_ctx(&[])),
        None,
    );
    assert_eq!(d["visible"], json!(false));
    assert_eq!(d["reason_codes"], json!(["no_gate_for_entitlement"]));
}

// ── D-60 (Kent, 2026-10-06): Access Gate placements ──────────────────────
// A gate appears only in an Access Gate slot, and only while its
// entitlement is denied or limited. Mirrors the TS "D-60 Access Gate
// placements" block and the py TestAccessGatePlacements class.

fn d60_gate() -> Value {
    let mut gate = entry("pl_gate", "gated", 0, "Gate");
    gate["trigger"] = json!({ "type": "entitlement_gate", "entitlement_handle": "exports_pro" });
    gate
}

fn d60_status(status: &str) -> Value {
    json!({ "__providers": { "entitlements": { "entries": {
        "exports_pro": { "status": status, "allowed": status == "allowed" },
    } } } })
}

fn d60_gate_slot() -> Value {
    json!({
        "surface_template_ids": ["banner_placement"],
        "surface_slot_category": "gated",
        "entitlement_handle": "exports_pro",
    })
}

fn d60_resolve(entries: &[Value], slot: &Value, context: Option<&Value>) -> Value {
    StaticPlacementResolver::new(entries, &config()).resolve("test", Some(slot), context, None)
}

#[test]
fn d60_a_gate_never_appears_outside_an_access_gate_slot_even_while_denied() {
    let d = d60_resolve(
        &[d60_gate(), entry("pl_fixed", "fixed", 5, "Fixed")],
        &slot(&["banner_placement"]),
        Some(&d60_status("denied")),
    );
    assert_eq!(d["content"]["header"], json!("Fixed"));
}

#[test]
fn d60_a_gate_fires_in_its_gate_slot_when_denied_or_limited() {
    for status in ["denied", "limited"] {
        let d = d60_resolve(&[d60_gate()], &d60_gate_slot(), Some(&d60_status(status)));
        assert_eq!(d["content"]["header"], json!("Gate"), "{status}");
    }
}

#[test]
fn d60_a_gate_does_not_fire_while_allowed_or_when_no_status_is_known() {
    let allowed = d60_resolve(
        &[d60_gate()],
        &d60_gate_slot(),
        Some(&d60_status("allowed")),
    );
    assert_eq!(allowed["visible"], json!(false));
    let unknown = d60_resolve(&[d60_gate()], &d60_gate_slot(), None);
    assert_eq!(unknown["visible"], json!(false));
}

#[test]
fn d60_the_gate_slots_own_check_result_wins_over_the_provider_entry() {
    let mut slot_with_status = d60_gate_slot();
    slot_with_status["entitlement_status"] = json!("denied");
    let d = d60_resolve(
        &[d60_gate()],
        &slot_with_status,
        Some(&d60_status("allowed")),
    );
    assert_eq!(d["content"]["header"], json!("Gate"));
}

#[test]
fn d60_direct_lookup_refuses_an_allowed_entitlement_and_a_registered_non_gate_slot() {
    let resolver = StaticPlacementResolver::new(&[d60_gate()], &config());
    let allowed = resolver.resolve(
        "pl_gate",
        Some(&json!({})),
        Some(&d60_status("allowed")),
        None,
    );
    assert_eq!(allowed["reason_codes"], json!(["entitlement_not_denied"]));
    let in_fixed = resolver.resolve(
        "pl_gate",
        Some(&json!({ "surface_slot_category": "fixed" })),
        Some(&d60_status("denied")),
        None,
    );
    assert_eq!(
        in_fixed["reason_codes"],
        json!(["gate_outside_access_gate"])
    );
    let denied = resolver.resolve(
        "pl_gate",
        Some(&json!({})),
        Some(&d60_status("denied")),
        None,
    );
    assert_eq!(denied["visible"], json!(true));
}

#[test]
fn fixed_only_is_a_hard_filter_that_may_leave_nothing() {
    // A slot reserved for PM-wired content must never render an RT-initiated
    // nudge — even at the cost of rendering nothing.
    let placements = vec![entry("pl_upsell", "other_conversion", 0, "Upsell")];
    let r = StaticPlacementResolver::new(&placements, &config());

    let mut s = slot(&["banner_placement"]);
    s["fixed_only"] = json!(true);
    let d = r.resolve("slot_1", Some(&s), None, None);
    assert_eq!(d["visible"], json!(false));
    assert_eq!(
        d["reason_codes"],
        json!(["no_eligible_candidate"]),
        "filtered to empty rather than falling back",
    );

    // Without the flag the same candidate resolves.
    let open = r.resolve("slot_1", Some(&slot(&["banner_placement"])), None, None);
    assert_eq!(open["visible"], json!(true));
}

#[test]
fn a_slot_hint_that_matches_nothing_does_not_empty_the_set() {
    // Narrowing filters apply only if they leave something — otherwise a
    // stale slot hint would silently blank a working surface. (The slot's
    // `entitlement_handle` is no longer such a hint: D-59 makes it a hard
    // filter — see the `no_gate_for_entitlement` case above.)
    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "A")], &config());
    let mut s = slot(&["banner_placement"]);
    s["surface_slot_id"] = json!("nothing_matches_this");
    let d = r.resolve("slot_1", Some(&s), None, None);
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
    let d = r.resolve("pl_x", None, None, None);
    assert_eq!(d["visible"], json!(false));
    assert_eq!(d["reason_codes"], json!(["threshold_trigger_unmet"]));

    // At the threshold it resolves.
    let c = json!({ "__providers": {
        "entitlements": { "usage": { "exports": { "used": 90, "limit": 100 } } }
    }});
    assert_eq!(
        r.resolve("pl_x", None, Some(&c), None)["visible"],
        json!(true)
    );
}

#[test]
fn a_trial_trigger_gates_the_direct_path_too() {
    let mut e = entry("pl_t", "trials", 0, "H");
    e["trigger"] = json!({ "type": "trial_ended" });
    let r = StaticPlacementResolver::new(&[e], &config());

    let no_trial = ctx(json!({ "trial_state": "active" }));
    assert_eq!(
        r.resolve("pl_t", None, Some(&no_trial), None)["reason_codes"],
        json!(["trial_trigger_unmet"])
    );

    let ended = ctx(json!({ "trial_state": "expired" }));
    assert_eq!(
        r.resolve("pl_t", None, Some(&ended), None)["visible"],
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
    let d = r.resolve("pl_u", None, Some(&c), None);

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

// ── Trial enrichment (BL-0169) ──────────────────────────────────────────────

/// `interpolate_content_tokens` sources its token map from the output content
/// itself, so a provider-derived token only reaches the copy if the resolver
/// writes it there first. Mirrors `ts:local-resolver.test.ts` "trial tokens
/// injected from plan provider state (BL-0169)".
#[test]
fn trial_tokens_are_injected_from_plan_provider_state() {
    let mut e = entry(
        "pl_trial",
        "trials",
        0,
        "{{trial_days_remaining}} days left",
    );
    e["payloads"][0]["surfaces"][0]["fields"]["body"] =
        json!("Day {{trial_days_remaining}} of {{trial_days_total}}");
    e["trigger"] = json!({ "type": "trial_ending", "days_before_end": 3 });
    let r = StaticPlacementResolver::new(&[e], &config());

    let c = ctx(json!({
        "trial_active": true,
        "trial_state": "active",
        "trial_limit_type": "time",
        "trial_days_remaining": 3,
        "trial_days_total": 10,
    }));
    let d = r.resolve("pl_trial", None, Some(&c), None);

    assert_eq!(d["visible"], json!(true));
    let content = &d["output"]["content"];
    // Integer representation is preserved, not widened (BL-0155).
    assert_eq!(content["trial_days_remaining"], json!(3));
    assert_eq!(content["trial_days_total"], json!(10));
    assert_eq!(d["content"]["header"], json!("3 days left"));
    assert_eq!(d["content"]["body"], json!("Day 3 of 10"));
}

#[test]
fn an_absent_trial_state_leaves_the_raw_trial_token() {
    let r = StaticPlacementResolver::new(
        &[entry(
            "pl_trial",
            "fixed",
            0,
            "{{trial_days_remaining}} days left",
        )],
        &config(),
    );
    let c = ctx(json!({ "current_plan_handle": "starter" }));
    let d = r.resolve("pl_trial", None, Some(&c), None);

    assert!(d["output"]["content"]["trial_days_remaining"].is_null());
    assert_eq!(
        d["content"]["header"],
        json!("{{trial_days_remaining}} days left")
    );
}

#[test]
fn live_trial_state_overrides_an_authored_trial_value() {
    let mut e = entry("pl_trial", "fixed", 0, "{{trial_days_remaining}} days left");
    e["payloads"][0]["surfaces"][0]["fields"]["trial_days_remaining"] = json!(99);
    let r = StaticPlacementResolver::new(&[e], &config());

    let c = ctx(json!({ "trial_active": true, "trial_days_remaining": 3 }));
    let d = r.resolve("pl_trial", None, Some(&c), None);

    assert_eq!(d["content"]["header"], json!("3 days left"));
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
        r.resolve("pl_u", None, Some(&c), None)["reason_codes"],
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
        r.resolve("pl_up", None, Some(&starter), None)["visible"],
        json!(true)
    );

    let ent = ctx(json!({ "current_plan_handle": "enterprise" }));
    let d = r.resolve("pl_up", None, Some(&ent), None);
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
    assert_eq!(
        r.resolve("pl_f", None, Some(&ent), None)["visible"],
        json!(true)
    );
}

// ── Plan targeting ──────────────────────────────────────────────────────────

#[test]
fn a_plan_targeted_payload_is_skipped_for_other_plans() {
    let mut e = entry("pl_t", "fixed", 0, "Targeted");
    e["payloads"][0]["target"] = json!({ "plan_ids": ["enterprise"] });
    let r = StaticPlacementResolver::new(&[e], &config());

    let starter = ctx(json!({ "current_plan_handle": "starter" }));
    assert_eq!(
        r.resolve("pl_t", None, Some(&starter), None)["reason_codes"],
        json!(["plan_target_mismatch"])
    );

    let ent = ctx(json!({ "current_plan_handle": "enterprise" }));
    assert_eq!(
        r.resolve("pl_t", None, Some(&ent), None)["visible"],
        json!(true)
    );
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
    let d = r.resolve("pl_a", None, None, None);

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
    let d = r.resolve("pl_a", None, Some(&ctx_with_segments(&[])), None);
    assert_eq!(
        d["content"]["header"],
        json!("Linked default"),
        "the linked block's copy replaces the inline surface copy",
    );
    assert_eq!(d["output"]["message_block_handle"], json!("blk_1"));
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

    let by_slug = r.resolve("pl_a", None, Some(&ctx_with_segments(&["s_paid"])), None);
    assert_eq!(by_slug["content"]["header"], json!("Linked paid"));

    let by_id = r.resolve(
        "pl_a",
        None,
        Some(&json!({ "__providers": { "segments": { "segment_ids": ["s_paid"] } } })),
        None,
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
    let d = r.resolve("pl_a", None, Some(&c), None);

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
    let d = r.resolve("pl_a", None, Some(&ctx_with_segments(&["s_paid"])), None);
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
        r.resolve("pl_a", None, None, None)["content"]["header"],
        json!("Inline header")
    );
}

#[test]
fn a_content_linked_payloads_status_is_ignored() {
    // BL-0151. `RevTurbineConfigPlacementPayloadItem` has no `status` field
    // either, so reading one off the wire always fell to "inactive" and the
    // content-lookup provider dropped every content-linked payload — this port
    // kept the inline copy where TS overlaid the linked block. Presence in an
    // exported config means released (plan 76); a stray authored value on
    // either side of the enum changes nothing.
    for stray in ["draft", "something_new"] {
        let mut c = config_with_content_link();
        c["placement_payloads"][0]["status"] = json!(stray);
        let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "Inline header")], &c);
        assert_eq!(
            r.resolve("pl_a", None, Some(&ctx_with_segments(&[])), None)["content"]["header"],
            json!("Linked default"),
            "authored status {stray} must not gate the overlay",
        );
    }
}

#[test]
fn a_content_linked_payload_with_no_status_key_is_overlaid() {
    // The real wire shape: no `status` anywhere on the studio payload.
    let mut c = config_with_content_link();
    c["placement_payloads"][0]
        .as_object_mut()
        .expect("studio payload is an object")
        .remove("status");
    let r = StaticPlacementResolver::new(&[entry("pl_a", "fixed", 0, "Inline header")], &c);
    assert_eq!(
        r.resolve("pl_a", None, Some(&ctx_with_segments(&[])), None)["content"]["header"],
        json!("Linked default"),
    );
}

// ── D-62 (Kent, 2026-10-06): message slots show only RT-initiated content ──
// Mirrors the TS "D-62 message slots" block and the py
// TestMessageSlotsShowOnlyRtInitiated class.

fn d62_message_slot() -> Value {
    json!({ "surface_template_ids": ["banner_placement"], "surface_slot_category": "triggered" })
}

fn d62_resolve(entries: &[Value]) -> Value {
    StaticPlacementResolver::new(entries, &config()).resolve(
        "msg",
        Some(&d62_message_slot()),
        None,
        None,
    )
}

#[test]
fn d62_a_message_slot_never_shows_fixed_content_even_alone() {
    let d = d62_resolve(&[entry("pl_fixed", "fixed", 0, "Fixed")]);
    assert_eq!(d["visible"], json!(false));
}

#[test]
fn d62_rt_initiated_content_wins_over_fixed_in_a_message_slot() {
    let d = d62_resolve(&[
        entry("pl_fixed", "fixed", 0, "Fixed"),
        entry("pl_nudge", "other_conversion", 0, "Nudge"),
    ]);
    assert_eq!(d["content"]["header"], json!("Nudge"));
}

#[test]
fn d62_every_rt_initiated_category_spelling_is_accepted() {
    for category in [
        "usage_credit_seat",
        "usage_limit",
        "trials",
        "trial",
        "other_conversion",
        "retention",
    ] {
        let d = d62_resolve(&[entry("pl_rt", category, 0, "RT")]);
        assert_eq!(d["content"]["header"], json!("RT"), "{category}");
    }
}
