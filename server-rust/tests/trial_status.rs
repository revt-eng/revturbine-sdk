//! Trial-status derivation.
//!
//! Mirrors `server-python/tests/trials/test_trial_status.py`. Everything here
//! is pure — the instant is an argument, so no clock is involved.

use serde_json::{json, Value};

use revturbine::trials::{
    derive_local_trial_status_from_instance, derive_reverse_trial_grants, evaluate_trial_status,
    find_active_trial_instance, find_latest_started_trial_instance,
};

const DAY1: &str = "2026-01-01T00:00:00.000Z";
const DAY8: &str = "2026-01-08T00:00:00.000Z";

/// A 7-day time-based free trial started on DAY1.
fn time_instance(status: &str) -> Value {
    json!({
        "status": status,
        "rule_type": "free_trial",
        "trial_limit_type": "time",
        "started_at": DAY1,
        "expires_at": DAY8,
        "rule_id": "rule_1",
    })
}

fn at(iso: &str, instance: &Value) -> Option<revturbine::trials::UserTrialStatus> {
    derive_local_trial_status_from_instance(instance, None, iso, None, None)
}

// ── Time-based derivation ───────────────────────────────────────────────────

#[test]
fn day_and_remaining_counts_track_the_window() {
    let inst = time_instance("active");

    let d1 = at(DAY1, &inst).expect("day 1");
    assert_eq!(d1.day_number, Some(0), "the first day is day 0");
    assert_eq!(d1.days_remaining, Some(7));
    assert_eq!(d1.progress_percent, 0.0);
    assert!(d1.in_trial);
    assert_eq!(d1.state, "active");

    let d4 = at("2026-01-04T00:00:00.000Z", &inst).expect("day 4");
    assert_eq!(d4.day_number, Some(3));
    assert_eq!(d4.days_remaining, Some(4));
}

#[test]
fn state_becomes_running_out_at_the_seventy_five_percent_mark() {
    let inst = time_instance("active");

    // Day 5 of 7 ≈ 71.4% — still 'active'.
    let before = at("2026-01-06T00:00:00.000Z", &inst).expect("day 5");
    assert!(before.progress_percent < 75.0);
    assert_eq!(before.state, "active");

    // Day 6 of 7 ≈ 85.7% — 'running_out'.
    let after = at("2026-01-07T00:00:00.000Z", &inst).expect("day 6");
    assert!(after.progress_percent >= 75.0);
    assert_eq!(after.state, "running_out");
    assert!(after.in_trial, "running out is still in-trial");
}

#[test]
fn lazy_expiry_reports_a_bounds_crossed_active_row_as_expired() {
    // The persisted row still says 'active'; nothing has rewritten it. The
    // derivation must not take that at face value, or an elapsed trial keeps
    // granting entitlements until some job catches up.
    let inst = time_instance("active");
    let expired = at("2026-01-09T00:00:00.000Z", &inst).expect("past expiry");

    assert_eq!(expired.state, "expired");
    assert!(
        !expired.in_trial,
        "an elapsed trial must not read as in-trial"
    );
    assert_eq!(expired.days_remaining, Some(0));
    assert_eq!(expired.progress_percent, 100.0);
}

#[test]
fn the_expiry_instant_itself_is_expired() {
    // `now >= expires_at`, so the boundary is over, not still running.
    let inst = time_instance("active");
    let boundary = at(DAY8, &inst).expect("exactly at expiry");
    assert_eq!(boundary.state, "expired");
    assert!(!boundary.in_trial);
}

#[test]
fn converted_and_cancelled_survive_lazy_expiry_differently() {
    // 'converted' is preserved as its own state; 'cancelled' has no runtime
    // vocabulary and collapses to 'expired'.
    let converted = at("2026-01-09T00:00:00.000Z", &time_instance("converted")).unwrap();
    assert_eq!(converted.state, "converted");
    assert!(!converted.in_trial);

    let cancelled = at("2026-01-04T00:00:00.000Z", &time_instance("cancelled")).unwrap();
    assert_eq!(cancelled.state, "expired");
}

// ── Nothing-to-describe cases ───────────────────────────────────────────────

#[test]
fn returns_none_when_the_trial_cannot_be_described() {
    // Inventing a status for a malformed row would let it grant entitlements.
    assert!(
        at(DAY1, &time_instance("not_started")).is_none(),
        "not_started"
    );

    let future = json!({
        "status": "active", "rule_type": "free_trial", "trial_limit_type": "time",
        "started_at": DAY8, "expires_at": "2026-01-15T00:00:00.000Z",
    });
    assert!(at(DAY1, &future).is_none(), "starts in the future");

    let no_expiry = json!({
        "status": "active", "rule_type": "free_trial", "trial_limit_type": "time",
        "started_at": DAY1,
    });
    assert!(at(DAY8, &no_expiry).is_none(), "time trial with no bound");

    let unparseable = json!({
        "status": "active", "rule_type": "free_trial", "trial_limit_type": "time",
        "started_at": "not-a-date", "expires_at": DAY8,
    });
    assert!(at(DAY8, &unparseable).is_none(), "unparseable start");
}

