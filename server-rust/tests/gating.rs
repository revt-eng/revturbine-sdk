//! The four placement gates.
//!
//! Mirrors `server-python/tests/placements/test_{entitlement_gate,qualifier,
//! threshold}_gating.py` and the trial-gating cases. The recurring theme is
//! *which* indeterminate states fail closed and which pass through — that
//! asymmetry is deliberate and easy to flatten in a port.

use std::collections::HashMap;

use serde_json::{json, Value};

use revturbine::placements::{
    apply_milestone_supersession, compute_consumed_percent, compute_user_elapsed_percent,
    is_qualifier_valid_for_category, matches_entitlement_gate_trigger, matches_qualifier_trigger,
    matches_threshold_trigger, matches_trial_trigger, normalize_json_trigger,
    EntitlementGateTrigger, QualifierTrigger, ThresholdTrigger, TrialCandidate, TrialTrigger,
};

// ── Entitlement-gate (tier) ─────────────────────────────────────────────────

fn ladders() -> HashMap<String, Vec<String>> {
    HashMap::from([(
        "seats".to_string(),
        vec![
            "free".to_string(),
            "pro".to_string(),
            "enterprise".to_string(),
        ],
    )])
}

fn gate(threshold: Option<&str>) -> EntitlementGateTrigger {
    EntitlementGateTrigger {
        entitlement_handle: "seats".into(),
        tier_threshold: threshold.map(str::to_string),
    }
}

fn tiers(current: &str) -> Value {
    json!({ "tiers": { "seats": current } })
}

#[test]
fn a_gate_fires_only_for_tiers_strictly_below_the_threshold() {
    let l = ladders();
    let g = gate(Some("enterprise"));

    for below in ["free", "pro"] {
        assert!(
            matches_entitlement_gate_trigger(Some(&g), &l, Some(&tiers(below))),
            "{below} ranks below enterprise, so the gate should fire",
        );
    }
    assert!(
        !matches_entitlement_gate_trigger(Some(&g), &l, Some(&tiers("enterprise"))),
        "at the threshold is NOT below it",
    );
}

#[test]
fn non_gate_and_untiered_triggers_pass_through() {
    let l = ladders();
    assert!(matches_entitlement_gate_trigger(None, &l, None));
    assert!(
        matches_entitlement_gate_trigger(Some(&gate(None)), &l, None),
        "a gate with no tier boundary is governed by entitlement status",
    );
}

#[test]
fn an_undecidable_ordering_fails_closed() {
    // Plan 138 Q-4. Without a defensible ordering the gate must not fire —
    // otherwise it shows an upgrade prompt derived from a comparison that
    // could not actually be made.
    let l = ladders();

    let unknown_entitlement = EntitlementGateTrigger {
        entitlement_handle: "not_on_file".into(),
        tier_threshold: Some("pro".into()),
    };
    assert!(!matches_entitlement_gate_trigger(
        Some(&unknown_entitlement),
        &l,
        Some(&tiers("free"))
    ));

    assert!(
        !matches_entitlement_gate_trigger(Some(&gate(Some("platinum"))), &l, Some(&tiers("free"))),
        "a threshold that is not on the ladder has no rank",
    );
}

#[test]
fn an_unknown_current_tier_ranks_below_everything_and_fires() {
    // Deliberately NOT symmetric with the fail-closed cases above: here the
    // ordering IS well-defined and the honest answer is "below".
    let l = ladders();
    let g = gate(Some("pro"));

    assert!(
        matches_entitlement_gate_trigger(Some(&g), &l, None),
        "no state"
    );
    assert!(matches_entitlement_gate_trigger(
        Some(&g),
        &l,
        Some(&json!({ "tiers": {} }))
    ));
    assert!(
        matches_entitlement_gate_trigger(Some(&g), &l, Some(&tiers("mystery"))),
        "a tier not on the ladder is below every threshold",
    );
}

// ── Qualifier ───────────────────────────────────────────────────────────────

fn qual(q: &str) -> QualifierTrigger {
    QualifierTrigger {
        qualifier: q.into(),
    }
}

