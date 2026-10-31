//! Segment mode and dimension inference (ST-1391, fixes BUG-1389).
//!
//! Port of `@revt-eng/core`'s `segments/controllers/segment-mode.ts`. A
//! segment's dimension and basic/advanced mode are read from its predicates, so
//! a stored `dimension_id` can no longer decide how a rule's `segment_ids`
//! combine (an upload that rewrote every id to one placeholder turned
//! AND-across-dimensions into a flat OR).
//!
//! ```text
//! fields  = distinct predicate.field, in order of first appearance
//! mode    = segment.mode ?? (every operator in {eq, in} ? basic : advanced)
//! dim_key = mode == basic && fields.len() == 1
//!             ? ("rt_<key>" -> "rt.<key>", else the field itself)
//!             : segment.dimension_id (non-empty) or None   // None -> __no_dim__
//! ```
//!
//! Parity with the TS and Python helpers is asserted by `tests/parity`.
//!
//! Source: segments/controllers/segment-mode.ts

use serde_json::{json, Map, Value};
use std::collections::HashMap;

const BUILTIN_TRAIT_PREFIX: &str = "rt_";
const BUILTIN_DIMENSION_PREFIX: &str = "rt.";

/// The two segment modes, in declaration order.
pub const SEGMENT_MODES: [&str; 2] = ["basic", "advanced"];

/// The operators a basic segment may use.
pub const BASIC_SEGMENT_OPERATORS: [&str; 2] = ["eq", "in"];

/// Result of [`classify_segment`] (mirrors the TS `SegmentClassification`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentClassification {
    /// `"basic"` or `"advanced"`: the explicit `mode`, else inferred.
    pub mode: &'static str,
    /// True when the segment carried no valid `mode`.
    pub mode_inferred: bool,
    /// The key the rule matcher buckets this segment under; `None` is the
    /// shared no-dimension bucket.
    pub dimension_key: Option<String>,
    /// True when `dimension_key` was derived from the single predicate field.
    pub dimension_derived: bool,
    /// Distinct predicate fields, in order of first appearance.
    pub fields: Vec<String>,
    /// The stored `dimension_id`, when it is a non-empty string.
    pub declared_dimension_id: Option<String>,
    /// A declared `dimension_id` disagrees with the derived key.
    pub dimension_mismatch: bool,
}

/// True for an operator a basic segment may carry.
#[must_use]
pub fn is_basic_segment_operator(operator: Option<&str>) -> bool {
    matches!(operator, Some("eq" | "in"))
}

/// The dimension key a single predicate field implies: `rt_<key>` -> `rt.<key>`.
#[must_use]
pub fn dimension_key_for_field(field: &str) -> String {
    match field.strip_prefix(BUILTIN_TRAIT_PREFIX) {
        Some(rest) if !rest.is_empty() => format!("{BUILTIN_DIMENSION_PREFIX}{rest}"),
        _ => field.to_string(),
    }
}

fn predicates_of(segment: &Value) -> Vec<&Value> {
    segment
        .get("predicates")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|p| p.is_object()).collect())
        .unwrap_or_default()
}

/// Infer a mode from predicates alone (ignores `mode`). Empty -> basic.
#[must_use]
pub fn infer_segment_mode(segment: &Value) -> &'static str {
    let basic = predicates_of(segment)
        .iter()
        .all(|p| is_basic_segment_operator(p.get("operator").and_then(Value::as_str)));
    if basic {
        "basic"
    } else {
        "advanced"
    }
}

