//! Entitlement check lifecycle.
//!
//! [`derive_local_entitlement_from_configured_rules`] is the Playbook-rule
//! fallback wired into `LocalRuntime`'s entitlement derivation. It does its
//! **own** inline rule filtering and reuses the §2.6.5 most-permissive
//! selector from [`super::rules`] — distinct from the provider-snapshot path,
//! but sharing the scorer so §2.6.5 is never implemented twice.
//!
//! Config values stay loosely typed (`serde_json::Value`), matching the Python
//! port's convention; the parity suite is the drift backstop.
//!
//! Source: revturbine-scaffold/src/entitlements/controllers/entitlement-check.ts

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::rules::{pick_most_permissive, rule_permissiveness};
use super::segment_matching::matches_rule_segments;
use super::unlimited::resolve_limit_value;
use crate::decisions::{int_if_integral, EntitlementCheckResult};

/// Mirror JS `Number(v)` for the value shapes `type_fields` carry.
///
/// An absent field arrives as `None`, standing in for TS `undefined` →
/// `Number(undefined)` is `NaN`, which keeps the "missing limit ⇒ not finite ⇒
/// unlimited" branch parity-correct. `""` → `0`; unparseable → `NaN`.
///
/// Source: the `Number(...)` coercions in entitlement-check.ts:178-191
fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None | Some(Value::Null) => f64::NAN,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// Apply a rule's `enforcement` mode when a usage / credit limit is reached
/// (plan 34 REQ-3). Under the limit is always allowed.
///
/// Source: entitlement-check.ts:50-68 (applyUsageEnforcement)
fn apply_usage_enforcement(
    over: bool,
    enforcement: Option<&Value>,
    base_reason: &str,
) -> EntitlementCheckResult {
    if !over {
        return EntitlementCheckResult::new("allowed", true);
    }
    match enforcement.and_then(Value::as_str) {
        Some("hard_block") => EntitlementCheckResult::with_reason("denied", false, base_reason),
        Some("soft_block") => EntitlementCheckResult::with_reason(
            "denied",
            false,
            &format!("{base_reason}_soft_block"),
        ),
        Some("degrade") => {
            EntitlementCheckResult::with_reason("limited", true, &format!("{base_reason}_degraded"))
        }
        Some("allow_overage") => {
            EntitlementCheckResult::with_reason("allowed", true, &format!("{base_reason}_overage"))
        }
        // Unset / unknown: limited AND denied. Note this differs from
        // `degrade`, which is limited but ALLOWED.
        _ => EntitlementCheckResult::with_reason("limited", false, base_reason),
    }
}

/// Enrich a limit-bearing outcome so the result carries the numbers (plan 133).
///
/// Source: entitlement-check.ts (withLimitFields)
fn with_limit_fields(
    mut base: EntitlementCheckResult,
    limit: f64,
    used: f64,
) -> EntitlementCheckResult {
    base.limit = int_if_integral(limit);
    base.used = int_if_integral(used);
    base.remaining = int_if_integral((limit - used).max(0.0));
    base
}

/// Rule kinds [`derive_result_from_rule_type_fields`] gives dedicated
/// semantics. A matched rule of any OTHER kind (e.g. legacy `metered`) proves
/// the plan assignment exists but falls through to provider entry/usage logic
/// rather than the shaper's unknown-kind default.
///
/// Source: entitlement-check.ts (isRuleShapedKind)
#[must_use]
pub fn is_rule_shaped_kind(kind: &str) -> bool {
    matches!(
        kind,
        "feature" | "usage_limit" | "limit" | "credits" | "capability_tier"
    )
}

