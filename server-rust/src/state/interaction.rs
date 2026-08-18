//! Pure interaction helpers and their state types.
//!
//! Standalone functions complementing the stateful
//! [`super::interaction_tracker::InteractionTracker`], for callers that want
//! to compute a key or evaluate suppression without instantiating the tracker.
//!
//! Source: revturbine-scaffold/src/core/state/interaction.ts

use serde::{Deserialize, Serialize};

/// Persisted per-(tenant, user, placement, treatment) interaction state.
///
/// Source: state/types.ts (InteractionState)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct InteractionState {
    /// ISO-8601 instant of the last recorded interaction.
    pub updated_at: String,
    /// Epoch-ms instant before which this placement is suppressed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppressed_until: Option<i64>,
    /// The interaction that produced the current suppression window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_interaction_type: Option<String>,
}

/// Whether a placement is currently suppressed, and why.
///
/// Source: state/types.ts (SuppressionResult)
#[derive(Debug, Clone, PartialEq)]
pub struct SuppressionResult {
    /// True when the placement must not be shown right now.
    pub suppressed: bool,
    /// Cause, present only when suppressed.
    pub reason: Option<String>,
}

impl SuppressionResult {
    /// Not suppressed, no reason.
    #[must_use]
    pub fn allowed() -> Self {
        Self {
            suppressed: false,
            reason: None,
        }
    }
}

/// The deterministic key used to look up suppression state.
///
/// An absent treatment collapses to the literal `"default"`, so
/// treatment-less placements share one slot rather than one per `None`.
///
/// Source: interaction.ts:14-26 (interactionStateKey)
#[must_use]
pub fn interaction_state_key(
    tenant_id: &str,
    user_id: &str,
    placement_id: &str,
    treatment_id: Option<&str>,
) -> String {
    format!(
        "{tenant_id}:{user_id}:{placement_id}:{}",
        treatment_id.filter(|t| !t.is_empty()).unwrap_or("default")
    )
}

/// Evaluate whether `state` suppresses right now.
///
/// The boundary is **not** suppressed: `suppressed_until <= now` releases. That
/// matches the TS `now > suppressedUntil` test, and matters because a window
/// computed as `now + cooldown` must expire exactly when it says it does.
///
/// Source: interaction.ts:29-41 (suppressionForState)
#[must_use]
pub fn suppression_for_state(state: Option<&InteractionState>, now_ms: i64) -> SuppressionResult {
    let Some(state) = state else {
        return SuppressionResult::allowed();
    };
    let Some(until) = state.suppressed_until else {
        return SuppressionResult::allowed();
    };
    if until <= now_ms {
        return SuppressionResult::allowed();
    }
    let reason = if state.last_interaction_type.as_deref() == Some("remind_me_later") {
        "suppressed_until_remind_window"
    } else {
        "suppressed_by_dismiss_cooldown"
    };
    SuppressionResult {
        suppressed: true,
        reason: Some(reason.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(until: Option<i64>, kind: Option<&str>) -> InteractionState {
        InteractionState {
            updated_at: "2026-08-17T00:00:00.000Z".into(),
            suppressed_until: until,
            last_interaction_type: kind.map(str::to_string),
        }
    }

    #[test]
    fn key_collapses_absent_treatment_to_default() {
        assert_eq!(
            interaction_state_key("t1", "u1", "pl_1", None),
            "t1:u1:pl_1:default"
        );
        assert_eq!(
            interaction_state_key("t1", "u1", "pl_1", Some("tr_a")),
            "t1:u1:pl_1:tr_a"
        );
        // An empty treatment is absent, not a distinct slot.
        assert_eq!(
            interaction_state_key("t1", "u1", "pl_1", Some("")),
            "t1:u1:pl_1:default"
        );
    }

    #[test]
    fn absent_state_or_window_is_not_suppressed() {
        assert!(!suppression_for_state(None, 100).suppressed);
        assert!(!suppression_for_state(Some(&state(None, Some("dismiss"))), 100).suppressed);
    }

    #[test]
    fn the_expiry_boundary_releases_rather_than_suppresses() {
        // `<= now` releases. A window built as `now + cooldown` must expire
        // exactly when it says, so off-by-one here would extend every
        // suppression by a tick.
        let s = state(Some(100), Some("dismiss"));
        assert!(suppression_for_state(Some(&s), 99).suppressed);
        assert!(!suppression_for_state(Some(&s), 100).suppressed);
        assert!(!suppression_for_state(Some(&s), 101).suppressed);
    }

    #[test]
    fn reason_distinguishes_remind_me_later_from_dismiss() {
        let remind = state(Some(1_000), Some("remind_me_later"));
        assert_eq!(
            suppression_for_state(Some(&remind), 0).reason.as_deref(),
            Some("suppressed_until_remind_window")
        );

        for kind in [Some("dismiss"), Some("cta_clicked"), None] {
            let other = state(Some(1_000), kind);
            assert_eq!(
                suppression_for_state(Some(&other), 0).reason.as_deref(),
                Some("suppressed_by_dismiss_cooldown"),
                "{kind:?} should report the dismiss reason",
            );
        }
    }
}
