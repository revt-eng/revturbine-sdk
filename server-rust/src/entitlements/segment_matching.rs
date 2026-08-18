//! Plan #39 REQ-8 — intra-dimension OR + cross-dimension AND.
//!
//! Both callers — `entitlement_check::derive_local_entitlement_from_configured_rules`
//! and `rules::evaluate_entitlement_rules` — route through
//! [`matches_rule_segments`] so the algorithm exists exactly once.
//!
//! # Algorithm
//!
//! 1. Empty `rule_segment_ids` → match all users.
//! 2. Look up each segment's dimension; segments without a known dimension
//!    bucket into `__no_dim__` (flat-OR back-compat for pre-PR-B exports that
//!    lack `segment.dimension_id`).
//! 3. Group the rule's segment IDs by dimension.
//! 4. The rule matches when **every** bucket has at least one ID in the user's
//!    segment set — a cross-AND of intra-OR groups.
//!
//! Source: revturbine-scaffold/src/entitlements/controllers/segment-matching.ts

use std::collections::{HashMap, HashSet};

const NO_DIMENSION_BUCKET: &str = "__no_dim__";

/// True iff a rule's segment scope matches the user.
///
/// `rule_segment_ids` of `None` — or an empty slice — matches all users.
/// `segment_dimensions` maps `segment_id -> dimension_id`; segments missing
/// from it fall into the `__no_dim__` bucket.
///
/// Source: segment-matching.ts (matchesRuleSegments)
#[must_use]
pub fn matches_rule_segments(
    rule_segment_ids: Option<&[String]>,
    user_segments: &HashSet<String>,
    segment_dimensions: &HashMap<String, String>,
) -> bool {
    let Some(rule_ids) = rule_segment_ids else {
        return true;
    };
    if rule_ids.is_empty() {
        return true;
    }

    let mut buckets: HashMap<&str, Vec<&String>> = HashMap::new();
    for seg_id in rule_ids {
        let dim = segment_dimensions
            .get(seg_id)
            .map_or(NO_DIMENSION_BUCKET, String::as_str);
        // An empty-string dimension is treated as "no dimension", mirroring
        // the Python `dim or _NO_DIMENSION_BUCKET` fallback.
        let dim = if dim.is_empty() {
            NO_DIMENSION_BUCKET
        } else {
            dim
        };
        buckets.entry(dim).or_default().push(seg_id);
    }

    buckets
        .values()
        .all(|bucket| bucket.iter().any(|id| user_segments.contains(*id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }
    fn set(v: &[&str]) -> HashSet<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }
    fn dims(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(a, b)| ((*a).to_string(), (*b).to_string()))
            .collect()
    }

    #[test]
    fn empty_or_absent_scope_matches_everyone() {
        assert!(matches_rule_segments(None, &set(&[]), &dims(&[])));
        assert!(matches_rule_segments(Some(&[]), &set(&[]), &dims(&[])));
    }

    #[test]
    fn flat_or_when_no_dimension_data() {
        // Pre-PR-B back-compat: undimensioned segments share one bucket, so
        // ANY overlap matches.
        let rule = ids(&["s1", "s2"]);
        assert!(matches_rule_segments(
            Some(&rule),
            &set(&["s2"]),
            &dims(&[])
        ));
        assert!(!matches_rule_segments(
            Some(&rule),
            &set(&["s3"]),
            &dims(&[])
        ));
    }

    #[test]
    fn intra_dimension_is_or() {
        let rule = ids(&["s1", "s2"]);
        let d = dims(&[("s1", "geo"), ("s2", "geo")]);
        assert!(matches_rule_segments(Some(&rule), &set(&["s1"]), &d));
        assert!(matches_rule_segments(Some(&rule), &set(&["s2"]), &d));
    }

    #[test]
    fn cross_dimension_is_and() {
        // The load-bearing case: one dimension satisfied is NOT enough.
        let rule = ids(&["geo_us", "tier_pro"]);
        let d = dims(&[("geo_us", "geo"), ("tier_pro", "tier")]);
        assert!(!matches_rule_segments(Some(&rule), &set(&["geo_us"]), &d));
        assert!(!matches_rule_segments(Some(&rule), &set(&["tier_pro"]), &d));
        assert!(matches_rule_segments(
            Some(&rule),
            &set(&["geo_us", "tier_pro"]),
            &d
        ));
    }

    #[test]
    fn mixed_dimensioned_and_undimensioned() {
        // `__no_dim__` behaves as its own bucket, so it must also be satisfied.
        let rule = ids(&["geo_us", "legacy"]);
        let d = dims(&[("geo_us", "geo")]);
        assert!(!matches_rule_segments(Some(&rule), &set(&["geo_us"]), &d));
        assert!(matches_rule_segments(
            Some(&rule),
            &set(&["geo_us", "legacy"]),
            &d
        ));
    }
}
