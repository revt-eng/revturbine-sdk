//! Trial-trigger eligibility and milestone supersession.
//!
//! Gates trial-trigger placements against the PlanProvider's trial state, and
//! resolves which `trial_progress` milestone wins when several share a
//! template bucket.
//!
//! Source: revturbine-scaffold/src/placements/controllers/trial-gating.ts

use serde_json::Value;

/// A trial-specific placement trigger.
///
/// Modelled as an enum rather than the ports' untyped dicts, so the match in
/// [`matches_trial_trigger`] is exhaustive and a new kind cannot be added
/// without the compiler pointing at every site that must handle it.
#[derive(Debug, Clone, PartialEq)]
pub enum TrialTrigger {
    /// Fires at the very start of a trial.
    Started,
    /// Fires once the user passes a progress milestone.
    Progress {
        /// Elapsed-percent milestone this placement waits for.
        progress_percent: f64,
    },
    /// Fires as a time-based trial nears its end.
    Ending {
        /// Days before expiry at which to fire.
        days_before_end: f64,
    },
    /// Fires once the trial has expired.
    Ended,
    /// Fires once the trial has converted.
    Converted,
}

/// A candidate placement, reduced to what supersession needs.
///
/// Source: trial-gating.ts:36-45 (TrialCandidate)
#[derive(Debug, Clone, PartialEq)]
pub struct TrialCandidate {
    /// Rule id, used to report superseded siblings for analytics.
    pub rule_id: Option<String>,
    /// Authored order, the tie-break when two milestones are equal.
    pub entry_order: i64,
    /// The candidate's normalized trigger, if it has one.
    pub trial_trigger: Option<TrialTrigger>,
}

/// The winning milestone plus the siblings it superseded.
#[derive(Debug, Clone, PartialEq)]
pub struct MilestoneOutcome {
    /// Index into the input slice of the winning candidate.
    pub winner_index: usize,
    /// Rule ids of the lower-threshold candidates it beat, for analytics.
    pub superseded_ids: Vec<String>,
}

fn flag(plan: &Value, key: &str) -> bool {
    plan.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn num(plan: &Value, key: &str) -> Option<f64> {
    plan.get(key)
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite())
}

fn state_is(plan: &Value, expected: &str) -> bool {
    plan.get("trial_state").and_then(Value::as_str) == Some(expected)
}

/// Universal elapsed-percent (0–100) read from PlanProvider state.
///
/// `None` when no trial is active, it has expired, or no progress data exists.
///
/// Reads the universal `trial_progress_percent` first — set for **both** trial
/// modes by the trial-status derivation — then falls back to time-based and
/// usage-based math so payloads predating that field still work.
///
/// Source: trial-gating.ts:58-76
#[must_use]
pub fn compute_user_elapsed_percent(plan: Option<&Value>) -> Option<f64> {
    let plan = plan.filter(|p| p.is_object())?;
    if !flag(plan, "trial_active") || state_is(plan, "expired") {
        return None;
    }

    if let Some(pct) = num(plan, "trial_progress_percent").filter(|p| *p >= 0.0) {
        return Some(pct.min(100.0));
    }

    // Time-based fallback. Not clamped, matching the TS.
    if let (Some(total), Some(remaining)) = (
        num(plan, "trial_days_total"),
        num(plan, "trial_days_remaining"),
    ) {
        if total > 0.0 {
            return Some(((total - remaining).max(0.0) / total) * 100.0);
        }
    }

    // Usage-based fallback.
    if let (Some(limit), Some(consumed)) = (
        num(plan, "trial_usage_limit"),
        num(plan, "trial_usage_consumed"),
    ) {
        if limit > 0.0 {
            return Some(((consumed / limit) * 100.0).clamp(0.0, 100.0));
        }
    }

    None
}

