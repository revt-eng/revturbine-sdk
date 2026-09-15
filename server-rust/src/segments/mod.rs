//! Segment evaluation — predicate-based segment membership resolution.
//!
//! Port of `segments/controllers/segments.ts`. Segments are composed of
//! predicates over user traits; a segment matches when ALL of its predicates
//! are satisfied (AND logic).
//!
//! Segment evaluation was previously browser-only (a plan-33 REQ-14 non-goal).
//! Plan 233 made segment targeting a decision input in every runtime, so
//! evaluation has to agree too: a headless SDK that cannot derive membership
//! cannot make the same selection the browser SDK does.
//!
//! Parity is asserted byte-for-byte by `tests/parity`, which is why the JS
//! coercion semantics below are reproduced deliberately rather than approximated.

use serde_json::Value;
use std::collections::BTreeMap;

/// The trait key carrying the retrieval-derived activity level (plan 180 D5).
pub const ACTIVITY_LEVEL_TRAIT: &str = "activity_level";

/// The levels an authored `active` target matches (plan 180 D1).
pub const ACTIVE_ACTIVITY_LEVELS: [&str; 3] = ["high", "medium", "low"];

/// Whether a derived level satisfies a targeting value.
///
/// `active` matches the union high|medium|low; every other value matches
/// exactly. A non-canonical level string only ever exact-matches (fail closed).
pub fn activity_level_satisfies(target: &str, level: &str) -> bool {
    if target == "active" {
        return ACTIVE_ACTIVITY_LEVELS.contains(&level);
    }
    target == level
}

/// JavaScript `String(value)` coercion.
///
/// Rust's `to_string` on a JSON value diverges on exactly what traits carry:
/// a float `1.0` renders `1.0` where JS gives `1`, and a string would arrive
/// quoted. Both would break byte-identical parity on an equality predicate.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e21 {
                    return format!("{}", f as i64);
                }
            }
            n.to_string()
        }
        other => other.to_string(),
    }
}

/// JavaScript `Number(text)` for the numeric comparison operators.
///
/// Reproduces the coercions that change an outcome: whitespace is trimmed, an
/// empty string is `0`, hex/octal/binary literals parse per JS, and anything
/// unparseable is `NaN` — which makes every comparison false, exactly as in JS.
pub(crate) fn js_number(text: &str) -> f64 {
    let s = text.trim();
    if s.is_empty() {
        return 0.0;
    }
    let lowered = s.to_ascii_lowercase();

    let radix_parse = |body: &str, radix: u32, neg: bool| -> f64 {
        match i64::from_str_radix(body, radix) {
            Ok(v) => {
                if neg {
                    -(v as f64)
                } else {
                    v as f64
                }
            }
            Err(_) => f64::NAN,
        }
    };

    for (prefix, radix) in [("0x", 16u32), ("0o", 8u32), ("0b", 2u32)] {
        if let Some(body) = lowered.strip_prefix(prefix) {
            return radix_parse(body, radix, false);
        }
        if let Some(body) = lowered.strip_prefix(&format!("-{prefix}")) {
            return radix_parse(body, radix, true);
        }
        if let Some(body) = lowered.strip_prefix(&format!("+{prefix}")) {
            return radix_parse(body, radix, false);
        }
    }

    match lowered.as_str() {
        "infinity" | "+infinity" => return f64::INFINITY,
        "-infinity" => return f64::NEG_INFINITY,
        // Rust parses these; JS does not.
        "nan" | "inf" | "-inf" | "+inf" => return f64::NAN,
        _ => {}
    }
    if s.contains('_') {
        return f64::NAN;
    }

    s.parse::<f64>().unwrap_or(f64::NAN)
}

/// Whether one predicate is satisfied by the user's traits.
///
/// A trait the user does not carry fails closed.
pub fn evaluate_predicate(predicate: &Value, traits: &Value) -> bool {
    let field = predicate.get("field").and_then(Value::as_str).unwrap_or("");
    let raw_value = traits.get(field);
    let Some(raw_value) = raw_value else {
        return false;
    };
    if raw_value.is_null() {
        return false;
    }

    let trait_str = js_string(raw_value);
    let target_str = predicate
        .get("value")
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => js_string(other),
        })
        .unwrap_or_default();

    let is_activity_level = field == ACTIVITY_LEVEL_TRAIT;
    let operator = predicate
        .get("operator")
        .and_then(Value::as_str)
        .unwrap_or("");

    match operator {
        "eq" => {
            if is_activity_level {
                activity_level_satisfies(&target_str, &trait_str)
            } else {
                trait_str == target_str
            }
        }
        "neq" => {
            if is_activity_level {
                !activity_level_satisfies(&target_str, &trait_str)
            } else {
                trait_str != target_str
            }
        }
        "gt" => js_number(&trait_str) > js_number(&target_str),
        "lt" => js_number(&trait_str) < js_number(&target_str),
        "gte" => js_number(&trait_str) >= js_number(&target_str),
        "lte" => js_number(&trait_str) <= js_number(&target_str),
        "contains" => trait_str.contains(&target_str),
        "in" => {
            let accepted: Vec<&str> = target_str.split(',').map(str::trim).collect();
            if is_activity_level {
                accepted
                    .iter()
                    .any(|a| activity_level_satisfies(a, &trait_str))
            } else {
                accepted.contains(&trait_str.as_str())
            }
        }
        _ => false,
    }
}

