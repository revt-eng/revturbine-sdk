//! Records and queries placement impression history.
//!
//! Wraps any [`ImpressionHistoryStore`] and maintains hot-path caches so the
//! resolver can ask "is this hidden?" synchronously.
//!
//! Source: revturbine-scaffold/src/core/state/impression-history.ts

use std::collections::{HashMap, HashSet};

use crate::placements::selection::category_bucket;
use serde_json::{json, Value};

use crate::state::impression_history_types::{
    iso_from_ms, parse_iso_to_ms, ImpressionHistoryStore, ImpressionQuery, ImpressionRecord,
    DEFAULT_DISMISS_COOLDOWN_MS, DEFAULT_SUPPRESSION_MS,
};

fn system_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Records and queries placement impression / interaction history.
///
/// # Cache semantics
///
/// `retired` and `suppressed` caches start **cold** (`None`), not empty. The
/// `*_sync` checks return `false` on a cold cache rather than hitting the
/// store — they are hot-path calls on the resolver, and a cold cache means
/// "not yet known", not "nothing hidden". Call [`Self::hydrate`] during
/// initialization to warm them.
///
/// Source: impression-history.ts:29-239
pub struct ImpressionHistory<S: ImpressionHistoryStore> {
    store: S,
    user_id: String,
    default_suppression_ms: i64,
    default_dismiss_cooldown_ms: i64,
    retired_cache: Option<HashSet<String>>,
    suppressed_cache: Option<HashMap<String, String>>,
    explicit_suppressed_cache: HashMap<String, String>,
    now_fn: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl<S: ImpressionHistoryStore> ImpressionHistory<S> {
    /// Construct with default windows and the system clock.
    pub fn new(store: S, user_id: &str) -> Self {
        Self::with_options(
            store,
            user_id,
            DEFAULT_SUPPRESSION_MS,
            DEFAULT_DISMISS_COOLDOWN_MS,
            Box::new(system_now_ms),
        )
    }

    /// Construct with explicit windows and clock.
    pub fn with_options(
        store: S,
        user_id: &str,
        default_suppression_ms: i64,
        default_dismiss_cooldown_ms: i64,
        now_fn: Box<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            store,
            user_id: user_id.to_string(),
            default_suppression_ms,
            default_dismiss_cooldown_ms,
            retired_cache: None,
            suppressed_cache: None,
            explicit_suppressed_cache: HashMap::new(),
            now_fn,
        }
    }

    // ── Recording ───────────────────────────────────────────────────────────

    /// Record that the placement was shown. Carries no suppression.
    ///
    /// Source: impression-history.ts:55-62
    pub fn record_impression(&mut self, placement_id: &str, metadata: Option<Value>) {
        self.append_record(placement_id, "impressed", metadata);
    }

    /// Record a dismissal — **time-boxed**, not permanent. The placement
    /// returns once the cooldown elapses (plan 167 Q-1).
    ///
    /// Source: impression-history.ts:68-76
    pub fn record_dismissal(
        &mut self,
        placement_id: &str,
        metadata: Option<Value>,
        cooldown_ms: Option<i64>,
    ) {
        let ms = cooldown_ms.unwrap_or(self.default_dismiss_cooldown_ms);
        self.append_suppressing_record(placement_id, "dismissed", metadata, ms);
    }

    /// Record a bare click-through — clicked but not confirmed complete (an
    /// abandoned checkout, say). Treated as a dismiss cooldown; the placement
    /// may return. Use [`Self::record_conversion`] for a confirmed conversion.
    ///
    /// Source: impression-history.ts:82-90
    pub fn record_click_thru(
        &mut self,
        placement_id: &str,
        metadata: Option<Value>,
        cooldown_ms: Option<i64>,
    ) {
        let ms = cooldown_ms.unwrap_or(self.default_dismiss_cooldown_ms);
        self.append_suppressing_record(placement_id, "clicked_thru", metadata, ms);
    }

    /// Record conversion analytics without changing placement eligibility.
    ///
    /// Source: impression-history.ts (recordConversion)
    pub fn record_conversion(&mut self, placement_id: &str, metadata: Option<Value>) {
        self.append_record(placement_id, "cta_completed", metadata);
    }

    /// Record a time-based suppression.
    ///
    /// Source: impression-history.ts:98-112
    pub fn record_suppression(
        &mut self,
        placement_id: &str,
        metadata: Option<Value>,
        duration_ms: Option<i64>,
    ) {
        let ms = duration_ms.unwrap_or(self.default_suppression_ms);
        self.append_suppressing_record(placement_id, "suppressed", metadata, ms);
    }

    // ── Querying ────────────────────────────────────────────────────────────

    /// Compatibility method: conversion no longer retires placements.
    ///
    /// Source: impression-history.ts:121-124
    pub fn is_retired(&mut self, _placement_id: &str) -> bool {
        false
    }

    /// Compatibility query: conversions no longer retire placements.
    pub fn get_retired_ids(&mut self) -> &HashSet<String> {
        self.retired_cache.get_or_insert_with(HashSet::new)
    }

