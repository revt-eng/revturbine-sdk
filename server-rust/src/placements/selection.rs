//! Rust port of the candidate-selection layer (plan 234 TASK-8c):
//! `resolveLocalPlacementFromCandidates` + the scoring helpers it composes
//! (placement-decision.ts, core/helpers.ts).
//!
//! Until this landed, Rust's `static_resolver` selected by entry order and
//! the TS/Python selection pipeline — milestone supersession, category
//! conflict suppression, the multi-key comparator with the plan-53
//! two-stage tier-3 urgency — had no third side, which is why TASK-15's
//! competing-categories fixture had to be deferred.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::segments::js_number;

/// JS `Number(value)`-flavoured numeric read: finite numbers pass, strings
/// parse with JS semantics, everything else is `None`.
///
/// Source: helpers.ts (parseNumberish)
#[must_use]
pub fn parse_numberish(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()),
        Some(Value::String(s)) => {
            let parsed = js_number(s);
            parsed.is_finite().then_some(parsed)
        }
        _ => None,
    }
}

fn content_of(output: &Value) -> Option<&Value> {
    output.get("content").filter(|c| c.is_object())
}

fn first_numberish(candidates: &[Option<&Value>]) -> Option<f64> {
    candidates.iter().find_map(|v| parse_numberish(*v))
}

/// Map a placement category string to its priority bucket (plan 53 map).
///
/// Source: helpers.ts (categoryBucket)
#[must_use]
pub fn category_bucket(category: &str) -> i64 {
    let normalized = category.trim().to_lowercase();
    if normalized.is_empty() {
        return 99;
    }
    if normalized.contains("gated") || normalized.contains("entitlement") {
        return 0;
    }
    if normalized.contains("fixed") {
        return 1;
    }
    if ["usage", "credit", "seat", "quota"]
        .iter()
        .any(|t| normalized.contains(t))
    {
        return 2;
    }
    if normalized.contains("trial") {
        return 2;
    }
    if ["conversion", "expansion", "upsell"]
        .iter()
        .any(|t| normalized.contains(t))
    {
        return 4;
    }
    if ["retention", "winback", "churn"]
        .iter()
        .any(|t| normalized.contains(t))
    {
        return 4;
    }
    99
}

const TIER3_CLASS_1: [&str; 3] = ["trial_started", "trial_ended", "trial_converted"];
const TIER3_CLASS_3: [&str; 2] = ["trial_progress", "trial_ending"];

/// Within-tier urgency class for tier-3 candidates (plan 53, spec §3.2).
///
/// Source: helpers.ts (tier3Class)
#[must_use]
pub fn tier3_class(output: &Value) -> i64 {
    let content = content_of(output);
    let trigger_kind = content
        .and_then(|c| c.get("__trigger_kind"))
        .and_then(Value::as_str);
    if let Some(kind) = trigger_kind {
        if TIER3_CLASS_1.contains(&kind) {
            return 1;
        }
        if TIER3_CLASS_3.contains(&kind) {
            return 3;
        }
    }
    let basis = first_numberish(&[
        content.and_then(|c| c.get("usage_percent")),
        content.and_then(|c| c.get("threshold_percent")),
    ]);
    if basis.is_some_and(|b| b >= 100.0) {
        return 2;
    }
    3
}

/// Source: helpers.ts (placementScore)
#[must_use]
pub fn placement_score(output: &Value) -> f64 {
    let content = content_of(output);
    first_numberish(&[
        output.get("score"),
        output.get("ltv_propensity_score"),
        content.and_then(|c| c.get("score")),
        content.and_then(|c| c.get("ltv_propensity_score")),
        content.and_then(|c| c.get("ranking_score")),
    ])
    .unwrap_or(0.0)
}

/// Source: helpers.ts (placementPriority)
#[must_use]
pub fn placement_priority(output: &Value) -> f64 {
    let content = content_of(output);
    first_numberish(&[
        output.get("priority"),
        output.get("placement_priority"),
        content.and_then(|c| c.get("priority")),
        content.and_then(|c| c.get("placement_priority")),
    ])
    .unwrap_or(0.0)
}

/// Source: helpers.ts (proximityScore)
#[must_use]
pub fn proximity_score(output: &Value) -> f64 {
    let content = content_of(output);
    first_numberish(&[
        content.and_then(|c| c.get("usage_percent")),
        content.and_then(|c| c.get("trial_percent_elapsed")),
        content.and_then(|c| c.get("threshold_percent")),
    ])
    .unwrap_or_else(|| placement_score(output))
}

