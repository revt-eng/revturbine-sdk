//! Usage / credit / seat threshold eligibility.
//!
//! All three gate on percent **consumed**:
//!
//! - `usage_threshold` — `used / limit * 100`
//! - `credit_threshold` — `(allocation − balance) / allocation * 100`
//! - `seat_threshold` — `seats_filled / seat_limit * 100`
//!
//! Credits pass the **remaining** balance, not the consumed amount; the
//! percentage is derived here. Percent is deliberately **not clamped** to 100 —
//! the "Exceeded" direction is meaningful. Thresholds evaluate at the
//! entitlement's Allocation level.
//!
//! Source: revturbine-scaffold/src/placements/controllers/threshold-gating.ts

use serde_json::Value;

/// A threshold trigger.
#[derive(Debug, Clone, PartialEq)]
pub struct ThresholdTrigger {
    /// `usage_threshold` | `credit_threshold` | `seat_threshold`.
    pub kind: String,
    /// The entitlement whose counters are measured.
    pub entitlement_handle: String,
    /// The percent at or above which the trigger fires.
    pub threshold_percent: f64,
}

/// A finite number field, rejecting booleans (serde declines them already).
fn num(obj: &Value, key: &str) -> Option<f64> {
    obj.get(key)
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite())
}

/// Pick the grant whose counters the threshold is measured against, per the
/// entitlement's Allocation ("Pooling").
///
/// The declared grant is found by precedence (user → instance → account), then
/// its `allocation` redirects to the level that actually owns the counters.
///
/// Source: threshold-gating.ts grantForAllocation
fn grant_for_allocation<'a>(handle: &str, state: &'a Value) -> Option<&'a Value> {
    let grants = state.get("grants")?;
    let at = |level: &str| {
        grants
            .get(level)
            .and_then(|lv| lv.get(handle))
            .filter(|e| e.is_object())
    };

    let declared = at("user")
        .or_else(|| at("instance"))
        .or_else(|| at("account"))?;

    match declared.get("allocation").and_then(Value::as_str) {
        Some("account_pool" | "per_user_pooled") => at("account").or(Some(declared)),
        Some("per_instance") => at("instance").or(Some(declared)),
        Some("per_user") => at("user").or(Some(declared)),
        _ => Some(declared),
    }
}

struct Counters {
    used: f64,
    limit: f64,
    remaining: Option<f64>,
}

/// The allocation-scoped grant when one carries a limit, else the flat usage
/// map.
///
/// Source: threshold-gating.ts resolveCounters
fn resolve_counters(handle: &str, state: &Value) -> Option<Counters> {
    if let Some(grant) = grant_for_allocation(handle, state) {
        if let Some(limit) = num(grant, "limit") {
            return Some(Counters {
                // An absent `used` on a grant that declares a limit means zero
                // consumed, not "indeterminate".
                used: num(grant, "used").unwrap_or(0.0),
                limit,
                remaining: None,
            });
        }
    }

    let entry = state.get("usage")?.get(handle)?;
    let limit = num(entry, "limit")?;
    Some(Counters {
        used: num(entry, "used").unwrap_or(0.0),
        limit,
        remaining: num(entry, "remaining"),
    })
}

/// Percent of the allocation consumed, or `None` when it cannot be determined
/// (no state, no limit, non-positive limit). **Not clamped.**
///
/// Source: threshold-gating.ts computeConsumedPercent
#[must_use]
pub fn compute_consumed_percent(
    trigger: &ThresholdTrigger,
    entitlements: Option<&Value>,
) -> Option<f64> {
    let state = entitlements.filter(|e| e.is_object())?;
    let counters = resolve_counters(&trigger.entitlement_handle, state)?;

    if !counters.limit.is_finite() || counters.limit <= 0.0 {
        return None;
    }

    // Credits report what is LEFT, so consumption is the complement.
    if trigger.kind == "credit_threshold" {
        if let Some(remaining) = counters.remaining {
            return Some(((counters.limit - remaining) / counters.limit) * 100.0);
        }
    }

    if !counters.used.is_finite() {
        return None;
    }
    Some((counters.used / counters.limit) * 100.0)
}

/// Whether a threshold-triggered placement is eligible.
///
/// Non-threshold triggers pass through. Fires when consumed percent is **at or
/// above** the configured threshold, and **fails closed** when consumption
/// cannot be determined — an upgrade prompt driven by unknown usage is worse
/// than none.
///
/// Source: threshold-gating.ts matchesThresholdTrigger
#[must_use]
pub fn matches_threshold_trigger(
    trigger: Option<&ThresholdTrigger>,
    entitlements: Option<&Value>,
) -> bool {
    let Some(trigger) = trigger else {
        return true;
    };
    compute_consumed_percent(trigger, entitlements)
        .is_some_and(|consumed| consumed >= trigger.threshold_percent)
}