#[test]
fn a_cross_category_qualifier_never_matches() {
    assert!(is_qualifier_valid_for_category(
        "payment_failed",
        "retention"
    ));
    assert!(!is_qualifier_valid_for_category(
        "payment_failed",
        "other_conversion"
    ));

    let plan = json!({ "payment_failed": true });
    assert!(
        !matches_qualifier_trigger(
            Some(&qual("payment_failed")),
            "other_conversion",
            Some(&plan)
        ),
        "even with the signal set, the wrong category must not match",
    );
    assert!(
        !matches_qualifier_trigger(Some(&qual("none_always_on")), "retention", None),
        "a category that does not offer the qualifier rejects it",
    );
}

#[test]
fn payment_qualifiers_fail_closed_on_absent_state() {
    // A payment-recovery prompt shown to someone whose billing state is merely
    // unknown is worse than not showing it.
    for q in ["payment_failed", "payment_at_risk"] {
        assert!(
            !matches_qualifier_trigger(Some(&qual(q)), "retention", None),
            "{q} must not fire with no plan state",
        );
        assert!(
            !matches_qualifier_trigger(Some(&qual(q)), "retention", Some(&json!({}))),
            "{q} must not fire on an absent flag",
        );
        assert!(
            matches_qualifier_trigger(Some(&qual(q)), "retention", Some(&json!({ q: true }))),
            "{q} fires on an explicit true",
        );
        assert!(
            !matches_qualifier_trigger(Some(&qual(q)), "retention", Some(&json!({ q: false }))),
            "{q} must not fire on false",
        );
    }
}

#[test]
fn not_yet_evaluable_qualifiers_pass_through_rather_than_fail_closed() {
    // The opposite choice from the payment ones, on purpose: these gate
    // ordinary conversion surfaces, and failing closed would silently disable
    // every placement using them.
    for q in ["overage_vs_upgrade", "time_bound"] {
        assert!(
            matches_qualifier_trigger(Some(&qual(q)), "other_conversion", None),
            "{q} is not yet determinable and should pass through",
        );
    }
    assert!(matches_qualifier_trigger(
        Some(&qual("none_always_on")),
        "other_conversion",
        None
    ));
    assert!(matches_qualifier_trigger(None, "other_conversion", None));
}

// ── Threshold ───────────────────────────────────────────────────────────────

fn threshold(kind: &str, pct: f64) -> ThresholdTrigger {
    ThresholdTrigger {
        kind: kind.into(),
        entitlement_handle: "exports".into(),
        threshold_percent: pct,
    }
}

#[test]
fn usage_threshold_fires_at_or_above_the_configured_percent() {
    let t = threshold("usage_threshold", 80.0);
    let at_79 = json!({ "usage": { "exports": { "used": 79, "limit": 100 } } });
    let at_80 = json!({ "usage": { "exports": { "used": 80, "limit": 100 } } });

    assert!(!matches_threshold_trigger(Some(&t), Some(&at_79)));
    assert!(
        matches_threshold_trigger(Some(&t), Some(&at_80)),
        "at the threshold fires — the comparison is >=",
    );
}

#[test]
fn consumed_percent_is_not_clamped_so_exceeded_is_visible() {
    let t = threshold("usage_threshold", 80.0);
    let over = json!({ "usage": { "exports": { "used": 150, "limit": 100 } } });
    assert_eq!(compute_consumed_percent(&t, Some(&over)), Some(150.0));
}

#[test]
fn credits_report_remaining_so_consumption_is_the_complement() {
    // The classic inversion bug: a credit balance of 10/100 is 90% CONSUMED,
    // not 10%.
    let t = threshold("credit_threshold", 80.0);
    let state = json!({ "usage": { "exports": { "limit": 100, "remaining": 10 } } });

    assert_eq!(compute_consumed_percent(&t, Some(&state)), Some(90.0));
    assert!(matches_threshold_trigger(Some(&t), Some(&state)));
}

#[test]
fn a_usage_trigger_ignores_remaining_and_reads_used() {
    // Only credit_threshold inverts; the same state under a usage trigger must
    // read `used`.
    let t = threshold("usage_threshold", 80.0);
    let state = json!({ "usage": { "exports": { "used": 5, "limit": 100, "remaining": 10 } } });
    assert_eq!(compute_consumed_percent(&t, Some(&state)), Some(5.0));
}

