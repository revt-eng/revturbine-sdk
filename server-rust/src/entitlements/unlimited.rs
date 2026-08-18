//! Canonical "unlimited" limit handling.
//!
//! "Unlimited" was historically spelled three ways: the string `"unlimited"`
//! (legacy authoring + live evaluator), `null`/absent (IR + compiled-bundle
//! convention), and the numeric sentinel `999999` (seed/demo display
//! convention). Plan 72 makes all three resolve to the same enforced result:
//! infinite, never a literal 999,999 cap. This module is the ONE place the
//! notion lives — never re-spell it inline.
//!
//! Source: revturbine-scaffold/src/entitlements/unlimited.ts

use serde_json::Value;

/// Seed/demo-data numeric sentinel meaning "unlimited" (plan 63 REQ-7 / 70).
pub const UNLIMITED_SENTINEL: f64 = 999_999.0;

/// True when a stored limit-like value means "unlimited": absent, `null`, the
/// string `"unlimited"`, or the `999999` sentinel.
///
/// `None` and `Some(Value::Null)` are treated identically — Python's
/// `dict.get` collapses absent and null the same way, and the TS side sees
/// `undefined` for both.
///
/// Source: unlimited.ts (isUnlimitedLimit)
#[must_use]
pub fn is_unlimited_limit(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s == "unlimited",
        // Booleans are deliberately excluded: JS `true === 999999` is false.
        // (Python needed an explicit guard here because `True == 1`; Rust's
        // Value::Bool simply isn't a Number, so the arm below cannot match.)
        Some(Value::Number(n)) => n.as_f64() == Some(UNLIMITED_SENTINEL),
        _ => false,
    }
}

/// Resolve a stored limit-like value (`limit_value` / `allowance` /
/// `included_count`) to the number used for enforcement and permissiveness
/// scoring: unlimited → `+∞`; a finite number → itself; anything else → `None`
/// (not a usable limit).
///
/// A numeric *string* is junk and yields `None` — it is never coerced and
/// enforced.
///
/// Source: unlimited.ts (resolveLimitValue)
#[must_use]
pub fn resolve_limit_value(value: Option<&Value>) -> Option<f64> {
    if is_unlimited_limit(value) {
        return Some(f64::INFINITY);
    }
    match value {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn all_three_spellings_of_unlimited() {
        assert!(is_unlimited_limit(None));
        assert!(is_unlimited_limit(Some(&json!(null))));
        assert!(is_unlimited_limit(Some(&json!("unlimited"))));
        assert!(is_unlimited_limit(Some(&json!(999_999))));
    }

    #[test]
    fn booleans_are_not_the_sentinel() {
        // Guards the Python port's stated hazard (`True == 1`) staying absent
        // in Rust rather than merely untested.
        assert!(!is_unlimited_limit(Some(&json!(true))));
        assert!(!is_unlimited_limit(Some(&json!(false))));
    }

    #[test]
    fn finite_numbers_pass_through() {
        assert_eq!(resolve_limit_value(Some(&json!(10))), Some(10.0));
        assert_eq!(resolve_limit_value(Some(&json!(0))), Some(0.0));
        assert_eq!(resolve_limit_value(Some(&json!(2.5))), Some(2.5));
    }

    #[test]
    fn unlimited_resolves_to_infinity() {
        assert_eq!(resolve_limit_value(None), Some(f64::INFINITY));
        assert_eq!(
            resolve_limit_value(Some(&json!("unlimited"))),
            Some(f64::INFINITY)
        );
        assert_eq!(
            resolve_limit_value(Some(&json!(999_999))),
            Some(f64::INFINITY)
        );
    }

    #[test]
    fn numeric_strings_are_junk_not_limits() {
        // Explicitly NOT coerced — a "10" must not become an enforced cap.
        assert_eq!(resolve_limit_value(Some(&json!("10"))), None);
        assert_eq!(resolve_limit_value(Some(&json!(true))), None);
        assert_eq!(resolve_limit_value(Some(&json!([1]))), None);
    }
}
