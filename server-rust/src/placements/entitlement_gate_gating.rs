//! Tier-scoped `entitlement_gate` eligibility.
//!
//! A tier-scoped gate fires only when the user's current tier ranks **strictly
//! below** the trigger's `tier_threshold` on that entitlement's ordered ladder
//! — "one gate for users below Pro, another for users below Enterprise".
//!
//! The ladder is the authored `tier_definitions`, where **array order is
//! rank**. The current tier arrives on the user context and is surfaced onto
//! the entitlements provider state as `tiers`.
//!
//! Source: revturbine-scaffold/src/placements/controllers/entitlement-gate-gating.ts

use std::collections::HashMap;

use serde_json::Value;

/// A tier-scoped entitlement gate.
#[derive(Debug, Clone, PartialEq)]
pub struct EntitlementGateTrigger {
    /// The entitlement whose tier ladder this gate reads.
    pub entitlement_handle: String,
    /// The tier the user must rank below. `None` means the gate is not
    /// tier-scoped and is governed by entitlement status instead.
    pub tier_threshold: Option<String>,
}

/// Whether a tier-scoped `entitlement_gate` placement is eligible.
///
/// # Fail-closed cases (plan 138 Q-4)
///
/// A missing ladder for the entitlement, or a `tier_threshold` that is not on
/// the ladder, means there is **no defensible ordering** — so the gate does not
/// fire. Passing in that situation would show an upgrade prompt derived from a
/// comparison that could not actually be made.
///
/// # Why an unknown current tier fires
///
/// An absent or unrecognized current tier ranks below everything (rank −1). A
/// user holding no tier *is* below every threshold, so the gate correctly
/// fires. That asymmetry with the fail-closed cases is deliberate: here the
/// ordering is well-defined, and the answer is genuinely "below".
///
/// Source: entitlement-gate-gating.ts matchesEntitlementGateTrigger
#[must_use]
pub fn matches_entitlement_gate_trigger(
    trigger: Option<&EntitlementGateTrigger>,
    tier_ladders_by_handle: &HashMap<String, Vec<String>>,
    entitlements: Option<&Value>,
) -> bool {
    // Not an entitlement-gate trigger at all.
    let Some(trigger) = trigger else {
        return true;
    };
    // A gate with no tier boundary is governed by entitlement status, not tier.
    let Some(threshold) = trigger.tier_threshold.as_deref().filter(|t| !t.is_empty()) else {
        return true;
    };

    let Some(ladder) = tier_ladders_by_handle
        .get(&trigger.entitlement_handle)
        .filter(|l| !l.is_empty())
    else {
        return false; // no ladder → fail closed
    };
    let Some(threshold_rank) = ladder.iter().position(|t| t == threshold) else {
        return false; // threshold not on the ladder → fail closed
    };

    let current_tier = entitlements
        .and_then(|e| e.get("tiers"))
        .and_then(|t| t.get(&trigger.entitlement_handle))
        .and_then(Value::as_str);

    let current_rank = current_tier
        .and_then(|t| ladder.iter().position(|l| l == t))
        .map_or(-1_i64, |i| i as i64);

    current_rank < threshold_rank as i64
}