#[test]
fn indeterminate_consumption_fails_closed() {
    let t = threshold("usage_threshold", 80.0);
    for state in [
        json!({}),
        json!({ "usage": {} }),
        json!({ "usage": { "exports": { "used": 5 } } }), // no limit
        json!({ "usage": { "exports": { "used": 5, "limit": 0 } } }), // non-positive
    ] {
        assert_eq!(compute_consumed_percent(&t, Some(&state)), None, "{state}");
        assert!(
            !matches_threshold_trigger(Some(&t), Some(&state)),
            "{state}"
        );
    }
    assert!(!matches_threshold_trigger(Some(&t), None));
    assert!(
        matches_threshold_trigger(None, None),
        "non-threshold passes through"
    );
}

#[test]
fn allocation_redirects_which_grant_supplies_the_counters() {
    // A per-user grant that declares account pooling must be measured against
    // the ACCOUNT counters, not its own.
    let t = threshold("usage_threshold", 50.0);
    let state = json!({
        "grants": {
            "user":    { "exports": { "allocation": "account_pool", "used": 1, "limit": 100 } },
            "account": { "exports": { "used": 90, "limit": 100 } },
        }
    });
    assert_eq!(
        compute_consumed_percent(&t, Some(&state)),
        Some(90.0),
        "pooled allocation reads the account grant",
    );
}

#[test]
fn a_grant_with_a_limit_wins_over_the_flat_usage_map() {
    let t = threshold("usage_threshold", 50.0);
    let state = json!({
        "grants": { "user": { "exports": { "used": 90, "limit": 100 } } },
        "usage":  { "exports": { "used": 1, "limit": 100 } },
    });
    assert_eq!(compute_consumed_percent(&t, Some(&state)), Some(90.0));
}

// ── Trial ───────────────────────────────────────────────────────────────────

fn trial_plan(extra: Value) -> Value {
    let mut p = json!({ "trial_active": true, "trial_state": "active" });
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            p[k] = v.clone();
        }
    }
    p
}

#[test]
fn elapsed_percent_prefers_the_universal_field_then_falls_back() {
    assert_eq!(
        compute_user_elapsed_percent(Some(&trial_plan(json!({ "trial_progress_percent": 42 })))),
        Some(42.0),
    );
    // Time-based fallback for payloads predating the universal field.
    assert_eq!(
        compute_user_elapsed_percent(Some(&trial_plan(
            json!({ "trial_days_total": 10, "trial_days_remaining": 3 })
        ))),
        Some(70.0),
    );
    // Usage-based fallback.
    assert_eq!(
        compute_user_elapsed_percent(Some(&trial_plan(
            json!({ "trial_usage_limit": 20, "trial_usage_consumed": 5 })
        ))),
        Some(25.0),
    );
}

#[test]
fn elapsed_percent_is_none_without_an_active_unexpired_trial() {
    assert_eq!(compute_user_elapsed_percent(None), None);
    assert_eq!(
        compute_user_elapsed_percent(Some(&json!({ "trial_active": false }))),
        None
    );
    assert_eq!(
        compute_user_elapsed_percent(Some(&trial_plan(
            json!({ "trial_state": "expired", "trial_progress_percent": 50 })
        ))),
        None,
    );
    assert_eq!(
        compute_user_elapsed_percent(Some(&trial_plan(json!({})))),
        None,
        "active but no progress data at all",
    );
}

#[test]
fn trial_started_is_the_first_five_percent_not_a_timestamp() {
    // Defined on elapsed percent so it works for usage trials too.
    let early = trial_plan(json!({ "trial_progress_percent": 5 }));
    let later = trial_plan(json!({ "trial_progress_percent": 6 }));
    assert!(matches_trial_trigger(
        Some(&TrialTrigger::Started),
        Some(&early)
    ));
    assert!(!matches_trial_trigger(
        Some(&TrialTrigger::Started),
        Some(&later)
    ));
}

