//! Entitlement rule evaluation.
//!
//! Matches rules against a plan/segment context and picks the **most
//! permissive** matched rule — plan 34 REQ-1 / §2.6.5, "where entitlement
//! rules overlap, the most permissive rule prevails". Ties resolve to earliest
//! source order, which is deterministic and cross-language-parity-stable.
//!
//! Config-shaped values stay loosely typed (`serde_json::Value`), matching the
//! Python port's `dict[str, Any]` convention — the parity suite is the drift
//! backstop, not the type system.
//!
//! Source: revturbine-scaffold/src/entitlements/controllers/rules.ts

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::segment_matching::matches_rule_segments;
use super::unlimited::resolve_limit_value;

/// User targeting context. `segment_ids` is required; the rest are optional
/// forward context for kind-discriminated targets.
///
/// `segment_dimensions` (plan #39 REQ-28) carries the
/// `segment_id -> dimension_id` lookup the dimensional matcher uses. When
/// empty, the matcher falls back to flat-OR via the `__no_dim__` bucket,
/// preserving pre-PR-B back-compat.
///
/// Source: rules.ts:14-35 (RuleEvaluationContext)
#[derive(Debug, Clone, Default)]
pub struct RuleEvaluationContext {
    /// Segments the user belongs to, pre-resolved by the caller.
    pub segment_ids: HashSet<String>,
    /// The user's plan id. Matched against `kind:'plan'` targets and legacy
    /// `plan_ids`.
    pub current_plan_id: Option<String>,
    /// The user's plan handle — matched interchangeably with the id
    /// (plan 120 TASK-3.5).
    pub current_plan_handle: Option<String>,
    /// The user's plan-variation id, for `kind:'plan_variation'` targets.
    pub current_plan_variation_id: Option<String>,
    /// Addon ids the user holds, for `kind:'addon'` targets.
    pub addon_ids: Vec<String>,
    /// Addon-variation ids, for `kind:'addon_variation'` targets.
    pub addon_variation_ids: Vec<String>,
    /// Billing period, carried as forward context.
    pub billing_period: Option<String>,
    /// `segment_id -> dimension_id`. Empty falls back to flat-OR matching.
    pub segment_dimensions: HashMap<String, String>,
}

/// Read a string field off a loosely-typed config record.
fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// Read a string array off a loosely-typed config record, skipping non-strings.
fn str_array(v: &Value, key: &str) -> Option<Vec<String>> {
    v.get(key).and_then(Value::as_array).map(|arr| {
        arr.iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

/// Does one kind-discriminated target match the user context?
///
/// Source: rules.ts:44-60 (targetMatches)
fn target_matches(t: &Value, ctx: &RuleEvaluationContext) -> bool {
    let id = str_field(t, "id");
    match str_field(t, "kind") {
        // Plan 120 TASK-3.5: match the plan target by id OR handle.
        Some("plan") => {
            (ctx.current_plan_id.is_some() && id == ctx.current_plan_id.as_deref())
                || (ctx.current_plan_handle.is_some() && id == ctx.current_plan_handle.as_deref())
        }
        Some("plan_variation") => {
            ctx.current_plan_variation_id.is_some()
                && id == ctx.current_plan_variation_id.as_deref()
        }
        Some("addon") => id.is_some_and(|i| ctx.addon_ids.iter().any(|a| a == i)),
        Some("addon_variation") => {
            id.is_some_and(|i| ctx.addon_variation_ids.iter().any(|a| a == i))
        }
        _ => false,
    }
}

/// One rule's evaluation against the context.
///
/// Source: rules.ts:62-67 (EntitlementRuleEvaluation)
#[derive(Debug, Clone)]
pub struct EntitlementRuleEvaluation<'a> {
    /// The rule this evaluation describes.
    pub rule: &'a Value,
    /// Whether the rule's plan targeting admits this user.
    pub matches_plan: bool,
    /// Whether the rule's segment scope admits this user.
    pub matches_segment: bool,
    /// Both of the above — the rule governs only when this is true.
    pub matched: bool,
}

/// Evaluate rules against plan + segment context.
///
/// A rule matches when: kind-discriminated `targets` (any match) when present,
/// else the legacy `plan_ids` path — matching only when `current_plan_id` (or
/// handle) is **explicitly listed**. An empty list matches NOTHING; the
/// implicit "empty ⇒ all plans" was removed (plan 34 REQ-9 / TASK-11). AND the
/// segment scope matches (plan #39 REQ-8).
///
/// Source: rules.ts:83-104 (evaluateEntitlementRules)
#[must_use]
pub fn evaluate_entitlement_rules<'a>(
    rules: &'a [Value],
    context: &RuleEvaluationContext,
) -> Vec<EntitlementRuleEvaluation<'a>> {
    rules
        .iter()
        .map(|rule| {
            let targets = rule.get("targets").and_then(Value::as_array);
            let matches_plan = match targets {
                Some(ts) if !ts.is_empty() => ts.iter().any(|t| target_matches(t, context)),
                _ => {
                    // Legacy `plan_ids` path — plan 120 TASK-3.5: id OR handle.
                    let plan_ids = str_array(rule, "plan_ids").unwrap_or_default();
                    context
                        .current_plan_id
                        .as_ref()
                        .is_some_and(|id| plan_ids.contains(id))
                        || context
                            .current_plan_handle
                            .as_ref()
                            .is_some_and(|h| plan_ids.contains(h))
                }
            };

            let rule_segment_ids = str_array(rule, "segment_ids");
            let matches_segment = matches_rule_segments(
                rule_segment_ids.as_deref(),
                &context.segment_ids,
                &context.segment_dimensions,
            );

            EntitlementRuleEvaluation {
                rule,
                matches_plan,
                matches_segment,
                matched: matches_plan && matches_segment,
            }
        })
        .collect()
}