/// Classify one segment: its mode, rule-matcher dimension key and mismatch.
#[must_use]
pub fn classify_segment(segment: &Value) -> SegmentClassification {
    let mut fields: Vec<String> = Vec::new();
    for p in predicates_of(segment) {
        if let Some(field) = p.get("field").and_then(Value::as_str) {
            if !fields.iter().any(|f| f == field) {
                fields.push(field.to_string());
            }
        }
    }

    let explicit = match segment.get("mode").and_then(Value::as_str) {
        Some("basic") => Some("basic"),
        Some("advanced") => Some("advanced"),
        _ => None,
    };
    let mode = explicit.unwrap_or_else(|| infer_segment_mode(segment));

    let declared = segment
        .get("dimension_id")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        .map(str::to_string);

    let derived = mode == "basic" && fields.len() == 1;
    let dimension_key = if derived {
        Some(dimension_key_for_field(&fields[0]))
    } else {
        declared.clone()
    };
    let mismatch = derived && declared.is_some() && declared != dimension_key;

    SegmentClassification {
        mode,
        mode_inferred: explicit.is_none(),
        dimension_key,
        dimension_derived: derived,
        fields,
        declared_dimension_id: declared,
        dimension_mismatch: mismatch,
    }
}

/// `{segment_handle: dimension_key}` for every segment with a key. Segments
/// without a key are omitted (they share the no-dimension bucket).
#[must_use]
pub fn segment_dimension_keys(segments: &[Value]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for segment in segments {
        let Some(handle) = segment.get("handle").and_then(Value::as_str) else {
            continue;
        };
        if let Some(key) = classify_segment(segment).dimension_key {
            out.insert(handle.to_string(), key);
        }
    }
    out
}