/// Shape a result from a matched rule's `type_fields` (plan 133).
///
/// Single-sourced for BOTH evaluators — the Playbook path below and the
/// provider-snapshot path — so a matched rule yields identical results on
/// every surface. Limit-bearing outcomes carry `limit` / `used` / `remaining`.
///
/// Source: entitlement-check.ts (deriveResultFromRuleTypeFields)
#[must_use]
pub fn derive_result_from_rule_type_fields(
    type_fields: &Value,
    used: f64,
) -> EntitlementCheckResult {
    let kind = type_fields.get("kind").and_then(Value::as_str);

    match kind {
        Some("feature") => {
            // Anything other than an explicit `false` is enabled — an absent
            // flag defaults ON, matching `!== false` in the TS.
            let enabled = type_fields.get("enabled") != Some(&Value::Bool(false));
            if enabled {
                EntitlementCheckResult::new("allowed", true)
            } else {
                EntitlementCheckResult::with_reason("denied", false, "feature_not_enabled_for_plan")
            }
        }

        // `usage_limit` is the bundle-canonical kind; `limit` is the accepted
        // config-authoring shorthand — treated identically.
        Some("usage_limit" | "limit") => {
            let resolved = resolve_limit_value(type_fields.get("limit_value"));
            match resolved {
                Some(l) if l.is_finite() && l >= 0.0 => with_limit_fields(
                    apply_usage_enforcement(
                        used >= l,
                        type_fields.get("enforcement"),
                        "usage_limit_reached",
                    ),
                    l,
                    used,
                ),
                // Unlimited (+inf) or unusable → allowed, no limit fields.
                _ => EntitlementCheckResult::new("allowed", true),
            }
        }

        Some("credits") => {
            // An *explicit* allowance (incl. null/'unlimited'/999999 → +inf)
            // wins; only a *truly absent* allowance falls through to
            // initial_grant. Presence, not resolution, picks the source.
            let allowance = if type_fields.get("allowance_value").is_some() {
                resolve_limit_value(type_fields.get("allowance_value"))
            } else if type_fields.get("allowance").is_some() {
                resolve_limit_value(type_fields.get("allowance"))
            } else {
                None
            };
            let initial_grant = js_number(type_fields.get("initial_grant"));

            let cr_limit = match allowance {
                Some(a) if a >= 0.0 => Some(a),
                _ if initial_grant.is_finite() && initial_grant >= 0.0 => Some(initial_grant),
                _ => None,
            };

            match cr_limit {
                Some(l) if l.is_finite() => with_limit_fields(
                    apply_usage_enforcement(
                        used >= l,
                        type_fields.get("enforcement"),
                        "credit_balance_exhausted",
                    ),
                    l,
                    used,
                ),
                _ => EntitlementCheckResult::new("allowed", true),
            }
        }

        Some("capability_tier") => {
            let mut result = EntitlementCheckResult::new("allowed", true);
            if let Some(tier) = type_fields.get("tier_name").and_then(Value::as_str) {
                if !tier.is_empty() {
                    result.current_tier = Some(tier.to_string());
                }
            }
            result
        }

        _ => EntitlementCheckResult::new("allowed", true),
    }
}

/// Inputs to [`derive_local_entitlement_from_configured_rules`].
#[derive(Debug, Clone, Default)]
pub struct LocalEntitlementInput<'a> {
    /// The entitlement handle being checked.
    pub handle: &'a str,
    /// Explicit usage override. `Some(n)` wins over every other source —
    /// including `0`, which is why this is an `Option` and not a sentinel.
    pub context_used: Option<f64>,
    /// The user's plan handle. Matched case-insensitively.
    pub current_plan_handle: &'a str,
    /// Segments the user belongs to, pre-resolved by the caller.
    pub segment_ids: HashSet<String>,
    /// Per-entitlement consumption. A finite balance — including `0` — wins
    /// over `user_usage`.
    pub usage_balances: HashMap<String, f64>,
    /// Per-entitlement `{amount}` records.
    pub user_usage: Option<&'a Value>,
}

