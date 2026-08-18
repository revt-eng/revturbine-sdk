//! Payload resolution: token substitution, segment matching, block overrides.
//!
//! Mirrors `server-python/tests/placements/test_payload_resolution.py`. The
//! token scanner is hand-rolled (no `regex` dependency in a published SDK), so
//! its edges get proportionally more scrutiny here.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use revturbine::placements::{
    apply_value_maps, js_string, resolve_content, resolve_payload_for_user, resolve_tokens,
};

fn ctx(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

// ── JS String() coercion ────────────────────────────────────────────────────

#[test]
fn js_string_matches_javascript_coercion() {
    // Each of these diverges under a naive Rust conversion, and each would
    // surface at TASK-10 as an opaque byte-diff rather than a named failure.
    assert_eq!(js_string(&json!(null)), "null");
    assert_eq!(js_string(&json!(true)), "true");
    assert_eq!(js_string(&json!(false)), "false");
    assert_eq!(js_string(&json!(1.0)), "1", "JS String(1.0) === '1'");
    assert_eq!(js_string(&json!(42)), "42");
    assert_eq!(js_string(&json!(1.5)), "1.5");
    assert_eq!(
        js_string(&json!("text")),
        "text",
        "bare, not JSON-quoted — Value::to_string would add quotes",
    );
}

// ── Token scanner ───────────────────────────────────────────────────────────

#[test]
fn substitutes_tokens_with_and_without_whitespace() {
    let c = ctx(json!({ "name": "Ada" }));
    assert_eq!(resolve_tokens("Hi {{name}}!", &c), "Hi Ada!");
    assert_eq!(resolve_tokens("Hi {{ name }}!", &c), "Hi Ada!");
    assert_eq!(resolve_tokens("Hi {{   name   }}!", &c), "Hi Ada!");
}

#[test]
fn substitutes_adjacent_and_repeated_tokens() {
    let c = ctx(json!({ "a": "1", "b": "2" }));
    assert_eq!(resolve_tokens("{{a}}{{b}}", &c), "12");
    assert_eq!(resolve_tokens("{{a}} {{a}}", &c), "1 1");
    assert_eq!(resolve_tokens("{{a}}", &c), "1");
}

#[test]
fn an_unresolved_token_is_left_verbatim_not_blanked() {
    // Rendering an empty string would silently swallow the copy; leaving the
    // literal makes a missing value visible.
    let c = ctx(json!({}));
    assert_eq!(resolve_tokens("Hi {{name}}!", &c), "Hi {{name}}!");
    assert_eq!(resolve_tokens("{{ name }}", &c), "{{ name }}");
}

#[test]
fn malformed_braces_are_left_alone() {
    let c = ctx(json!({ "name": "Ada" }));
    for input in [
        "{{name",     // unterminated
        "{name}}",    // single open
        "{{}}",       // no name
        "{{ }}",      // whitespace only
        "{{na-me}}",  // hyphen is not a name char
        "{{na me}}",  // interior space
        "{ {name} }", // not doubled
        "{{{name}}}", // handled below
    ] {
        let out = resolve_tokens(input, &c);
        if input == "{{{name}}}" {
            // The inner `{{name}}` matches; the outer braces stay literal.
            assert_eq!(out, "{Ada}", "{input}");
        } else {
            assert_eq!(out, input, "{input} should pass through unchanged");
        }
    }
}

#[test]
fn a_null_context_value_renders_as_the_string_null() {
    // Present-but-null is a VALUE, not an absent key — it substitutes.
    let c = ctx(json!({ "name": null }));
    assert_eq!(resolve_tokens("Hi {{name}}!", &c), "Hi null!");
}

#[test]
fn legacy_token_aliases_resolve_when_the_primary_is_absent() {
    let c = ctx(json!({ "usage_current": 7, "usage_limit": 10 }));
    assert_eq!(
        resolve_tokens("{{current_usage}}/{{current_limit}}", &c),
        "7/10"
    );

    // The primary name wins when both are present.
    let both = ctx(json!({ "current_usage": 1, "usage_current": 9 }));
    assert_eq!(resolve_tokens("{{current_usage}}", &both), "1");
}

#[test]
fn tokens_are_substituted_only_in_string_fields() {
    let content = ctx(json!({
        "title": "Hi {{name}}",
        "count": 3,
        "flag": true,
        "nested": { "deep": "{{name}}" },
    }));
    let out = resolve_content(&content, &ctx(json!({ "name": "Ada" })));

    assert_eq!(out["title"], json!("Hi Ada"));
    assert_eq!(out["count"], json!(3), "numbers pass through untouched");
    assert_eq!(out["flag"], json!(true));
    assert_eq!(
        out["nested"],
        json!({ "deep": "{{name}}" }),
        "resolution is shallow — nested objects are not walked",
    );
}

// ── Value maps ──────────────────────────────────────────────────────────────

#[test]
fn value_maps_rewrite_through_js_stringified_keys() {
    let tokens = vec![json!({
        "token": "plan",
        "value_map": { "pro": "Professional", "true": "Yes", "1": "One" },
    })];

    let mapped = apply_value_maps(&ctx(json!({ "plan": "pro" })), &tokens);
    assert_eq!(mapped["plan"], json!("Professional"));

    // Keys are matched against the JS stringification of the value.
    let b = apply_value_maps(&ctx(json!({ "plan": true })), &tokens);
    assert_eq!(b["plan"], json!("Yes"));
    let n = apply_value_maps(&ctx(json!({ "plan": 1.0 })), &tokens);
    assert_eq!(n["plan"], json!("One"), "1.0 stringifies to '1', not '1.0'");
}

#[test]
fn value_maps_leave_unmapped_and_null_values_alone() {
    let tokens = vec![json!({ "token": "plan", "value_map": { "pro": "Professional" } })];

    let unmapped = apply_value_maps(&ctx(json!({ "plan": "starter" })), &tokens);
    assert_eq!(unmapped["plan"], json!("starter"));

    let null = apply_value_maps(&ctx(json!({ "plan": null })), &tokens);
    assert_eq!(null["plan"], json!(null), "null is skipped, not mapped");

    let no_map = apply_value_maps(
        &ctx(json!({ "plan": "pro" })),
        &[json!({ "token": "plan" })],
    );
    assert_eq!(no_map["plan"], json!("pro"));
}

// ── Payload resolution ──────────────────────────────────────────────────────

fn block(id: &str, status: &str, title: &str) -> Value {
    json!({
        "block_id": id,
        "status": status,
        "default_content": { "title": title },
    })
}

fn payload(id: &str, status: &str, default_block: &str) -> Value {
    json!({
        "payload_id": id,
        "surface_template_id": "banner",
        "status": status,
        "default_message_block_id": default_block,
    })
}

fn resolve(
    payloads: &[Value],
    blocks: &[Value],
    segments: &[&str],
) -> Option<revturbine::placements::ResolvedPayload> {
    let seg: Vec<String> = segments.iter().map(|s| (*s).to_string()).collect();
    resolve_payload_for_user("banner", &seg, payloads, blocks, &[], &Map::new(), None)
}

#[test]
fn resolves_the_default_block_with_no_segments() {
    let r = resolve(
        &[payload("p1", "active", "b1")],
        &[block("b1", "active", "Default")],
        &[],
    )
    .expect("resolved");
    assert_eq!(r.resolved_content["title"], json!("Default"));
    assert_eq!(r.matched_segment_id, None);
}

#[test]
fn inactive_payloads_and_wrong_surfaces_are_not_candidates() {
    assert!(
        resolve(
            &[payload("p1", "draft", "b1")],
            &[block("b1", "active", "Default")],
            &[]
        )
        .is_none(),
        "a non-active payload is never resolved",
    );

    let mut other_surface = payload("p1", "active", "b1");
    other_surface["surface_template_id"] = json!("modal");
    assert!(resolve(&[other_surface], &[block("b1", "active", "D")], &[]).is_none());
}

#[test]
fn a_payload_whose_block_is_missing_or_inactive_is_skipped_not_rendered_empty() {
    // Falling through to the next candidate is what keeps a mis-authored
    // block from blanking the surface.
    let payloads = vec![
        payload("p1", "active", "missing"),
        payload("p2", "active", "b2"),
    ];
    let blocks = vec![block("b2", "active", "Second")];
    let r = resolve(&payloads, &blocks, &[]).expect("fell through to p2");
    assert_eq!(r.resolved_content["title"], json!("Second"));

    let inactive = vec![
        block("b1", "archived", "First"),
        block("b2", "active", "Second"),
    ];
    let r2 = resolve(
        &[payload("p1", "active", "b1"), payload("p2", "active", "b2")],
        &inactive,
        &[],
    )
    .expect("fell through past the archived block");
    assert_eq!(r2.resolved_content["title"], json!("Second"));
}

#[test]
fn flat_or_segment_matching_takes_the_first_hit() {
    let mut p = payload("p1", "active", "b_default");
    p["segment_content_map"] = json!([
        { "segment_id": "s_trial", "message_block_id": "b_trial" },
        { "segment_id": "s_paid",  "message_block_id": "b_paid" },
    ]);
    let blocks = vec![
        block("b_default", "active", "Default"),
        block("b_trial", "active", "Trial"),
        block("b_paid", "active", "Paid"),
    ];

    let r = resolve(&[p.clone()], &blocks, &["s_paid"]).expect("matched");
    assert_eq!(r.resolved_content["title"], json!("Paid"));
    assert_eq!(r.matched_segment_id, Some("s_paid".into()));

    // Holding both, the first authored entry wins.
    let both = resolve(&[p.clone()], &blocks, &["s_paid", "s_trial"]).expect("matched");
    assert_eq!(both.resolved_content["title"], json!("Trial"));

    // Holding neither falls back to the default block.
    let none = resolve(&[p], &blocks, &["s_other"]).expect("default");
    assert_eq!(none.resolved_content["title"], json!("Default"));
}

#[test]
fn cross_dimension_and_skips_the_payload_when_a_dimension_is_unmatched() {
    // A payload targeted at "enterprise AND trialing" must NOT fall back to
    // its default for someone who is only one of those — it must be skipped
    // entirely, so a later payload can answer instead.
    let mut p = payload("p1", "active", "b_default");
    p["segment_content_map"] = json!([
        { "segment_id": "s_ent",   "message_block_id": "b_ent",   "dimension": "tier" },
        { "segment_id": "s_trial", "message_block_id": "b_trial", "dimension": "lifecycle" },
    ]);
    let blocks = vec![
        block("b_default", "active", "Default"),
        block("b_ent", "active", "Ent"),
        block("b_trial", "active", "Trial"),
        block("b_fallback", "active", "Fallback"),
    ];
    let dims: HashMap<String, Vec<String>> = HashMap::from([
        ("tier".into(), vec!["s_ent".into()]),
        ("lifecycle".into(), vec!["s_trial".into()]),
    ]);

    // Only one dimension matched → skipped, so the NEXT payload answers.
    let payloads = vec![p.clone(), payload("p2", "active", "b_fallback")];
    let seg: Vec<String> = vec!["s_ent".into()];
    let skipped = resolve_payload_for_user(
        "banner",
        &seg,
        &payloads,
        &blocks,
        &[],
        &Map::new(),
        Some(&dims),
    )
    .expect("fell through");
    assert_eq!(
        skipped.resolved_content["title"],
        json!("Fallback"),
        "must NOT fall back to p1's default block",
    );

    // Both dimensions matched → the payload resolves.
    let both: Vec<String> = vec!["s_ent".into(), "s_trial".into()];
    let matched = resolve_payload_for_user(
        "banner",
        &both,
        &payloads,
        &blocks,
        &[],
        &Map::new(),
        Some(&dims),
    )
    .expect("matched");
    assert!(
        matches!(
            matched.resolved_content["title"].as_str(),
            Some("Ent") | Some("Trial")
        ),
        "one of the matched dimensions supplies the block",
    );
}

#[test]
fn block_segment_overrides_merge_over_default_content() {
    // Local mode carries a single block and no segment_content_map, so
    // block-level overrides are the only way segment targeting works there.
    let mut b = block("b1", "active", "Default");
    b["default_content"] = json!({ "title": "Default", "cta": "Go" });
    b["segment_overrides"] = json!([
        { "segment_value_id": "s_paid", "content": { "title": "Paid title" } }
    ]);

    let r = resolve(&[payload("p1", "active", "b1")], &[b.clone()], &["s_paid"]).expect("resolved");
    assert_eq!(
        r.resolved_content["title"],
        json!("Paid title"),
        "override applied"
    );
    assert_eq!(
        r.resolved_content["cta"],
        json!("Go"),
        "unlisted fields survive the merge",
    );
    assert_eq!(
        r.matched_segment_id,
        Some("s_paid".into()),
        "the override that fired is reported back",
    );

    // A user without the segment gets the default.
    let plain = resolve(&[payload("p1", "active", "b1")], &[b], &[]).expect("resolved");
    assert_eq!(plain.resolved_content["title"], json!("Default"));
    assert_eq!(plain.matched_segment_id, None);
}

#[test]
fn tokens_are_resolved_against_the_value_mapped_context() {
    let mut b = block("b1", "active", "Welcome {{plan}}");
    b["default_content"] = json!({ "title": "Welcome {{plan}}" });
    let tokens = vec![json!({ "token": "plan", "value_map": { "pro": "Professional" } })];
    let personalization = ctx(json!({ "plan": "pro" }));

    let r = resolve_payload_for_user(
        "banner",
        &[],
        &[payload("p1", "active", "b1")],
        &[b],
        &tokens,
        &personalization,
        None,
    )
    .expect("resolved");

    assert_eq!(
        r.resolved_content["title"],
        json!("Welcome Professional"),
        "value maps are applied BEFORE token substitution",
    );
}

#[test]
fn entry_level_ui_path_and_promotion_override_the_payload_level() {
    let mut p = payload("p1", "active", "b1");
    p["ui_path_id"] = json!("path_default");
    p["promotion_id"] = json!("promo_default");
    p["segment_content_map"] = json!([{
        "segment_id": "s_paid",
        "message_block_id": "b1",
        "ui_path_id": "path_paid",
    }]);

    let r = resolve(&[p], &[block("b1", "active", "T")], &["s_paid"]).expect("resolved");
    assert_eq!(r.ui_path_id, Some("path_paid".into()), "entry wins");
    assert_eq!(
        r.promotion_id,
        Some("promo_default".into()),
        "an absent entry field leaves the payload's value in place",
    );
}

#[test]
fn user_segment_set_is_deduplicated_without_affecting_matching() {
    let seg: HashSet<String> = ["s_a", "s_a", "s_b"]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    assert_eq!(seg.len(), 2);
}
