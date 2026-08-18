//! Decision result types.
//!
//! Source: revturbine-scaffold/src/core/decisions/types.ts:33-41, mirroring
//! `server-python/src/revturbine/core/decisions/types.py`.

use serde::{Deserialize, Serialize};
use serde_json::Number;

/// The outcome of an entitlement check.
///
/// Optional fields are **omitted** when absent rather than serialized as
/// `null` — that key-absence is the Rust analog of the TypeScript port
/// emitting `undefined`, and the cross-language byte-diff depends on it (the
/// TS side omits `reason` for an enabled feature, so the Rust side must too).
///
/// `limit` / `used` / `remaining` are [`Number`] rather than `f64` so an
/// integral value serializes as `100`, not `100.0`. JavaScript has one number
/// type and drops the trailing `.0`; emitting a float here would diverge on
/// every limit-bearing result. Build them with [`int_if_integral`].
///
/// Source: types.ts:33-41 (EntitlementCheckResult)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntitlementCheckResult {
    /// `allowed` | `denied` | `limited`. Note that `limited` does NOT imply
    /// denial — the `degrade` enforcement mode is limited *and* allowed.
    pub status: String,
    /// Whether the caller may proceed. This, not `status`, is the gate.
    pub allowed: bool,
    /// Machine-readable cause, present only when there is one to give.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The governing limit, on limit-bearing outcomes only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<Number>,
    /// Consumption counted against `limit`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<Number>,
    /// `max(0, limit - used)` — never negative, even under `allow_overage`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining: Option<Number>,
    /// Emitted by the `capability_tier` branch (plan 33 TASK-13).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_tier: Option<String>,
}

impl EntitlementCheckResult {
    /// `{status, allowed}` with every optional field absent.
    #[must_use]
    pub fn new(status: &str, allowed: bool) -> Self {
        Self {
            status: status.to_string(),
            allowed,
            reason: None,
            limit: None,
            used: None,
            remaining: None,
            current_tier: None,
        }
    }

    /// `{status, allowed, reason}`.
    #[must_use]
    pub fn with_reason(status: &str, allowed: bool, reason: &str) -> Self {
        let mut r = Self::new(status, allowed);
        r.reason = Some(reason.to_string());
        r
    }
}

/// Build a JSON number that serializes as an integer when the value is whole.
///
/// JS serializes integral numbers without a decimal point (`100`); a Rust
/// `f64` would emit `100.0`. Non-finite input yields `None` — callers must not
/// reach this with NaN/±∞ (see `tests/parity/rust_runner`'s
/// `normalize_number`).
///
/// Source: entitlement-check.ts (the `withLimitFields` numeric shaping);
/// mirrors `server-python`'s `_int_if_integral`.
#[must_use]
pub fn int_if_integral(value: f64) -> Option<Number> {
    if !value.is_finite() {
        return None;
    }
    if value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        return Some(Number::from(value as i64));
    }
    Number::from_f64(value)
}