    /// Compatibility query: conversions no longer retire placements.
    #[must_use]
    pub fn is_retired_sync(&self, _placement_id: &str) -> bool {
        false
    }

    /// Synchronous suppression check. Expired entries are **evicted** as a
    /// side effect, so a lapsed cooldown stops costing a lookup.
    ///
    /// Source: impression-history.ts:149-157
    pub fn is_suppressed_sync(&mut self, placement_id: &str) -> bool {
        let now = (self.now_fn)();
        let Some(cache) = self.suppressed_cache.as_mut() else {
            return false;
        };
        let Some(until) = cache.get(placement_id) else {
            return false;
        };
        if parse_iso_to_ms(until) > now {
            return true;
        }
        cache.remove(placement_id);
        false
    }

    /// Whether the placement has an active timed suppression.
    ///
    /// Source: impression-history.ts:162-164
    pub fn is_hidden_sync(&mut self, placement_id: &str) -> bool {
        self.is_hidden_for_category_sync(placement_id, "")
    }

    /// Category-aware visibility: explicit suppression applies to every category.
    pub fn is_hidden_for_category_sync(&mut self, placement_id: &str, category: &str) -> bool {
        let explicit = self
            .explicit_suppressed_cache
            .get(placement_id)
            .is_some_and(|until| parse_iso_to_ms(until) > (self.now_fn)());
        if explicit {
            return true;
        }
        self.explicit_suppressed_cache.remove(placement_id);
        if category_bucket(category) <= 1 {
            return false;
        }
        self.is_suppressed_sync(placement_id)
    }

    /// Query the underlying store.
    ///
    /// Source: impression-history.ts:169-171
    pub fn query_history(&self, query: Option<&ImpressionQuery>) -> Vec<ImpressionRecord> {
        self.store.query(&self.user_id, query)
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /// Pre-warm both caches. Call during initialization so the `*_sync` checks
    /// are meaningful.
    ///
    /// Source: impression-history.ts:181-184
    pub fn hydrate(&mut self) {
        self.retired_cache = Some(HashSet::new());
        self.suppressed_cache = Some(self.store.get_suppressed_placements(&self.user_id));
        self.explicit_suppressed_cache.clear();
        let query = ImpressionQuery {
            outcomes: Some(vec!["suppressed".into()]),
            ..Default::default()
        };
        for record in self.store.query(&self.user_id, Some(&query)) {
            if record.outcome != "suppressed" {
                continue;
            }
            if let Some(until) = record
                .metadata
                .as_ref()
                .and_then(|m| m.get("suppressUntil"))
                .and_then(Value::as_str)
            {
                if parse_iso_to_ms(until) > (self.now_fn)() {
                    self.explicit_suppressed_cache
                        .entry(record.placement_id)
                        .or_insert_with(|| until.to_string());
                }
            }
        }
    }

    /// Clear all history for this user. Caches become empty (warm), not cold.
    ///
    /// Source: impression-history.ts:189-193
    pub fn reset(&mut self) {
        self.store.clear(&self.user_id);
        self.retired_cache = Some(HashSet::new());
        self.suppressed_cache = Some(HashMap::new());
        self.explicit_suppressed_cache.clear();
    }

    /// Switch user identity. Caches go **cold**, not empty — the new user's
    /// history is unknown, and treating it as empty would leak a "nothing
    /// hidden" answer for someone whose history has not been read.
    ///
    /// Source: impression-history.ts:198-202
    pub fn set_user_id(&mut self, user_id: &str) {
        self.user_id = user_id.to_string();
        self.retired_cache = None;
        self.suppressed_cache = None;
        self.explicit_suppressed_cache.clear();
    }

    // ── Internal ────────────────────────────────────────────────────────────

    fn append_record(&mut self, placement_id: &str, outcome: &str, metadata: Option<Value>) {
        let mut record =
            ImpressionRecord::new(placement_id, outcome, &iso_from_ms((self.now_fn)()));
        record.metadata = metadata;
        self.store.append(&self.user_id, record);
    }

    /// Append a record whose metadata carries a `suppressUntil`, and mirror
    /// the window into the cache so the next `*_sync` call sees it without a
    /// store round-trip.
    fn append_suppressing_record(
        &mut self,
        placement_id: &str,
        outcome: &str,
        metadata: Option<Value>,
        duration_ms: i64,
    ) {
        let suppress_until = iso_from_ms((self.now_fn)() + duration_ms);
        let mut merged = match metadata {
            Some(Value::Object(m)) => Value::Object(m),
            _ => json!({}),
        };
        merged["suppressUntil"] = Value::String(suppress_until.clone());

        self.append_record(placement_id, outcome, Some(merged));
        if outcome == "suppressed" {
            self.explicit_suppressed_cache
                .insert(placement_id.to_string(), suppress_until.clone());
        }
        self.suppressed_cache
            .get_or_insert_with(HashMap::new)
            .insert(placement_id.to_string(), suppress_until);
    }
}