/// Source: helpers.ts (serverOrder)
#[must_use]
pub fn server_order(output: &Value) -> Option<f64> {
    let content = content_of(output);
    first_numberish(&[
        output.get("server_order"),
        output.get("order"),
        output.get("rank"),
        output.get("order_index"),
        content.and_then(|c| c.get("server_order")),
        content.and_then(|c| c.get("order")),
        content.and_then(|c| c.get("rank")),
        content.and_then(|c| c.get("order_index")),
    ])
}

fn stringify_number(n: f64) -> String {
    if n.fract() == 0.0 && n.is_finite() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Source: helpers.ts (milestoneVersion)
#[must_use]
pub fn milestone_version(output: &Value) -> Option<String> {
    let content = content_of(output);
    for key in ["template_version", "milestone_version"] {
        let raw = content.and_then(|c| c.get(key));
        if let Some(s) = raw.and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Some(n) = parse_numberish(raw) {
            return Some(stringify_number(n));
        }
    }
    None
}

/// Source: helpers.ts (supersededVersions)
#[must_use]
pub fn superseded_versions(output: &Value) -> Vec<String> {
    let raw = content_of(output).and_then(|c| c.get("supersedes_template_version"));
    match raw {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                if let Some(s) = item.as_str() {
                    let trimmed = s.trim();
                    (!trimmed.is_empty()).then(|| trimmed.to_string())
                } else {
                    parse_numberish(Some(item)).map(stringify_number)
                }
            })
            .collect(),
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                vec![]
            } else {
                vec![trimmed.to_string()]
            }
        }
        other => parse_numberish(other)
            .map(|n| vec![stringify_number(n)])
            .unwrap_or_default(),
    }
}

fn output_id(output: &Value) -> &str {
    output
        .get("output_id")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn surface_str<'a>(output: &'a Value, key: &str) -> Option<&'a str> {
    output
        .get("surface")
        .and_then(|s| s.get(key))
        .and_then(Value::as_str)
}

/// Source: placement-decision.ts (applyContentMilestoneSupersession)
#[must_use]
pub fn apply_content_milestone_supersession(outputs: &[Value]) -> Vec<Value> {
    if outputs.len() <= 1 {
        return outputs.to_vec();
    }
    let mut suppressed: HashSet<String> = HashSet::new();

    for contender in outputs {
        let Some(template) = surface_str(contender, "template").filter(|t| !t.is_empty()) else {
            continue;
        };
        let supersedes = superseded_versions(contender);
        if supersedes.is_empty() {
            continue;
        }
        for candidate in outputs {
            if output_id(candidate) == output_id(contender) {
                continue;
            }
            if surface_str(candidate, "template") != Some(template) {
                continue;
            }
            let Some(version) = milestone_version(candidate) else {
                continue;
            };
            if supersedes.contains(&version) {
                suppressed.insert(output_id(candidate).to_string());
            }
        }
    }

    let mut by_template: HashMap<&str, Vec<&Value>> = HashMap::new();
    for output in outputs {
        let Some(template) = surface_str(output, "template").filter(|t| !t.is_empty()) else {
            continue;
        };
        by_template.entry(template).or_default().push(output);
    }

    for group in by_template.values() {
        if group.len() <= 1 {
            continue;
        }
        let contenders: Vec<(&Value, f64)> = group
            .iter()
            .filter_map(|output| {
                parse_numberish(content_of(output).and_then(|c| c.get("milestone_order")))
                    .map(|order| (*output, order))
            })
            .collect();
        if contenders.len() <= 1 {
            continue;
        }
        let winner = contenders
            .iter()
            .skip(1)
            .fold(&contenders[0], |current, next| {
                if next.1 > current.1 {
                    next
                } else {
                    current
                }
            });
        for (output, _) in &contenders {
            if output_id(output) != output_id(winner.0) {
                suppressed.insert(output_id(output).to_string());
            }
        }
    }

    outputs
        .iter()
        .filter(|o| !suppressed.contains(output_id(o)))
        .cloned()
        .collect()
}

fn read_entitlement_handle(output: &Value) -> Option<&str> {
    content_of(output)
        .and_then(|c| c.get("__trigger_entitlement_handle"))
        .and_then(Value::as_str)
        .filter(|h| !h.is_empty())
}

fn conflict_keys_for_pair<'a>(
    left: &'a Value,
    right: &'a Value,
    bucket: i64,
) -> (&'a str, &'a str) {
    if bucket == 1 {
        if let (Some(l), Some(r)) = (
            surface_str(left, "slot_id").filter(|s| !s.is_empty()),
            surface_str(right, "slot_id").filter(|s| !s.is_empty()),
        ) {
            return (l, r);
        }
    } else if bucket == 0 {
        if let (Some(l), Some(r)) = (
            read_entitlement_handle(left),
            read_entitlement_handle(right),
        ) {
            return (l, r);
        }
    }
    (
        surface_str(left, "type").unwrap_or(""),
        surface_str(right, "type").unwrap_or(""),
    )
}