// ── Usage-based derivation ──────────────────────────────────────────────────

fn usage_instance() -> Value {
    json!({
        "status": "active",
        "rule_type": "free_trial",
        "trial_limit_type": "usage",
        "started_at": DAY1,
        "usage_entitlement_handle": "exports",
        "usage_limit_value": 10,
    })
}

#[test]
fn usage_trials_track_consumption_not_time() {
    let inst = usage_instance();
    let balances = json!({ "exports": 3 });
    let s = derive_local_trial_status_from_instance(&inst, None, DAY8, None, Some(&balances))
        .expect("usage trial");

    assert_eq!(s.trial_limit_type, "usage");
    assert_eq!(s.usage_consumed, Some(3.0));
    assert_eq!(s.usage_remaining, Some(7.0));
    assert_eq!(s.usage_limit, Some(10.0));
    assert_eq!(s.progress_percent, 30.0);
    assert_eq!(s.usage_entitlement_handle, Some("exports".into()));
    // No time fields on a usage trial — they must be absent, not zero.
    assert_eq!(s.day_number, None);
    assert_eq!(s.days_remaining, None);
    assert!(s.in_trial);
}

#[test]
fn a_usage_trial_expires_when_the_allowance_is_consumed() {
    let balances = json!({ "exports": 10 });
    let s = derive_local_trial_status_from_instance(
        &usage_instance(),
        None,
        DAY8,
        None,
        Some(&balances),
    )
    .expect("usage trial");
    assert_eq!(s.state, "expired");
    assert!(!s.in_trial);
    assert_eq!(s.usage_remaining, Some(0.0));
}

#[test]
fn a_usage_trial_missing_its_bounds_is_malformed_not_unlimited() {
    let mut inst = usage_instance();
    inst["usage_limit_value"] = json!(0);
    assert!(
        derive_local_trial_status_from_instance(&inst, None, DAY8, None, None).is_none(),
        "a zero limit is malformed — treating it as unlimited would grant everything",
    );

    let mut no_handle = usage_instance();
    no_handle["usage_entitlement_handle"] = Value::Null;
    assert!(derive_local_trial_status_from_instance(&no_handle, None, DAY8, None, None).is_none());
}

#[test]
fn the_rule_supplies_usage_bounds_the_instance_omits() {
    let mut inst = usage_instance();
    inst.as_object_mut().unwrap().remove("usage_limit_value");
    let rule = json!({ "id": "rule_1", "usage_limit_value": 20 });
    let balances = json!({ "exports": 5 });

    let s =
        derive_local_trial_status_from_instance(&inst, Some(&rule), DAY8, None, Some(&balances))
            .expect("bounds from the rule");
    assert_eq!(s.usage_limit, Some(20.0));
    assert_eq!(s.progress_percent, 25.0);
}

// ── Plan handle + trial type ────────────────────────────────────────────────

#[test]
fn a_reverse_trial_reports_the_base_plan_a_free_trial_the_rule_plan() {
    let mut reverse = time_instance("active");
    reverse["rule_type"] = json!("reverse_trial");
    let r = derive_local_trial_status_from_instance(&reverse, None, DAY1, Some("starter"), None)
        .unwrap();
    assert_eq!(r.trial_type, "reverse");
    assert_eq!(r.plan_handle, Some("starter".into()));

    let rule = json!({ "id": "rule_1", "plan_id": "pro" });
    let f = derive_local_trial_status_from_instance(
        &time_instance("active"),
        Some(&rule),
        DAY1,
        None,
        None,
    )
    .unwrap();
    assert_eq!(f.trial_type, "free");
    assert_eq!(f.plan_handle, Some("pro".into()));
}

// ── Instance selection ──────────────────────────────────────────────────────

#[test]
fn find_active_skips_expired_but_find_latest_started_keeps_it() {
    // The distinction exists so `trial_ended` / `trial_converted` placements
    // can still fire after the trial is over.
    let instances = vec![time_instance("expired")];

    assert!(
        find_active_trial_instance(&instances, DAY8, None).is_none(),
        "find_active must skip an expired row",
    );
    assert!(
        find_latest_started_trial_instance(&instances, DAY8).is_some(),
        "find_latest_started must KEEP it so trial_ended can fire",
    );
}