/// Merge same-field basic `eq`/`in` predicates into one `in` predicate.
///
/// `Err(reason)` when a comma or surrounding whitespace in an `eq` value makes
/// the merge lossy. Advanced segments and segments with no repeated field are
/// returned unchanged.
pub fn canonicalize_segment_predicates(segment: &Value) -> Result<Value, String> {
    if classify_segment(segment).mode != "basic" {
        return Ok(segment.clone());
    }
    let predicates: &[Value] = segment
        .get("predicates")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    let field_of = |p: &Value| p.get("field").and_then(Value::as_str).map(str::to_string);

    let mut count_by_field: HashMap<String, usize> = HashMap::new();
    for p in predicates {
        if let Some(field) = field_of(p) {
            *count_by_field.entry(field).or_default() += 1;
        }
    }
    if !count_by_field.values().any(|n| *n > 1) {
        return Ok(segment.clone());
    }

    let mut values_by_field: HashMap<String, Vec<String>> = HashMap::new();
    for p in predicates {
        let Some(field) = field_of(p) else { continue };
        if count_by_field.get(&field).copied().unwrap_or(0) < 2 {
            continue;
        }
        let Some(value) = p.get("value").and_then(Value::as_str) else {
            return Err(format!(
                "predicate on field \"{field}\" has a non-string value"
            ));
        };
        let values = values_by_field.entry(field.clone()).or_default();
        if p.get("operator").and_then(Value::as_str) == Some("in") {
            for item in value.split(',').map(str::trim) {
                if !values.iter().any(|v| v == item) {
                    values.push(item.to_string());
                }
            }
        } else {
            if value.contains(',') {
                return Err(format!(
                    "basic segment repeats field \"{field}\" and its value \"{value}\" contains a comma, so the predicates cannot be merged into one \"in\" list"
                ));
            }
            if value != value.trim() {
                return Err(format!(
                    "basic segment repeats field \"{field}\" and its value \"{value}\" has surrounding whitespace, which an \"in\" list would trim"
                ));
            }
            if !values.iter().any(|v| v == value) {
                values.push(value.to_string());
            }
        }
    }

    let mut emitted: Vec<String> = Vec::new();
    let mut merged: Vec<Value> = Vec::new();
    for p in predicates {
        match field_of(p) {
            Some(field) if count_by_field.get(&field).copied().unwrap_or(0) >= 2 => {
                if emitted.contains(&field) {
                    continue;
                }
                let joined = values_by_field
                    .get(&field)
                    .map(|v| v.join(","))
                    .unwrap_or_default();
                merged.push(json!({ "field": field, "operator": "in", "value": joined }));
                emitted.push(field);
            }
            _ => merged.push(p.clone()),
        }
    }
    let mut out: Map<String, Value> = segment.as_object().cloned().unwrap_or_default();
    out.insert("predicates".to_string(), Value::Array(merged));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_field_basic_derives_key() {
        let seg = json!({
            "handle": "pro",
            "dimension_id": "dim_imported_t",
            "predicates": [{ "field": "plan", "operator": "eq", "value": "pro" }]
        });
        let c = classify_segment(&seg);
        assert_eq!(c.mode, "basic");
        assert_eq!(c.dimension_key.as_deref(), Some("plan"));
        assert!(c.dimension_mismatch);
    }

    #[test]
    fn builtin_trait_maps_to_rt_dimension() {
        let seg = json!({
            "handle": "emea",
            "predicates": [{ "field": "rt_region", "operator": "eq", "value": "emea" }]
        });
        assert_eq!(
            classify_segment(&seg).dimension_key.as_deref(),
            Some("rt.region")
        );
        assert_eq!(dimension_key_for_field("rt_"), "rt_");
    }

    #[test]
    fn multi_field_and_advanced_use_declared_id() {
        let multi = json!({
            "handle": "m", "dimension_id": "d1",
            "predicates": [
                { "field": "a", "operator": "eq", "value": "1" },
                { "field": "b", "operator": "eq", "value": "2" }
            ]
        });
        assert_eq!(
            classify_segment(&multi).dimension_key.as_deref(),
            Some("d1")
        );
        let adv = json!({
            "handle": "a", "dimension_id": "d2",
            "predicates": [{ "field": "seats", "operator": "gte", "value": "10" }]
        });
        let c = classify_segment(&adv);
        assert_eq!(c.mode, "advanced");
        assert_eq!(c.dimension_key.as_deref(), Some("d2"));
        let bare = json!({
            "handle": "b",
            "predicates": [{ "field": "seats", "operator": "gte", "value": "10" }]
        });
        assert_eq!(classify_segment(&bare).dimension_key, None);
    }

    #[test]
    fn explicit_mode_wins() {
        let seg = json!({
            "handle": "x", "mode": "advanced",
            "predicates": [{ "field": "plan", "operator": "eq", "value": "pro" }]
        });
        let c = classify_segment(&seg);
        assert_eq!(c.mode, "advanced");
        assert!(!c.mode_inferred);
        assert_eq!(c.dimension_key, None);
    }

    #[test]
    fn dimension_keys_omit_keyless_segments() {
        let segs = vec![
            json!({ "handle": "pro", "predicates": [{ "field": "plan", "operator": "eq", "value": "pro" }] }),
            json!({ "handle": "empty", "predicates": [] }),
        ];
        let keys = segment_dimension_keys(&segs);
        assert_eq!(keys.get("pro").map(String::as_str), Some("plan"));
        assert!(!keys.contains_key("empty"));
    }

    #[test]
    fn canonicalize_merges_repeated_field() {
        let seg = json!({
            "handle": "s",
            "predicates": [
                { "field": "plan", "operator": "eq", "value": "pro" },
                { "field": "region", "operator": "eq", "value": "us" },
                { "field": "plan", "operator": "in", "value": "team,pro" }
            ]
        });
        let out = canonicalize_segment_predicates(&seg).unwrap();
        assert_eq!(
            out["predicates"],
            json!([
                { "field": "plan", "operator": "in", "value": "pro,team" },
                { "field": "region", "operator": "eq", "value": "us" }
            ])
        );
    }

    #[test]
    fn canonicalize_refuses_comma_and_whitespace() {
        let comma = json!({ "predicates": [
            { "field": "p", "operator": "eq", "value": "a,b" },
            { "field": "p", "operator": "eq", "value": "c" }
        ]});
        assert!(canonicalize_segment_predicates(&comma).is_err());
        let ws = json!({ "predicates": [
            { "field": "p", "operator": "eq", "value": " a" },
            { "field": "p", "operator": "eq", "value": "c" }
        ]});
        assert!(canonicalize_segment_predicates(&ws).is_err());
    }
}