/// Segment **handles** whose predicates all match.
///
/// Returns handles, not minted ids — segment identity is the handle (plan 120),
/// and payload `segment_chips` are matched against these.
///
/// Experiment enrollment (plan 183) is fail-closed: a segment naming an
/// experiment matches only a user the ExperimentProvider assigned to it, and an
/// unassigned user is NOT enrolled — deliberately distinct from being assigned
/// to a control arm. Enrollment alone is a complete rule, so an experiment
/// segment needs no predicates; a trait-based one with no predicates is skipped
/// because it would otherwise match everybody.
pub fn evaluate_segments(
    segments: &[Value],
    traits: &Value,
    assignments: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut matched = Vec::new();

    for segment in segments {
        let predicates: &[Value] = segment
            .get("predicates")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let has_predicates = !predicates.is_empty();

        let experiment_handle = segment
            .get("experiment_handle")
            .and_then(Value::as_str)
            .filter(|h| !h.is_empty());

        let handle = segment
            .get("handle")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        if let Some(experiment_handle) = experiment_handle {
            if !assignments.contains_key(experiment_handle) {
                continue;
            }
            if !has_predicates {
                matched.push(handle);
                continue;
            }
        } else if !has_predicates {
            continue;
        }

        if predicates.iter().all(|p| evaluate_predicate(p, traits)) {
            matched.push(handle);
        }
    }

    matched
}

/// `{segment_handle: experiment_handle}` for segments naming an experiment.
pub fn experiment_by_segment_handle(segments: &[Value]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for segment in segments {
        if let Some(experiment_handle) = segment
            .get("experiment_handle")
            .and_then(Value::as_str)
            .filter(|h| !h.is_empty())
        {
            let handle = segment
                .get("handle")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            out.insert(handle, experiment_handle.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_when_every_predicate_holds() {
        let segments = vec![json!({
            "handle": "power_users",
            "predicates": [{ "field": "plan", "operator": "eq", "value": "pro" }]
        })];
        let matched = evaluate_segments(&segments, &json!({ "plan": "pro" }), &BTreeMap::new());
        assert_eq!(matched, vec!["power_users".to_string()]);
    }

    #[test]
    fn segment_without_predicates_is_skipped() {
        // It would otherwise match everybody.
        let segments = vec![json!({ "handle": "empty" })];
        assert!(evaluate_segments(&segments, &json!({}), &BTreeMap::new()).is_empty());
    }

    #[test]
    fn experiment_segment_is_fail_closed() {
        let segments = vec![json!({ "handle": "exp_seg", "experiment_handle": "exp_a" })];
        assert!(evaluate_segments(&segments, &json!({}), &BTreeMap::new()).is_empty());

        let mut assignments = BTreeMap::new();
        assignments.insert("exp_a".to_string(), "variant_b".to_string());
        assert_eq!(
            evaluate_segments(&segments, &json!({}), &assignments),
            vec!["exp_seg".to_string()]
        );
    }

    #[test]
    fn missing_trait_fails_closed() {
        let p = json!({ "field": "absent", "operator": "eq", "value": "x" });
        assert!(!evaluate_predicate(&p, &json!({})));
    }

    #[test]
    fn boolean_trait_coerces_like_js() {
        let p = json!({ "field": "b", "operator": "eq", "value": "true" });
        assert!(evaluate_predicate(&p, &json!({ "b": true })));
    }

    #[test]
    fn integral_float_renders_without_a_decimal() {
        let p = json!({ "field": "n", "operator": "eq", "value": "3" });
        assert!(evaluate_predicate(&p, &json!({ "n": 3.0 })));
    }

    #[test]
    fn unparseable_number_never_compares_true() {
        for op in ["gt", "lt", "gte", "lte"] {
            let p = json!({ "field": "n", "operator": op, "value": "5" });
            assert!(!evaluate_predicate(&p, &json!({ "n": "abc" })), "{op}");
        }
    }

    #[test]
    fn activity_level_active_matches_the_union() {
        let p = json!({ "field": "activity_level", "operator": "eq", "value": "active" });
        for level in ["high", "medium", "low"] {
            assert!(evaluate_predicate(&p, &json!({ "activity_level": level })));
        }
        assert!(!evaluate_predicate(
            &p,
            &json!({ "activity_level": "inactive" })
        ));
    }

    #[test]
    fn in_operator_trims_the_accepted_list() {
        let p = json!({ "field": "tier", "operator": "in", "value": "a, b ,c" });
        assert!(evaluate_predicate(&p, &json!({ "tier": "b" })));
    }
}
