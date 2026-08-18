//! Impression-history vocabulary, records, and the store trait.
//!
//! Tracks placement impressions and the interactions that follow, so the
//! decision engine can exclude placements the user has already acted on.
//!
//! Source: revturbine-scaffold/src/core/state/impression-history-types.ts

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Outcomes that **permanently** prevent re-presentation.
///
/// Only a confirmed conversion is terminal. `dismissed`, `clicked_thru` and
/// `suppressed` are all **time-boxed** — they carry a `suppressUntil` window
/// and the placement returns when it elapses (plan 167 Q-1). Treating a
/// dismissal as permanent is the classic way to make this wrong.
///
/// Source: impression-history-types.ts:31-34
pub const TERMINAL_OUTCOMES: &[&str] = &["cta_completed"];

/// Default time-based suppression: 24 hours.
///
/// Source: impression-history-types.ts:37
pub const DEFAULT_SUPPRESSION_MS: i64 = 24 * 60 * 60 * 1000;

/// Default dismiss cooldown: 7 days. Mirrors `cooldown_after_dismiss_days`,
/// and applies to `dismissed` and bare `clicked_thru` when no explicit window
/// is given.
///
/// Source: impression-history-types.ts:37
pub const DEFAULT_DISMISS_COOLDOWN_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// A single impression / interaction record.
///
/// Source: impression-history-types.ts:46-59
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImpressionRecord {
    /// The placement this record concerns.
    pub placement_id: String,
    /// `impressed` | `dismissed` | `clicked_thru` | `cta_completed` | `suppressed`.
    pub outcome: String,
    /// ISO-8601 instant the interaction occurred.
    pub occurred_at: String,
    /// The specific payload shown, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_id: Option<String>,
    /// The surface template used, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_template_id: Option<String>,
    /// Free-form extras. Carries `suppressUntil` for time-boxed outcomes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl ImpressionRecord {
    /// A minimal record; optional fields start empty.
    #[must_use]
    pub fn new(placement_id: &str, outcome: &str, occurred_at: &str) -> Self {
        Self {
            placement_id: placement_id.to_string(),
            outcome: outcome.to_string(),
            occurred_at: occurred_at.to_string(),
            payload_id: None,
            surface_template_id: None,
            metadata: None,
        }
    }

    /// Whether this outcome retires the placement permanently.
    #[must_use]
    pub fn is_terminal(&self) -> bool {
        TERMINAL_OUTCOMES.contains(&self.outcome.as_str())
    }
}

/// Optional filter for a history query.
///
/// Source: impression-history-types.ts:65-72
#[derive(Debug, Clone, Default)]
pub struct ImpressionQuery {
    /// Restrict to these placements.
    pub placement_ids: Option<Vec<String>>,
    /// Restrict to these outcomes.
    pub outcomes: Option<Vec<String>>,
    /// Restrict to records at or after this ISO-8601 instant.
    pub since: Option<String>,
}

/// Pluggable persistence backend for impression history.
///
/// The TS `void | Promise<void>` returns collapse to plain sync here — the
/// decision core performs no I/O.
///
/// Source: impression-history-types.ts:87-113
pub trait ImpressionHistoryStore {
    /// Append one record for a user.
    fn append(&mut self, user_id: &str, record: ImpressionRecord);
    /// Query a user's records, most-recent first.
    fn query(&self, user_id: &str, query: Option<&ImpressionQuery>) -> Vec<ImpressionRecord>;
    /// Placements permanently retired for this user.
    fn get_retired_placement_ids(&self, user_id: &str) -> std::collections::HashSet<String>;
    /// Placements currently within a suppression window, mapped to its expiry.
    fn get_suppressed_placements(&self, user_id: &str) -> HashMap<String, String>;
    /// Drop all history for this user.
    fn clear(&mut self, user_id: &str);
}

/// Parse an ISO-8601 instant to epoch-ms, mirroring JS `new Date(iso).getTime()`.
///
/// Unparseable input yields `0` rather than an error. That matches the Python
/// port and JS's `NaN` comparisons, both of which effectively exclude the
/// record — a malformed timestamp must not suppress a placement forever.
#[must_use]
pub fn parse_iso_to_ms(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso).map_or(0, |dt| dt.timestamp_millis())
}

/// Format epoch-ms as JS `new Date(ms).toISOString()` does.
#[must_use]
pub fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map_or_else(
        || "1970-01-01T00:00:00.000Z".to_string(),
        |dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_confirmed_conversion_is_terminal() {
        // The load-bearing distinction (plan 167 Q-1): everything else is a
        // time-boxed cooldown and the placement must return.
        assert!(ImpressionRecord::new("p", "cta_completed", "t").is_terminal());
        for non_terminal in ["impressed", "dismissed", "clicked_thru", "suppressed"] {
            assert!(
                !ImpressionRecord::new("p", non_terminal, "t").is_terminal(),
                "{non_terminal} must NOT permanently retire the placement",
            );
        }
    }

    #[test]
    fn iso_round_trips_through_epoch_ms() {
        assert_eq!(parse_iso_to_ms("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(
            parse_iso_to_ms("2023-11-14T22:13:20.123Z"),
            1_700_000_000_123
        );
        assert_eq!(iso_from_ms(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn unparseable_timestamps_yield_zero_not_an_error() {
        // A malformed `suppressUntil` must read as long-past, so it cannot
        // suppress a placement forever.
        assert_eq!(parse_iso_to_ms("not-a-date"), 0);
        assert_eq!(parse_iso_to_ms(""), 0);
    }
}
