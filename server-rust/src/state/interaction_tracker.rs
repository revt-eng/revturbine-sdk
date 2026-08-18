//! Dismissal and interaction suppression state.
//!
//! Records dismiss / remind-me-later / CTA interactions and persists the
//! resulting suppression windows through any [`RevTurbineStorage`].
//!
//! Synchronous by design — the storage trait is sync and the decision core
//! performs no I/O.
//!
//! Source: revturbine-scaffold/src/core/state/interaction-tracker.ts

use std::collections::HashMap;

use serde_json::Value;

use crate::state::interaction::{
    interaction_state_key, suppression_for_state, InteractionState, SuppressionResult,
};
use crate::state::storage::RevTurbineStorage;

const STORAGE_PREFIX: &str = "revturbine:interaction-state";

/// Default suppression after a dismissal: 7 days.
pub const DEFAULT_DISMISS_COOLDOWN_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Default suppression after "remind me later": 1 hour.
pub const DEFAULT_REMIND_LATER_MS: i64 = 60 * 60 * 1000;
/// Transient window after a confirmed conversion: 5 minutes.
///
/// Deliberately short — permanence for a completed CTA is owned by impression
/// history, and this only covers the in-flight action.
pub const CTA_SUPPRESSION_MS: i64 = 5 * 60 * 1000;

/// One recorded interaction.
///
/// Source: state/types.ts (RevTurbineTreatmentInteractionInput)
#[derive(Debug, Clone, Default)]
pub struct TreatmentInteractionInput<'a> {
    /// The placement interacted with.
    pub placement_id: &'a str,
    /// The acting user.
    pub user_id: &'a str,
    /// The treatment variant, when the placement has one.
    pub treatment_id: Option<&'a str>,
    /// `dismiss` | `remind_me_later` | `cta_clicked` | `cta_completed`.
    pub interaction_type: &'a str,
    /// ISO-8601 instant to record. Defaults to now.
    pub interaction_at: Option<&'a str>,
    /// Per-interaction overrides: `cooldown_ms`, `remind_after_seconds`.
    pub metadata: Option<&'a Value>,
}

/// Tracks interactions and the suppression windows they open.
///
/// Takes an injectable clock for the same reason [`super::CapEnforcer`] does:
/// suppression is time-dependent, and a fixed clock is what makes window
/// boundaries assertable.
///
/// Source: interaction-tracker.ts:29-150
pub struct InteractionTracker<S: RevTurbineStorage> {
    storage: S,
    tenant_id: String,
    user_id: String,
    default_dismiss_cooldown_ms: i64,
    default_remind_later_ms: i64,
    state: HashMap<String, InteractionState>,
    now_fn: Box<dyn Fn() -> i64 + Send + Sync>,
}

fn system_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Format epoch-ms as JS `new Date(ms).toISOString()` does — millisecond
/// precision, trailing `Z`.
fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map_or_else(
        || "1970-01-01T00:00:00.000Z".to_string(),
        |dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}

/// Coerce a metadata override to a positive finite number, else `None` so the
/// caller falls back to its default.
///
/// Booleans are rejected: TS `typeof === 'number'` is false for them, and
/// coercing would silently read `true` as a 1 ms window.
fn coerce_positive_finite(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite() && *f > 0.0),
        Some(Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite() && *f > 0.0),
        _ => None,
    }
}

impl<S: RevTurbineStorage> InteractionTracker<S> {
    /// Construct with the default windows and the system clock.
    pub fn new(storage: S, tenant_id: &str, user_id: &str) -> Self {
        Self::with_options(
            storage,
            tenant_id,
            user_id,
            DEFAULT_DISMISS_COOLDOWN_MS,
            DEFAULT_REMIND_LATER_MS,
            Box::new(system_now_ms),
        )
    }

    /// Construct with explicit defaults and clock.
    pub fn with_options(
        storage: S,
        tenant_id: &str,
        user_id: &str,
        default_dismiss_cooldown_ms: i64,
        default_remind_later_ms: i64,
        now_fn: Box<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        let mut me = Self {
            storage,
            tenant_id: tenant_id.to_string(),
            user_id: user_id.to_string(),
            default_dismiss_cooldown_ms,
            default_remind_later_ms,
            state: HashMap::new(),
            now_fn,
        };
        me.hydrate();
        me
    }

