//! Port-local locks for the selection layer (plan 234 TASK-8c).
//!
//! Mirrors `server-python/tests/placements/test_selection_tier3.py` and the
//! TS staging cases so a refactor cannot silently drop a stage between
//! parity runs. The cross-language lock is `placement_selection_priority`.

use serde_json::{json, Value};

use revturbine::placements::selection::{
    resolve_local_placement_from_candidates, CandidateResolutionOptions,
};

fn candidate(output_id: &str, category: &str, content: Value) -> Value {
    json!({
        "output_id": output_id,
        "category": category,
        "content": content,
        "surface": { "type": "banner" },
    })
}

fn winner_id(candidates: &[Value]) -> String {
    resolve_local_placement_from_candidates(candidates, CandidateResolutionOptions::default())
        .and_then(|w| {
            w.get("output_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .expect("a winner")
}

#[test]
fn stage1_transition_beats_at_limit() {
    let id = winner_id(&[
        candidate("z_at_limit", "usage_limit", json!({ "usage_percent": 100 })),
        candidate(
            "a_transition",
            "trial",
            json!({ "__trigger_kind": "trial_converted" }),
        ),
    ]);
    assert_eq!(id, "a_transition");
}

#[test]
fn stage1_wins_even_when_proximity_disagrees() {
    // trial_progress at 150% is class 3 BY TRIGGER KIND; the at-limit usage
    // candidate at 100% is class 2. A proximity-only comparator picks the
    // wrong winner here.
    let id = winner_id(&[
        candidate(
            "a_progress",
            "trial",
            json!({ "__trigger_kind": "trial_progress", "usage_percent": 150 }),
        ),
        candidate("z_at_limit", "usage_limit", json!({ "usage_percent": 100 })),
    ]);
    assert_eq!(id, "z_at_limit");
}

#[test]
fn stage2_proximity_breaks_class_ties() {
    let id = winner_id(&[
        candidate("a_farther", "usage_limit", json!({ "usage_percent": 61 })),
        candidate("z_nearer", "usage_limit", json!({ "usage_percent": 92 })),
    ]);
    assert_eq!(id, "z_nearer");
}

#[test]
fn retention_ties_conversion_and_score_decides() {
    let id = winner_id(&[
        candidate("a_conversion", "conversion", json!({ "score": 10 })),
        candidate("z_retention", "retention", json!({ "score": 20 })),
    ]);
    assert_eq!(id, "z_retention");
}

#[test]
fn js_coercion_underscore_score_is_nan() {
    // Number("1_000") is NaN in JS -> the candidate falls to score 0.
    let id = winner_id(&[
        candidate("a_underscore", "conversion", json!({ "score": "1_000" })),
        candidate("z_honest", "conversion", json!({ "score": 5 })),
    ]);
    assert_eq!(id, "z_honest");
}

#[test]
fn fixed_only_filters_the_pool() {
    let winner = resolve_local_placement_from_candidates(
        &[
            candidate("a_gated", "gated", json!({})),
            candidate("z_fixed", "fixed", json!({})),
        ],
        CandidateResolutionOptions { fixed_only: true },
    )
    .expect("a winner");
    assert_eq!(
        winner.get("output_id").and_then(Value::as_str),
        Some("z_fixed")
    );
}

#[test]
fn empty_pool_is_none() {
    assert!(resolve_local_placement_from_candidates(
        &[candidate("a_gated", "gated", json!({}))],
        CandidateResolutionOptions { fixed_only: true },
    )
    .is_none());
}