#[test]
fn trial_ending_is_meaningless_for_a_usage_trial() {
    let t = TrialTrigger::Ending {
        days_before_end: 3.0,
    };
    let time_based = trial_plan(json!({ "trial_days_remaining": 2 }));
    assert!(matches_trial_trigger(Some(&t), Some(&time_based)));

    let usage_based = trial_plan(json!({ "trial_limit_type": "usage", "trial_days_remaining": 2 }));
    assert!(
        !matches_trial_trigger(Some(&t), Some(&usage_based)),
        "a usage trial has no days to count down",
    );
}

#[test]
fn ended_and_converted_read_the_state_not_the_active_flag() {
    let ended = json!({ "trial_active": false, "trial_state": "expired" });
    assert!(matches_trial_trigger(
        Some(&TrialTrigger::Ended),
        Some(&ended)
    ));
    assert!(!matches_trial_trigger(
        Some(&TrialTrigger::Converted),
        Some(&ended)
    ));

    let converted = json!({ "trial_active": false, "trial_state": "converted" });
    assert!(matches_trial_trigger(
        Some(&TrialTrigger::Converted),
        Some(&converted)
    ));
}

#[test]
fn trial_triggers_fail_closed_with_no_plan_state() {
    assert!(!matches_trial_trigger(Some(&TrialTrigger::Ended), None));
    assert!(
        matches_trial_trigger(None, None),
        "non-trial passes through"
    );
}

#[test]
fn supersession_picks_the_highest_crossed_milestone() {
    let candidates = vec![
        candidate("r25", 0, 25.0),
        candidate("r50", 1, 50.0),
        candidate("r75", 2, 75.0),
    ];

    let out = apply_milestone_supersession(&candidates, 60.0).expect("crossed two");
    assert_eq!(out.winner_index, 1, "50 is the highest crossed at 60%");
    assert_eq!(out.superseded_ids, vec!["r25"], "75 was not crossed");
}

#[test]
fn supersession_breaks_ties_on_authored_order() {
    // Determinism: the outcome must not depend on candidate ordering.
    let candidates = vec![candidate("later", 5, 50.0), candidate("earlier", 1, 50.0)];
    let out = apply_milestone_supersession(&candidates, 60.0).unwrap();
    assert_eq!(out.winner_index, 1, "lower entry_order wins the tie");
    assert_eq!(out.superseded_ids, vec!["later"]);
}

#[test]
fn supersession_is_none_when_nothing_qualifies() {
    let candidates = vec![candidate("r75", 0, 75.0)];
    assert!(
        apply_milestone_supersession(&candidates, 10.0).is_none(),
        "no milestone crossed",
    );

    let non_progress = vec![TrialCandidate {
        rule_id: Some("r".into()),
        entry_order: 0,
        trial_trigger: Some(TrialTrigger::Ended),
    }];
    assert!(apply_milestone_supersession(&non_progress, 100.0).is_none());
    assert!(apply_milestone_supersession(&[], 50.0).is_none());
}

fn candidate(id: &str, order: i64, pct: f64) -> TrialCandidate {
    TrialCandidate {
        rule_id: Some(id.into()),
        entry_order: order,
        trial_trigger: Some(TrialTrigger::Progress {
            progress_percent: pct,
        }),
    }
}

#[test]
fn normalizing_a_trigger_rejects_a_malformed_milestone() {
    assert_eq!(
        normalize_json_trigger(Some(
            &json!({ "type": "trial_progress", "progress_percent": 50 })
        )),
        Some(TrialTrigger::Progress {
            progress_percent: 50.0
        }),
    );
    assert_eq!(
        normalize_json_trigger(Some(&json!({ "type": "trial_started" }))),
        Some(TrialTrigger::Started),
    );
    assert_eq!(
        normalize_json_trigger(Some(&json!({ "type": "trial_progress" }))),
        None,
        "a milestone with no percent must be ignored, not default to 0 and fire immediately",
    );
    assert_eq!(
        normalize_json_trigger(Some(&json!({ "type": "usage_threshold" }))),
        None,
        "non-trial kinds pass through trial gating untouched",
    );
    assert_eq!(normalize_json_trigger(None), None);
}