#[test]
fn selection_prefers_the_latest_started_instance() {
    let mut older = time_instance("active");
    older["rule_id"] = json!("older");
    let mut newer = time_instance("active");
    newer["started_at"] = json!("2026-01-03T00:00:00.000Z");
    newer["expires_at"] = json!("2026-01-10T00:00:00.000Z");
    newer["rule_id"] = json!("newer");

    let instances = vec![older, newer];
    let picked = find_active_trial_instance(&instances, "2026-01-04T00:00:00.000Z", None)
        .expect("one active");
    assert_eq!(picked.get("rule_id").unwrap(), "newer");
}

#[test]
fn find_active_applies_lazy_expiry_before_deciding() {
    // A row still persisted as 'active' but past its bounds must be excluded.
    let instances = vec![time_instance("active")];
    assert!(find_active_trial_instance(&instances, "2026-01-04T00:00:00.000Z", None).is_some());
    assert!(
        find_active_trial_instance(&instances, "2026-01-09T00:00:00.000Z", None).is_none(),
        "bounds-crossed rows are not active, whatever the row says",
    );
}

#[test]
fn not_started_and_future_rows_are_never_selected() {
    let not_started = vec![time_instance("not_started")];
    assert!(find_latest_started_trial_instance(&not_started, DAY8).is_none());

    let mut future = time_instance("active");
    future["started_at"] = json!("2026-06-01T00:00:00.000Z");
    assert!(find_latest_started_trial_instance(&[future], DAY1).is_none());
}

// ── Reverse-trial grants ────────────────────────────────────────────────────

#[test]
fn reverse_grants_require_a_matching_rule_and_non_empty_entitlements() {
    let mut inst = time_instance("active");
    inst["rule_type"] = json!("reverse_trial");
    inst["rule_id"] = json!("rev_1");

    let rule = json!({
        "id": "rev_1",
        "entitlements_during_trial": ["exports", "seats"],
        "premium_plan_id": "pro",
    });
    let g = derive_reverse_trial_grants(&inst, &rule).expect("grants");
    assert_eq!(
        g.trial_granted_entitlement_handles,
        vec!["exports", "seats"]
    );
    assert_eq!(g.effective_plan_handle, Some("pro".into()));

    // A rule the instance does not reference must not grant anything.
    let other = json!({ "id": "rev_2", "entitlements_during_trial": ["exports"] });
    assert!(derive_reverse_trial_grants(&inst, &other).is_none());

    // Empty entitlements grant nothing.
    let empty = json!({ "id": "rev_1", "entitlements_during_trial": [] });
    assert!(derive_reverse_trial_grants(&inst, &empty).is_none());

    // A free trial never yields reverse grants.
    let free = time_instance("active");
    assert!(derive_reverse_trial_grants(&free, &rule).is_none());
}

// ── Config-driven evaluation ────────────────────────────────────────────────

#[test]
fn evaluate_resolves_the_rule_from_the_playbook_arrays() {
    let instances = vec![time_instance("active")];
    let free_rules = vec![json!({ "id": "rule_1", "plan_id": "pro" })];

    let e = evaluate_trial_status(&instances, DAY1, Some(&free_rules), None, None, None);
    let trial = e.trial.expect("a trial applies");
    assert_eq!(trial.plan_handle, Some("pro".into()), "rule resolved by id");
    assert!(e.reverse_grants.is_none(), "a free trial has no grants");
}

#[test]
fn evaluate_returns_empty_when_no_instance_applies() {
    let e = evaluate_trial_status(&[], DAY1, None, None, None, None);
    assert!(e.trial.is_none());
    assert!(e.reverse_grants.is_none());
}

#[test]
fn evaluate_produces_grants_for_a_reverse_trial() {
    let mut inst = time_instance("active");
    inst["rule_type"] = json!("reverse_trial");
    inst["rule_id"] = json!("rev_1");
    let reverse_rules = vec![json!({
        "id": "rev_1",
        "entitlements_during_trial": ["exports"],
        "premium_plan_id": "pro",
    })];

    let e = evaluate_trial_status(
        &[inst],
        DAY1,
        None,
        Some(&reverse_rules),
        None,
        Some("starter"),
    );
    assert_eq!(e.trial.expect("trial").trial_type, "reverse");
    let g = e.reverse_grants.expect("grants");
    assert_eq!(g.trial_granted_entitlement_handles, vec!["exports"]);
}

#[test]
fn optional_fields_are_omitted_from_json_not_nulled() {
    // The TS emits `undefined` for these; the parity contract treats an absent
    // key and an explicit null as different output.
    let s = at(DAY1, &time_instance("active")).unwrap();
    let json = serde_json::to_value(&s).unwrap();
    let obj = json.as_object().unwrap();

    assert!(
        !obj.contains_key("usage_consumed"),
        "usage fields absent on a time trial"
    );
    assert!(!obj.contains_key("usage_limit"));
    assert!(
        !obj.contains_key("plan_handle"),
        "no rule supplied → no plan_handle"
    );
    assert!(obj.contains_key("day_number"), "time fields present");
}
