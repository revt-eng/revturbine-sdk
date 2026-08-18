//! Shared coercion helpers.
//!
//! Only the subset the state layer needs is ported here; the rest of
//! `helpers.ts` serves the placement path and lands with it.
//!
//! Note there is no `is_record` — the TS predicate (`typeof === 'object' &&
//! !Array.isArray`) is exactly `serde_json::Value::is_object()`, so it is used
//! directly at call sites rather than wrapped.
//!
//! Source: revturbine-scaffold/src/core/helpers.ts

use serde_json::{Map, Value};

/// Cap windows. Unrecognized input is treated as `month` by
/// [`period_window_start`], matching the TS fall-through.
///
/// Source: state/types.ts (CapPeriod)
pub const CAP_PERIODS: &[&str] = &["session", "day", "week", "month", "lifetime"];

const MS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const MS_PER_WEEK: f64 = 7.0 * MS_PER_DAY;
const MS_PER_MONTH: f64 = 30.0 * MS_PER_DAY;

/// A parsed `{count, period}` cap rule.
///
/// Source: state/types.ts (PlacementCapRule)
#[derive(Debug, Clone, PartialEq)]
pub struct PlacementCapRule {
    /// How many presentations the window allows. Always positive and finite.
    pub count: f64,
    /// The window this rule applies over.
    pub period: String,
}

/// Coerce a value to a finite number, or `None` if not coercible.
///
/// Accepts numbers and numeric strings. **Rejects booleans** — TS
/// `typeof value === 'number'` is false for them, and Python needed an
/// explicit guard because `bool` subclasses `int`. In Rust `Value::Bool` simply
/// isn't a `Number`, so the rejection is structural rather than defensive.
/// NaN and ±∞ are rejected.
///
/// Source: helpers.ts:48-55 (parseNumberish)
#[must_use]
pub fn parse_numberish(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok().filter(|f| f.is_finite()),
        _ => None,
    }
}

/// Parse a `{count, period}` cap rule from untyped input.
///
/// `None` when the input is not an object, `count` is missing / non-positive /
/// non-finite, or `period` is not one of [`CAP_PERIODS`].
///
/// Source: helpers.ts:108-117 (parseCapRule)
#[must_use]
pub fn parse_cap_rule(input: Option<&Value>) -> Option<PlacementCapRule> {
    let obj = input?.as_object()?;
    let count = parse_numberish(obj.get("count"))?;
    if count <= 0.0 {
        return None;
    }
    let period = obj.get("period")?.as_str()?;
    if !CAP_PERIODS.contains(&period) {
        return None;
    }
    Some(PlacementCapRule {
        count,
        period: period.to_string(),
    })
}

/// Epoch-ms window start for `period`, anchored on `now_ms`.
///
/// `session` and `lifetime` start at `0` — a whole-history window. `day` is
/// 24h, `week` 7d, and **anything else** 30d: the TS treats unrecognized input
/// as `month` via a trailing fall-through, so this deliberately does not
/// validate its input.
///
/// Source: helpers.ts:119-124 (periodWindowStart)
#[must_use]
pub fn period_window_start(period: &str, now_ms: f64) -> f64 {
    match period {
        "session" | "lifetime" => 0.0,
        "day" => now_ms - MS_PER_DAY,
        "week" => now_ms - MS_PER_WEEK,
        _ => now_ms - MS_PER_MONTH,
    }
}

// ── Plan recommendation ─────────────────────────────────────────────────────