    /// Record an interaction and update suppression state.
    ///
    /// Prior `suppressed_until` / `last_interaction_type` are carried forward
    /// unless the matched branch overwrites them, mirroring the TS
    /// spread-then-set. An unrecognized interaction type therefore updates the
    /// timestamp and type but leaves any existing window intact.
    ///
    /// Source: interaction-tracker.ts:49-85
    pub fn track(&mut self, input: &TreatmentInteractionInput) {
        let key = interaction_state_key(
            &self.tenant_id,
            input.user_id,
            input.placement_id,
            input.treatment_id,
        );
        let now = (self.now_fn)();
        let metadata = input.metadata;

        let existing = self.state.get(&key).cloned().unwrap_or_default();
        let mut next = InteractionState {
            updated_at: input
                .interaction_at
                .map_or_else(|| iso_from_ms(now), str::to_string),
            suppressed_until: existing.suppressed_until,
            last_interaction_type: Some(input.interaction_type.to_string()),
        };

        match input.interaction_type {
            "dismiss" | "cta_clicked" => {
                // A bare click is not a confirmed conversion, so it takes the
                // dismiss cooldown — the user may still return (plan 167 Q-1).
                let cooldown = coerce_positive_finite(metadata.and_then(|m| m.get("cooldown_ms")))
                    .map_or(self.default_dismiss_cooldown_ms, |v| v as i64);
                next.suppressed_until = Some(now + cooldown);
            }
            "remind_me_later" => {
                let ms =
                    coerce_positive_finite(metadata.and_then(|m| m.get("remind_after_seconds")))
                        .map_or(self.default_remind_later_ms, |secs| (secs * 1000.0) as i64);
                next.suppressed_until = Some(now + ms);
            }
            "cta_completed" => {
                next.suppressed_until = Some(now + CTA_SUPPRESSION_MS);
            }
            _ => {}
        }

        self.state.insert(key, next);
        self.persist();
    }

    /// Whether the placement is currently suppressed by a recent interaction.
    ///
    /// Source: interaction-tracker.ts:88-104
    pub fn check_suppression(
        &self,
        placement_id: &str,
        user_id: &str,
        treatment_id: Option<&str>,
    ) -> SuppressionResult {
        let key = interaction_state_key(&self.tenant_id, user_id, placement_id, treatment_id);
        suppression_for_state(self.state.get(&key), (self.now_fn)())
    }

    /// Drop the per-key suppression state.
    ///
    /// Source: interaction-tracker.ts:107-111
    pub fn clear_suppression(
        &mut self,
        placement_id: &str,
        user_id: &str,
        treatment_id: Option<&str>,
    ) {
        let key = interaction_state_key(&self.tenant_id, user_id, placement_id, treatment_id);
        self.state.remove(&key);
        self.persist();
    }

    /// Load state from storage. Malformed JSON is dropped and the entry
    /// removed.
    ///
    /// Source: interaction-tracker.ts:116-129
    pub fn hydrate(&mut self) {
        let storage_key = self.storage_key();
        let Some(raw) = self.storage.get_item(&storage_key) else {
            return;
        };
        if raw.is_empty() {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            self.storage.remove_item(&storage_key);
            return;
        };
        let Some(obj) = parsed.as_object() else {
            return;
        };
        for (key, value) in obj {
            if let Ok(entry) = serde_json::from_value::<InteractionState>(value.clone()) {
                self.state.insert(key.clone(), entry);
            }
        }
    }

    /// Best-effort write. Failure is swallowed — suppression state is an
    /// optimization and losing it must never fail a decision.
    ///
    /// Source: interaction-tracker.ts:132-139
    pub fn persist(&mut self) {
        if let Ok(json) = serde_json::to_string(&self.state) {
            let key = self.storage_key();
            self.storage.set_item(&key, &json);
        }
    }

    fn storage_key(&self) -> String {
        format!("{STORAGE_PREFIX}:{}:{}", self.tenant_id, self.user_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn iso_matches_javascript_to_iso_string_shape() {
        // Millisecond precision, trailing Z — the shape the TS writes into
        // `updated_at`, which a cross-language diff would otherwise catch.
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn coerce_rejects_booleans_and_non_positive() {
        assert_eq!(coerce_positive_finite(Some(&json!(5))), Some(5.0));
        assert_eq!(coerce_positive_finite(Some(&json!("5"))), Some(5.0));
        assert_eq!(coerce_positive_finite(Some(&json!(0))), None);
        assert_eq!(coerce_positive_finite(Some(&json!(-1))), None);
        // `true` must not read as a 1 ms window.
        assert_eq!(coerce_positive_finite(Some(&json!(true))), None);
        assert_eq!(coerce_positive_finite(Some(&json!(null))), None);
        assert_eq!(coerce_positive_finite(None), None);
    }
}