/// Active plan rules matching the segment context.
///
/// Plan rules retain the singular `segment_id` scalar — a different table
/// (plan_variations), REQ-21 out of scope.
///
/// Source: rules.ts:111-120 (evaluatePlanRules)
#[must_use]
pub fn evaluate_plan_rules<'a>(
    rules: &'a [Value],
    context: &RuleEvaluationContext,
) -> Vec<&'a Value> {
    rules
        .iter()
        .filter(|rule| str_field(rule, "status") == Some("active"))
        .filter(|rule| match rule.get("segment_id") {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => context.segment_ids.contains(s),
            _ => false,
        })
        .collect()
}

/// Permissiveness score — higher grants more access.
///
/// `"unlimited"` → `+∞`; finite numeric as-is; non-orderable kinds → neutral
/// `0` (the deterministic source-order tie-break then applies).
///
/// Takes the structural `{kind, fields}` pair so the ExportedConfig fallback in
/// [`super::entitlement_check`] reuses this single source — the §2.6.5 scoring
/// is never implemented twice.
///
/// Source: rules.ts:138-158 (rulePermissiveness)
#[must_use]
pub fn rule_permissiveness(kind: &str, fields: &Value) -> f64 {
    match kind {
        "usage_limit" => resolve_limit_value(fields.get("limit_value")).unwrap_or(0.0),
        "credits" => {
            // Prefer `allowance_value`, fall back to legacy `allowance`. Pick
            // the source field by PRESENCE before resolving — an absent value
            // resolves to +inf, which would otherwise swallow the fallback.
            let v = if fields.get("allowance_value").is_some() {
                fields.get("allowance_value")
            } else {
                fields.get("allowance")
            };
            resolve_limit_value(v).unwrap_or(0.0)
        }
        "seat" => resolve_limit_value(fields.get("included_count")).unwrap_or(0.0),
        // Strictly boolean `true` — a truthy-but-not-true value (e.g. the
        // string "yes") must NOT score as enabled.
        "feature" if fields.get("enabled") == Some(&Value::Bool(true)) => 1.0,
        "feature" => 0.0,
        _ => 0.0,
    }
}

/// THE most-permissive selection + tie-break rule, single-sourced (plan 34
/// REQ-1 / §2.6.5): highest score wins, ties resolve to the **earliest** in
/// source order.
///
/// The strict `>` is what keeps the first-seen item on a tie — a `>=` here
/// would silently switch the tie-break to last-wins and diverge from both
/// other ports.
///
/// Source: rules.ts:165-185 (pickMostPermissive)
#[must_use]
pub fn pick_most_permissive<T, F>(items: &[T], score: F) -> Option<&T>
where
    F: Fn(&T) -> f64,
{
    let mut best: Option<&T> = None;
    let mut best_score = f64::NEG_INFINITY;
    for item in items {
        let s = score(item);
        if best.is_none() || s > best_score {
            best = Some(item);
            best_score = s;
        }
    }
    best
}