/// Whether a trial-triggered placement is eligible right now.
///
/// A non-trial trigger (`None`) passes through. Absent plan state **fails
/// closed** — a trial placement with no trial to reason about must not fire.
///
/// Source: trial-gating.ts:98-130
#[must_use]
pub fn matches_trial_trigger(trigger: Option<&TrialTrigger>, plan: Option<&Value>) -> bool {
    let Some(trigger) = trigger else {
        return true;
    };
    let Some(plan) = plan.filter(|p| p.is_object()) else {
        return false;
    };

    match trigger {
        TrialTrigger::Started => {
            // "Just started" is the first 5% of elapsed progress, not a
            // timestamp comparison — so it works for usage trials too.
            flag(plan, "trial_active")
                && compute_user_elapsed_percent(Some(plan)).is_some_and(|pct| pct <= 5.0)
        }
        TrialTrigger::Progress { .. } => {
            // The milestone itself is applied by supersession; this only asks
            // whether the trial is in a state where progress means anything.
            flag(plan, "trial_active") && !state_is(plan, "expired") && !state_is(plan, "converted")
        }
        TrialTrigger::Ending { days_before_end } => {
            // Meaningless for a usage trial — there are no days to count down.
            if !flag(plan, "trial_active")
                || plan.get("trial_limit_type").and_then(Value::as_str) == Some("usage")
            {
                return false;
            }
            num(plan, "trial_days_remaining").is_some_and(|r| r <= *days_before_end)
        }
        TrialTrigger::Ended => state_is(plan, "expired"),
        TrialTrigger::Converted => state_is(plan, "converted"),
    }
}

fn progress_pct(candidate: &TrialCandidate) -> Option<f64> {
    match candidate.trial_trigger {
        Some(TrialTrigger::Progress { progress_percent }) => Some(progress_percent),
        _ => None,
    }
}

/// Among same-template candidates, pick the **highest milestone the user has
/// crossed** and report the lower-threshold siblings as superseded.
///
/// `None` when no candidate is a `trial_progress` trigger, or when the user has
/// crossed none of them. Pure — records nothing.
///
/// Ties break on the **lower `entry_order`**, so authored order decides and the
/// outcome is deterministic rather than dependent on candidate ordering.
///
/// Source: trial-gating.ts:146-175
#[must_use]
pub fn apply_milestone_supersession(
    candidates: &[TrialCandidate],
    user_elapsed_percent: f64,
) -> Option<MilestoneOutcome> {
    let crossed: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| progress_pct(c).is_some_and(|p| user_elapsed_percent >= p))
        .map(|(i, _)| i)
        .collect();

    let (&first, rest) = crossed.split_first()?;

    let mut winner = first;
    for &i in rest {
        let c_pct = progress_pct(&candidates[i]).unwrap_or(-1.0);
        let w_pct = progress_pct(&candidates[winner]).unwrap_or(-1.0);
        if c_pct > w_pct
            || (c_pct == w_pct && candidates[i].entry_order < candidates[winner].entry_order)
        {
            winner = i;
        }
    }

    let superseded_ids = crossed
        .iter()
        .filter(|&&i| i != winner)
        .filter_map(|&i| candidates[i].rule_id.clone())
        .filter(|id| !id.is_empty())
        .collect();

    Some(MilestoneOutcome {
        winner_index: winner,
        superseded_ids,
    })
}

/// Normalize a Playbook's `type`-keyed `placement.trigger` into a
/// [`TrialTrigger`].
///
/// Non-trial kinds yield `None` — they pass through trial gating untouched. A
/// trial kind missing its required numeric field also yields `None`, so a
/// malformed milestone is ignored rather than defaulting to zero (which would
/// fire immediately).
///
/// Source: trial-gating.ts:215-241
#[must_use]
pub fn normalize_json_trigger(trigger: Option<&Value>) -> Option<TrialTrigger> {
    let t = trigger?;
    match t.get("type").and_then(Value::as_str)? {
        "trial_started" => Some(TrialTrigger::Started),
        "trial_progress" => num(t, "progress_percent")
            .map(|progress_percent| TrialTrigger::Progress { progress_percent }),
        "trial_ending" => num(t, "days_before_end")
            .map(|days_before_end| TrialTrigger::Ending { days_before_end }),
        "trial_ended" => Some(TrialTrigger::Ended),
        "trial_converted" => Some(TrialTrigger::Converted),
        _ => None,
    }
}