/// The `unique_handle` of the plan one tier above `current_plan_handle`.
///
/// Walks the hierarchy ascending by `tier_position` → `sort_order` →
/// `source_id`. `None` when the current plan is at the top of the ladder, is
/// absent from `plans`, or `plans` is empty.
///
/// Source: helpers.ts:217-237 (recommendNextPlanUp)
#[must_use]
pub fn recommend_next_plan_up(current_plan_handle: &str, plans: &[Value]) -> Option<String> {
    if plans.is_empty() {
        return None;
    }

    let mut sorted: Vec<&Value> = plans.iter().collect();
    // A three-key sort, all with a defined fallback — an absent field must not
    // reorder plans unpredictably.
    sorted.sort_by(|a, b| {
        let key = |p: &Value| {
            (
                p.get("tier_position").and_then(Value::as_i64).unwrap_or(0),
                p.get("sort_order").and_then(Value::as_i64).unwrap_or(0),
                p.get("source_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            )
        };
        key(a).cmp(&key(b))
    });

    let idx = sorted.iter().position(|p| {
        p.get("unique_handle").and_then(Value::as_str) == Some(current_plan_handle)
    })?;

    // Top of the ladder — nothing to recommend.
    sorted
        .get(idx + 1)?
        .get("unique_handle")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Resolve the `recommended_plan_*` tokens for one placement, dispatching on
/// its authored strategy.
///
/// - `custom` — the plan forced by `plan_override` (a `unique_handle`).
/// - `next_tier_up` (default) and `best_value` — the next plan up the
///   hierarchy. `best_value` falls back here until its scoring model ships.
///
/// Every edge case resolves to **empty strings**, the top-of-ladder
/// convention: an empty plan list, an unknown current plan, the top of the
/// hierarchy, and — for `custom` — a missing/unknown override or one equal to
/// the current plan.
///
/// Source: web-sdk/placements/recommendation.ts (resolveRecommendedPlanTokens)
#[must_use]
pub fn resolve_recommended_plan_tokens(
    strategy: &str,
    plan_override: Option<&str>,
    current_plan_handle: &str,
    plans: &[Value],
) -> Map<String, Value> {
    let empty = || {
        let mut m = Map::new();
        m.insert(
            "recommended_plan_handle".into(),
            Value::String(String::new()),
        );
        m.insert("recommended_plan_name".into(), Value::String(String::new()));
        m
    };
    let tokens = |handle: &str, name: &str| {
        let mut m = Map::new();
        m.insert(
            "recommended_plan_handle".into(),
            Value::String(handle.to_string()),
        );
        m.insert(
            "recommended_plan_name".into(),
            Value::String(name.to_string()),
        );
        m
    };

    if plans.is_empty() {
        return empty();
    }

    let by_handle = |h: &str| {
        plans
            .iter()
            .find(|p| p.get("unique_handle").and_then(Value::as_str) == Some(h))
    };

    if strategy == "custom" {
        let override_handle = plan_override.unwrap_or("");
        // An override equal to the current plan recommends nothing — there is
        // no upgrade to offer.
        if override_handle.is_empty() || override_handle == current_plan_handle {
            return empty();
        }
        return match by_handle(override_handle) {
            Some(plan) => tokens(
                plan.get("unique_handle")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                plan.get("name").and_then(Value::as_str).unwrap_or(""),
            ),
            None => empty(),
        };
    }

    if current_plan_handle.is_empty() {
        return empty();
    }
    let Some(next) = recommend_next_plan_up(current_plan_handle, plans) else {
        return empty();
    };
    // A plan with no name falls back to its handle rather than blanking.
    let name = by_handle(&next)
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(&next);
    tokens(&next, name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_numberish_accepts_numbers_and_numeric_strings() {
        assert_eq!(parse_numberish(Some(&json!(5))), Some(5.0));
        assert_eq!(parse_numberish(Some(&json!(2.5))), Some(2.5));
        assert_eq!(parse_numberish(Some(&json!("7"))), Some(7.0));
        assert_eq!(parse_numberish(Some(&json!("-3.5"))), Some(-3.5));
    }

    #[test]
    fn parse_numberish_rejects_booleans_and_junk() {
        // Booleans are the interesting case: the Python port needed an
        // explicit guard, and coercing them would silently admit `true` as 1.
        assert_eq!(parse_numberish(Some(&json!(true))), None);
        assert_eq!(parse_numberish(Some(&json!(false))), None);
        assert_eq!(parse_numberish(Some(&json!("abc"))), None);
        assert_eq!(parse_numberish(Some(&json!(""))), None);
        assert_eq!(parse_numberish(Some(&json!(null))), None);
        assert_eq!(parse_numberish(None), None);
    }

    #[test]
    fn parse_cap_rule_requires_positive_count_and_known_period() {
        assert_eq!(
            parse_cap_rule(Some(&json!({ "count": 3, "period": "day" }))),
            Some(PlacementCapRule {
                count: 3.0,
                period: "day".into()
            })
        );
        assert_eq!(
            parse_cap_rule(Some(&json!({ "count": 0, "period": "day" }))),
            None
        );
        assert_eq!(
            parse_cap_rule(Some(&json!({ "count": -1, "period": "day" }))),
            None
        );
        assert_eq!(
            parse_cap_rule(Some(&json!({ "count": 3, "period": "eon" }))),
            None
        );
        assert_eq!(parse_cap_rule(Some(&json!({ "period": "day" }))), None);
        assert_eq!(parse_cap_rule(Some(&json!("nope"))), None);
        assert_eq!(parse_cap_rule(None), None);
    }

    #[test]
    fn session_and_lifetime_span_all_history() {
        assert_eq!(period_window_start("session", 1_000.0), 0.0);
        assert_eq!(period_window_start("lifetime", 1_000.0), 0.0);
    }

    #[test]
    fn day_and_week_windows() {
        let now = 1_000_000_000.0;
        assert_eq!(period_window_start("day", now), now - MS_PER_DAY);
        assert_eq!(period_window_start("week", now), now - MS_PER_WEEK);
    }

    #[test]
    fn unrecognized_periods_fall_through_to_month() {
        // Deliberate: the TS has no validation here, and an unknown period
        // must behave as `month` rather than as "no window".
        let now = 1_000_000_000.0;
        assert_eq!(period_window_start("month", now), now - MS_PER_MONTH);
        assert_eq!(period_window_start("fortnight", now), now - MS_PER_MONTH);
        assert_eq!(period_window_start("", now), now - MS_PER_MONTH);
    }

    // ── Plan recommendation ─────────────────────────────────────────────────

    fn plans() -> Vec<Value> {
        vec![
            json!({ "unique_handle": "free", "name": "Free", "tier_position": 0 }),
            json!({ "unique_handle": "starter", "name": "Starter", "tier_position": 1 }),
            json!({ "unique_handle": "pro", "name": "Pro", "tier_position": 2 }),
        ]
    }

    #[test]
    fn recommends_the_next_plan_up_the_ladder() {
        assert_eq!(
            recommend_next_plan_up("free", &plans()).as_deref(),
            Some("starter")
        );
        assert_eq!(
            recommend_next_plan_up("starter", &plans()).as_deref(),
            Some("pro")
        );
    }

    #[test]
    fn nothing_is_recommended_at_the_top_or_off_the_ladder() {
        assert_eq!(
            recommend_next_plan_up("pro", &plans()),
            None,
            "top of ladder"
        );
        assert_eq!(recommend_next_plan_up("unknown", &plans()), None);
        assert_eq!(recommend_next_plan_up("free", &[]), None);
    }

    #[test]
    fn ordering_falls_back_through_sort_order_then_source_id() {
        // Equal tier_position must order deterministically, or the "next" plan
        // depends on array order.
        let tied = vec![
            json!({ "unique_handle": "b", "tier_position": 1, "sort_order": 2 }),
            json!({ "unique_handle": "a", "tier_position": 1, "sort_order": 1 }),
            json!({ "unique_handle": "base", "tier_position": 0 }),
        ];
        assert_eq!(recommend_next_plan_up("base", &tied).as_deref(), Some("a"));
        assert_eq!(recommend_next_plan_up("a", &tied).as_deref(), Some("b"));
    }

    #[test]
    fn custom_strategy_honours_the_override() {
        let t = resolve_recommended_plan_tokens("custom", Some("pro"), "free", &plans());
        assert_eq!(t["recommended_plan_handle"], json!("pro"));
        assert_eq!(t["recommended_plan_name"], json!("Pro"));
    }

    #[test]
    fn every_dead_end_resolves_to_empty_strings() {
        // The top-of-ladder convention: empty, never null or a stale handle.
        let empty = json!({ "recommended_plan_handle": "", "recommended_plan_name": "" });
        for tokens in [
            resolve_recommended_plan_tokens("next_tier_up", None, "pro", &plans()),
            resolve_recommended_plan_tokens("next_tier_up", None, "", &plans()),
            resolve_recommended_plan_tokens("next_tier_up", None, "free", &[]),
            resolve_recommended_plan_tokens("custom", None, "free", &plans()),
            resolve_recommended_plan_tokens("custom", Some(""), "free", &plans()),
            resolve_recommended_plan_tokens("custom", Some("nope"), "free", &plans()),
            // An override equal to the current plan is not an upgrade.
            resolve_recommended_plan_tokens("custom", Some("free"), "free", &plans()),
        ] {
            assert_eq!(Value::Object(tokens), empty);
        }
    }

    #[test]
    fn best_value_falls_back_to_the_hierarchy_until_its_model_ships() {
        let t = resolve_recommended_plan_tokens("best_value", None, "free", &plans());
        assert_eq!(t["recommended_plan_handle"], json!("starter"));
    }

    #[test]
    fn a_plan_with_no_name_reports_its_handle_rather_than_blank() {
        let unnamed = vec![
            json!({ "unique_handle": "base", "tier_position": 0 }),
            json!({ "unique_handle": "next", "tier_position": 1 }),
        ];
        let t = resolve_recommended_plan_tokens("next_tier_up", None, "base", &unnamed);
        assert_eq!(t["recommended_plan_name"], json!("next"));
    }
}
