//! Impression-history store implementations.
//!
//! [`InMemoryImpressionStore`] is ephemeral and in-process — the backend the
//! headless SDK ships. A durable store is a caller decision.
//!
//! Source: revturbine-scaffold/src/core/state/impression-history-stores.ts

use std::collections::{HashMap, HashSet};

use crate::state::impression_history_types::{
    parse_iso_to_ms, ImpressionHistoryStore, ImpressionQuery, ImpressionRecord,
};

/// Filter records by placement ids, outcomes, and a `since` floor.
///
/// Source: impression-history-stores.ts:147-165 (applyQuery)
#[must_use]
pub fn apply_query(records: &[ImpressionRecord], query: &ImpressionQuery) -> Vec<ImpressionRecord> {
    let mut filtered: Vec<ImpressionRecord> = records.to_vec();

    if let Some(ids) = query.placement_ids.as_ref().filter(|v| !v.is_empty()) {
        let set: HashSet<&str> = ids.iter().map(String::as_str).collect();
        filtered.retain(|r| set.contains(r.placement_id.as_str()));
    }
    if let Some(outcomes) = query.outcomes.as_ref().filter(|v| !v.is_empty()) {
        let set: HashSet<&str> = outcomes.iter().map(String::as_str).collect();
        filtered.retain(|r| set.contains(r.outcome.as_str()));
    }
    if let Some(since) = query.since.as_ref().filter(|s| !s.is_empty()) {
        let since_ms = parse_iso_to_ms(since);
        filtered.retain(|r| parse_iso_to_ms(&r.occurred_at) >= since_ms);
    }

    filtered
}

/// Placements permanently retired — those with a terminal outcome.
///
/// Source: impression-history-stores.ts:168-176 (extractRetiredIds)
#[must_use]
pub fn extract_retired_ids(records: &[ImpressionRecord]) -> HashSet<String> {
    records
        .iter()
        .filter(|r| r.is_terminal())
        .map(|r| r.placement_id.clone())
        .collect()
}

/// Placements currently inside a suppression window, mapped to its expiry.
///
/// Walks **newest → oldest** so the most recent window per placement wins, and
/// drops any whose `suppressUntil` has already passed. A cooldown is *any*
/// record carrying a future `suppressUntil` — which since plan 167 Q-1
/// includes `dismissed` and bare `clicked_thru`, not only `suppressed`.
///
/// Source: impression-history-stores.ts:183-198 (extractSuppressedPlacements)
#[must_use]
pub fn extract_suppressed_placements(
    records: &[ImpressionRecord],
    now_ms: i64,
) -> HashMap<String, String> {
    let mut suppressed: HashMap<String, String> = HashMap::new();
    for record in records.iter().rev() {
        if suppressed.contains_key(&record.placement_id) {
            continue;
        }
        let Some(until) = record
            .metadata
            .as_ref()
            .and_then(|m| m.get("suppressUntil"))
            .and_then(|v| v.as_str())
        else {
            continue;
        };
        if parse_iso_to_ms(until) > now_ms {
            suppressed.insert(record.placement_id.clone(), until.to_string());
        }
    }
    suppressed
}

fn system_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Ephemeral, in-process impression history.
///
/// Carries its own clock so suppression-window expiry is testable without
/// sleeping — the trait signature stays identical to the TS and Python stores.
///
/// Source: impression-history-stores.ts:26-54
pub struct InMemoryImpressionStore {
    records: HashMap<String, Vec<ImpressionRecord>>,
    now_fn: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl Default for InMemoryImpressionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemoryImpressionStore {
    /// An empty store on the system clock.
    #[must_use]
    pub fn new() -> Self {
        Self {
            records: HashMap::new(),
            now_fn: Box::new(system_now_ms),
        }
    }

    /// An empty store on an explicit clock.
    #[must_use]
    pub fn with_clock(now_fn: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self {
            records: HashMap::new(),
            now_fn,
        }
    }
}

impl ImpressionHistoryStore for InMemoryImpressionStore {
    fn append(&mut self, user_id: &str, record: ImpressionRecord) {
        self.records
            .entry(user_id.to_string())
            .or_default()
            .push(record);
    }

    fn query(&self, user_id: &str, query: Option<&ImpressionQuery>) -> Vec<ImpressionRecord> {
        let records = self.records.get(user_id).cloned().unwrap_or_default();
        let mut filtered = match query {
            Some(q) => apply_query(&records, q),
            None => records,
        };
        // Most-recent first, matching the TS `slice().reverse()`.
        filtered.reverse();
        filtered
    }

    fn get_retired_placement_ids(&self, user_id: &str) -> HashSet<String> {
        self.records
            .get(user_id)
            .map(|r| extract_retired_ids(r))
            .unwrap_or_default()
    }

    fn get_suppressed_placements(&self, user_id: &str) -> HashMap<String, String> {
        self.records
            .get(user_id)
            .map(|r| extract_suppressed_placements(r, (self.now_fn)()))
            .unwrap_or_default()
    }

    fn clear(&mut self, user_id: &str) {
        self.records.remove(user_id);
    }
}