/// Source: placement-decision.ts (applyCategoryConflictSuppression)
#[must_use]
pub fn apply_category_conflict_suppression(outputs: &[Value]) -> Vec<Value> {
    if outputs.len() <= 1 {
        return outputs.to_vec();
    }
    let mut suppressed: HashSet<String> = HashSet::new();

    for i in 0..outputs.len() {
        for j in (i + 1)..outputs.len() {
            let left = &outputs[i];
            let right = &outputs[j];
            if surface_str(left, "type") != surface_str(right, "type") {
                continue;
            }
            let left_bucket =
                category_bucket(left.get("category").and_then(Value::as_str).unwrap_or(""));
            let right_bucket =
                category_bucket(right.get("category").and_then(Value::as_str).unwrap_or(""));
            if left_bucket != right_bucket {
                if left_bucket < right_bucket {
                    suppressed.insert(output_id(right).to_string());
                } else {
                    suppressed.insert(output_id(left).to_string());
                }
                continue;
            }
            if left_bucket == 0 || left_bucket == 1 {
                let (left_key, right_key) = conflict_keys_for_pair(left, right, left_bucket);
                if left_key == right_key {
                    suppressed.insert(output_id(right).to_string());
                }
            }
        }
    }

    outputs
        .iter()
        .filter(|o| !suppressed.contains(output_id(o)))
        .cloned()
        .collect()
}

/// Selection options mirroring `CandidateResolutionOptions`.
#[derive(Debug, Clone, Copy, Default)]
pub struct CandidateResolutionOptions {
    /// When true, only fixed-category candidates are considered.
    pub fixed_only: bool,
}

/// Source: placement-decision.ts (resolveLocalPlacementFromCandidates)
#[must_use]
pub fn resolve_local_placement_from_candidates(
    candidates: &[Value],
    options: CandidateResolutionOptions,
) -> Option<Value> {
    let pool: Vec<Value> = if options.fixed_only {
        candidates
            .iter()
            .filter(|o| {
                category_bucket(o.get("category").and_then(Value::as_str).unwrap_or("")) == 1
            })
            .cloned()
            .collect()
    } else {
        candidates.to_vec()
    };
    if pool.is_empty() {
        return None;
    }

    let milestones_applied = apply_content_milestone_supersession(&pool);
    if milestones_applied.is_empty() {
        return None;
    }

    let has_explicit_server_order = milestones_applied.iter().any(|o| server_order(o).is_some());

    let conflicts_applied = if has_explicit_server_order {
        milestones_applied
    } else {
        apply_category_conflict_suppression(&milestones_applied)
    };
    if conflicts_applied.is_empty() {
        return None;
    }

    let mut ordered = conflicts_applied;
    ordered.sort_by(|left, right| {
        if has_explicit_server_order {
            let lo = server_order(left);
            let ro = server_order(right);
            match (lo, ro) {
                (Some(l), Some(r)) if l != r => {
                    return l.partial_cmp(&r).unwrap_or(Ordering::Equal);
                }
                (Some(_), None) => return Ordering::Less,
                (None, Some(_)) => return Ordering::Greater,
                _ => {}
            }
        }

        let left_bucket =
            category_bucket(left.get("category").and_then(Value::as_str).unwrap_or(""));
        let right_bucket =
            category_bucket(right.get("category").and_then(Value::as_str).unwrap_or(""));
        if left_bucket != right_bucket {
            return left_bucket.cmp(&right_bucket);
        }

        // Plan 53 two-stage tier-3 urgency: tier3_class ascending, then
        // proximity descending.
        if left_bucket == 2 {
            let class_delta = tier3_class(left).cmp(&tier3_class(right));
            if class_delta != Ordering::Equal {
                return class_delta;
            }
            let prox = proximity_score(right)
                .partial_cmp(&proximity_score(left))
                .unwrap_or(Ordering::Equal);
            if prox != Ordering::Equal {
                return prox;
            }
        }

        let score = placement_score(right)
            .partial_cmp(&placement_score(left))
            .unwrap_or(Ordering::Equal);
        if score != Ordering::Equal {
            return score;
        }

        let priority = placement_priority(right)
            .partial_cmp(&placement_priority(left))
            .unwrap_or(Ordering::Equal);
        if priority != Ordering::Equal {
            return priority;
        }

        output_id(left).cmp(output_id(right))
    });

    ordered.into_iter().next()
}