/// Pick the most-permissive rule among matched evaluations.
///
/// Source: rules.ts:188-194 (selectMostPermissive)
#[must_use]
pub fn select_most_permissive<'a>(matched: &[EntitlementRuleEvaluation<'a>]) -> Option<&'a Value> {
    pick_most_permissive(matched, |e| {
        let kind = str_field(e.rule, "kind").unwrap_or("");
        rule_permissiveness(kind, e.rule)
    })
    .map(|e| e.rule)
}

/// Governing rule for an entitlement — most-permissive among matched, NOT
/// array order. `None` if no rule matches.
///
/// Source: rules.ts:187-197 (findMatchingEntitlementRule)
#[must_use]
pub fn find_matching_entitlement_rule<'a>(
    entitlement_rules: &'a HashMap<String, Vec<Value>>,
    entitlement_id: &str,
    context: &RuleEvaluationContext,
) -> Option<&'a Value> {
    let rules = entitlement_rules.get(entitlement_id)?;
    if rules.is_empty() {
        return None;
    }
    let evaluations = evaluate_entitlement_rules(rules, context);
    let matched: Vec<_> = evaluations.into_iter().filter(|e| e.matched).collect();
    select_most_permissive(&matched)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx_with_plan(plan: &str, segments: &[&str]) -> RuleEvaluationContext {
        RuleEvaluationContext {
            segment_ids: segments.iter().map(|s| (*s).to_string()).collect(),
            current_plan_id: Some(plan.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn empty_plan_targeting_matches_nothing() {
        // Plan 34 REQ-9: targeting is ALWAYS explicit. An empty plan_ids used
        // to mean "all plans"; that implicit grant was removed and this is the
        // regression guard.
        let rules = vec![json!({ "plan_ids": [], "kind": "feature", "enabled": true })];
        let evals = evaluate_entitlement_rules(&rules, &ctx_with_plan("pro", &[]));
        assert!(!evals[0].matches_plan);
        assert!(!evals[0].matched);
    }

    #[test]
    fn legacy_plan_ids_matches_by_id_or_handle() {
        let rules = vec![json!({ "plan_ids": ["pro"] })];
        assert!(evaluate_entitlement_rules(&rules, &ctx_with_plan("pro", &[]))[0].matches_plan);

        let by_handle = RuleEvaluationContext {
            current_plan_handle: Some("pro".into()),
            ..Default::default()
        };
        assert!(evaluate_entitlement_rules(&rules, &by_handle)[0].matches_plan);
    }

    #[test]
    fn kind_discriminated_targets_take_precedence_over_plan_ids() {
        let rules = vec![json!({
            "plan_ids": ["starter"],
            "targets": [{ "kind": "plan", "id": "pro" }],
        })];
        // targets present ⇒ plan_ids ignored entirely.
        assert!(evaluate_entitlement_rules(&rules, &ctx_with_plan("pro", &[]))[0].matches_plan);
        assert!(
            !evaluate_entitlement_rules(&rules, &ctx_with_plan("starter", &[]))[0].matches_plan
        );
    }

    #[test]
    fn target_kinds_addon_and_variation() {
        let ctx = RuleEvaluationContext {
            addon_ids: vec!["addon_a".into()],
            current_plan_variation_id: Some("var_1".into()),
            ..Default::default()
        };
        let rules = vec![
            json!({ "targets": [{ "kind": "addon", "id": "addon_a" }] }),
            json!({ "targets": [{ "kind": "plan_variation", "id": "var_1" }] }),
            json!({ "targets": [{ "kind": "addon", "id": "nope" }] }),
            json!({ "targets": [{ "kind": "unknown_kind", "id": "x" }] }),
        ];
        let evals = evaluate_entitlement_rules(&rules, &ctx);
        assert!(evals[0].matches_plan);
        assert!(evals[1].matches_plan);
        assert!(!evals[2].matches_plan);
        assert!(!evals[3].matches_plan, "unknown target kinds never match");
    }

    #[test]
    fn permissiveness_ranks_unlimited_above_finite() {
        assert_eq!(
            rule_permissiveness("usage_limit", &json!({ "limit_value": "unlimited" })),
            f64::INFINITY
        );
        assert_eq!(
            rule_permissiveness("usage_limit", &json!({ "limit_value": 10 })),
            10.0
        );
        // Absent limit_value is "unlimited" too (plan 72).
        assert_eq!(
            rule_permissiveness("usage_limit", &json!({})),
            f64::INFINITY
        );
    }

    #[test]
    fn credits_prefers_allowance_value_by_presence_not_by_resolution() {
        // The subtle one: an explicit null `allowance_value` resolves to +inf,
        // so choosing the source field AFTER resolving would swallow the
        // legacy `allowance` fallback.
        assert_eq!(
            rule_permissiveness("credits", &json!({ "allowance_value": 5, "allowance": 99 })),
            5.0
        );
        assert_eq!(
            rule_permissiveness("credits", &json!({ "allowance": 99 })),
            99.0
        );
    }

    #[test]
    fn feature_permissiveness_is_strictly_boolean_true() {
        assert_eq!(
            rule_permissiveness("feature", &json!({ "enabled": true })),
            1.0
        );
        assert_eq!(
            rule_permissiveness("feature", &json!({ "enabled": false })),
            0.0
        );
        // Truthy-but-not-true must NOT score as enabled.
        assert_eq!(
            rule_permissiveness("feature", &json!({ "enabled": "yes" })),
            0.0
        );
        assert_eq!(rule_permissiveness("feature", &json!({})), 0.0);
    }

    #[test]
    fn unknown_kinds_score_neutral() {
        assert_eq!(
            rule_permissiveness("metered", &json!({ "limit_value": 5 })),
            0.0
        );
        assert_eq!(rule_permissiveness("", &json!({})), 0.0);
    }

    #[test]
    fn ties_resolve_to_earliest_source_order() {
        // §2.6.5 tie-break. `>=` instead of `>` would pick the last item and
        // silently diverge from the TS and Python ports.
        let items = vec![json!({ "id": "first" }), json!({ "id": "second" })];
        let chosen = pick_most_permissive(&items, |_| 1.0).unwrap();
        assert_eq!(chosen["id"], "first");
    }

    #[test]
    fn most_permissive_wins_over_array_order() {
        let items = vec![json!({ "limit_value": 1 }), json!({ "limit_value": 100 })];
        let chosen =
            pick_most_permissive(&items, |r| rule_permissiveness("usage_limit", r)).unwrap();
        assert_eq!(chosen["limit_value"], 100);
    }

    #[test]
    fn find_matching_rule_selects_most_permissive_not_first() {
        let mut map = HashMap::new();
        map.insert(
            "feat_x".to_string(),
            vec![
                json!({ "plan_ids": ["pro"], "kind": "usage_limit", "limit_value": 5 }),
                json!({ "plan_ids": ["pro"], "kind": "usage_limit", "limit_value": 50 }),
            ],
        );
        let found = find_matching_entitlement_rule(&map, "feat_x", &ctx_with_plan("pro", &[]));
        assert_eq!(found.unwrap()["limit_value"], 50);
    }

    #[test]
    fn find_matching_rule_returns_none_when_nothing_matches() {
        let mut map = HashMap::new();
        map.insert(
            "feat_x".to_string(),
            vec![json!({ "plan_ids": ["enterprise"], "kind": "feature" })],
        );
        assert!(
            find_matching_entitlement_rule(&map, "feat_x", &ctx_with_plan("pro", &[])).is_none()
        );
        assert!(
            find_matching_entitlement_rule(&map, "absent", &ctx_with_plan("pro", &[])).is_none()
        );
    }

    #[test]
    fn plan_rules_filter_on_active_status_and_segment() {
        let rules = vec![
            json!({ "status": "active", "segment_id": null }),
            json!({ "status": "draft", "segment_id": null }),
            json!({ "status": "active", "segment_id": "seg_a" }),
            json!({ "status": "active", "segment_id": "seg_z" }),
        ];
        let ctx = ctx_with_plan("pro", &["seg_a"]);
        let kept = evaluate_plan_rules(&rules, &ctx);
        assert_eq!(
            kept.len(),
            2,
            "null-segment + matching-segment active rules"
        );
    }
}