/// Derive an entitlement result locally from Playbook rules.
///
/// Returns `None` when no config is available; an explicit result otherwise —
/// including `no_matching_entitlement_rule` ⇒ denied, **failing closed**.
///
/// Source: entitlement-check.ts:77-211
#[must_use]
pub fn derive_local_entitlement_from_configured_rules(
    input: &LocalEntitlementInput,
    exported_config: &Value,
) -> Option<EntitlementCheckResult> {
    let empty: Vec<Value> = Vec::new();
    let entitlements = exported_config
        .get("entitlements")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    // Plan 120 TASK-4 / plan 191 REQ-1: the config carries only the handle, so
    // entitlements resolve by handle alone. The `id` fallback this port used to
    // carry was a pre-plan-120 mirror that TS dropped; because the ids in the
    // corpus (`ent_core_credits`) differ from the handles the rules reference
    // (`core_credits`), it made every rule miss and every check deny.
    let entitlement = entitlements
        .iter()
        .find(|item| item.get("unique_handle").and_then(Value::as_str) == Some(input.handle));

    let entitlement_id = entitlement
        .and_then(|e| e.get("unique_handle"))
        .and_then(Value::as_str)
        .unwrap_or(input.handle)
        .to_string();

    let normalized_plan_handle = input.current_plan_handle.to_lowercase();

    let plans = exported_config
        .get("plans")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    // Plan 191 REQ-1: plan identity IS the handle. `plans[].id` is DB-internal
    // and never participates in matching — a context whose only plan signal is
    // that id must miss every plan-targeted rule.
    let matched_plan = plans.iter().find(|p| {
        p.get("unique_handle")
            .and_then(Value::as_str)
            .is_some_and(|h| h.to_lowercase() == normalized_plan_handle)
    });

    // The handle the user's current plan is known by — plan targets are
    // handle-valued, so this is what a `kind:'plan'` target matches against.
    let current_plan_handle_ref: Option<String> = matched_plan
        .and_then(|p| p.get("unique_handle"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            if normalized_plan_handle.is_empty() {
                None
            } else {
                Some(normalized_plan_handle.clone())
            }
        });

    let rules = exported_config
        .get("entitlement_rules")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    // Plan #39 REQ-28: build the segment_id → dimension_id lookup once per
    // call. Segments missing a dimension fall into `__no_dim__` inside the
    // matcher, preserving flat-OR back-compat for pre-PR-B exports.
    let mut segment_dimensions: HashMap<String, String> = HashMap::new();
    if let Some(segments) = exported_config.get("segments").and_then(Value::as_array) {
        for seg in segments {
            if let (Some(sid), Some(dim)) = (
                seg.get("id").and_then(Value::as_str),
                seg.get("dimension_id").and_then(Value::as_str),
            ) {
                segment_dimensions.insert(sid.to_string(), dim.to_string());
            }
        }
    }

    let matches = |rule: &Value| -> bool {
        let rule_ent_id = rule
            .get("entitlement_id")
            .and_then(Value::as_str)
            .or_else(|| rule.get("entitlementId").and_then(Value::as_str))
            .unwrap_or("");
        if rule_ent_id != entitlement_id {
            return false;
        }

        // Plan targeting derives from kind:'plan' targets; legacy
        // plan_ids/planIds tolerated. Empty ⇒ matches NOTHING (plan 34 REQ-9).
        let plan_ids: Vec<&str> = if let Some(targets) =
            rule.get("targets").and_then(Value::as_array)
        {
            targets
                .iter()
                // `is_object()` is the Rust spelling of the TS `isRecord`
                // predicate the Python port imports as `is_record`.
                .filter(|t| t.is_object() && t.get("kind").and_then(Value::as_str) == Some("plan"))
                .filter_map(|t| t.get("id").and_then(Value::as_str))
                .collect()
        } else {
            rule.get("plan_ids")
                .or_else(|| rule.get("planIds"))
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default()
        };

        // Plan 120 TASK-4: plan targets are handle-valued — match the user's
        // current plan HANDLE against the rule's listed plan handles.
        if let Some(handle_ref) = current_plan_handle_ref.as_deref() {
            if !plan_ids.contains(&handle_ref) {
                return false;
            }
        }

        let rule_segment_ids: Option<Vec<String>> = rule
            .get("segment_ids")
            .or_else(|| rule.get("segmentIds"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            });

        matches_rule_segments(
            rule_segment_ids.as_deref(),
            &input.segment_ids,
            &segment_dimensions,
        )
    };

    let matching_rules: Vec<&Value> = rules.iter().filter(|r| matches(r)).collect();

    // No rule grants this entitlement to the user's plan. Plan #39 made plan
    // targeting explicit, so the absence of a match means NOT granted — deny,
    // failing closed.
    if matching_rules.is_empty() {
        return Some(EntitlementCheckResult::with_reason(
            "denied",
            false,
            "no_matching_entitlement_rule",
        ));
    }

    // Plan 147 (OQ-6): the wire is flat — the rule IS the type-fields bag, and
    // `kind` is derived from the parent entitlement's type. A legacy nested
    // `type_fields` / camel `typeFields` bag is tolerated for the migration
    // window, merged UNDER the flat fields (flat wins).
    let mut entitlement_type_by_handle: HashMap<&str, &str> = HashMap::new();
    for e in entitlements {
        if let (Some(h), Some(t)) = (
            e.get("unique_handle").and_then(Value::as_str),
            e.get("type").and_then(Value::as_str),
        ) {
            entitlement_type_by_handle.insert(h, t);
        }
    }

    let type_fields_of = |r: &Value| -> Value {
        let mut merged = Map::new();
        if let Some(nested) = r
            .get("type_fields")
            .or_else(|| r.get("typeFields"))
            .and_then(Value::as_object)
        {
            for (k, v) in nested {
                merged.insert(k.clone(), v.clone());
            }
        }
        if let Some(flat) = r.as_object() {
            for (k, v) in flat {
                merged.insert(k.clone(), v.clone());
            }
        }
        if !merged.get("kind").is_some_and(Value::is_string) {
            if let Some(ent_id) = r.get("entitlement_id").and_then(Value::as_str) {
                if let Some(derived) = entitlement_type_by_handle.get(ent_id) {
                    merged.insert("kind".into(), Value::String((*derived).to_string()));
                }
            }
        }
        Value::Object(merged)
    };

    // §2.6.5 (plan 34 REQ-1): when multiple rules match, the MOST PERMISSIVE
    // wins — NOT array order. Reuses the single-sourced scorer + tie-break, so
    // this is identical to find_matching_entitlement_rule.
    let scored: Vec<(&Value, Value)> = matching_rules
        .iter()
        .map(|r| (*r, type_fields_of(r)))
        .collect();
    let chosen = pick_most_permissive(&scored, |(_, tf)| {
        let kind = tf.get("kind").and_then(Value::as_str).unwrap_or("");
        rule_permissiveness(kind, tf)
    });
    let type_fields =
        chosen.map_or_else(|| type_fields_of(matching_rules[0]), |(_, tf)| tf.clone());

    // JS `??` chain: nullish-coalescing — 0 passes through, only absent falls
    // to the next source. Explicit `is_none()` checks, never `unwrap_or`,
    // which would skip a legitimate 0.
    let usage_amount_for = |key: &str| -> Option<f64> {
        input
            .user_usage?
            .get(key)
            .filter(|e| e.is_object())?
            .get("amount")
            .and_then(Value::as_f64)
    };
    let finite_balance = |key: &str| -> Option<f64> {
        input
            .usage_balances
            .get(key)
            .copied()
            .filter(|v| v.is_finite())
    };

    let used = input.context_used.unwrap_or_else(|| {
        finite_balance(input.handle)
            .or_else(|| finite_balance(&entitlement_id))
            .or_else(|| usage_amount_for(input.handle))
            .or_else(|| usage_amount_for(&entitlement_id))
            .unwrap_or(0.0)
    });

    Some(derive_result_from_rule_type_fields(&type_fields, used))
}
