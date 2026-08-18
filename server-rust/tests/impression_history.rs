//! Impression history: terminal vs time-boxed outcomes, and cache semantics.
//!
//! Mirrors `server-python/tests/state/test_impression_history.py` and
//! `test_impression_history_stores.py`. The clock is pinned throughout.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::json;

use revturbine::state::impression_history_types::{
    DEFAULT_DISMISS_COOLDOWN_MS, DEFAULT_SUPPRESSION_MS,
};
use revturbine::state::{
    ImpressionHistory, ImpressionHistoryStore, ImpressionQuery, ImpressionRecord,
    InMemoryImpressionStore,
};

const T0: i64 = 1_700_000_000_000;
const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;

#[derive(Clone)]
struct TestClock(Arc<AtomicI64>);

impl TestClock {
    fn new(at: i64) -> Self {
        Self(Arc::new(AtomicI64::new(at)))
    }
    fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

fn history(clock: &TestClock) -> ImpressionHistory<InMemoryImpressionStore> {
    let c1 = clock.0.clone();
    let c2 = clock.0.clone();
    ImpressionHistory::with_options(
        InMemoryImpressionStore::with_clock(Box::new(move || c1.load(Ordering::SeqCst))),
        "user_1",
        DEFAULT_SUPPRESSION_MS,
        DEFAULT_DISMISS_COOLDOWN_MS,
        Box::new(move || c2.load(Ordering::SeqCst)),
    )
}

// ── Terminal vs time-boxed ──────────────────────────────────────────────────

#[test]
fn a_conversion_retires_the_placement_permanently() {
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_conversion("pl_1", None);

    assert!(h.is_retired("pl_1"));
    clock.advance(MS_PER_DAY * 3650); // ten years
    assert!(h.is_retired_sync("pl_1"), "a conversion must never lapse");
    assert!(h.is_hidden_sync("pl_1"));
}

#[test]
fn a_dismissal_is_time_boxed_and_the_placement_returns() {
    // Plan 167 Q-1. Treating a dismissal as permanent is the classic way to
    // get this wrong, and the user would never see the placement again.
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_dismissal("pl_1", None, None);

    assert!(h.is_hidden_sync("pl_1"), "hidden during the cooldown");
    assert!(!h.is_retired_sync("pl_1"), "but NOT permanently retired");

    clock.advance(DEFAULT_DISMISS_COOLDOWN_MS + 1);
    assert!(!h.is_hidden_sync("pl_1"), "must return after the cooldown");
}

#[test]
fn a_bare_click_thru_is_time_boxed_too() {
    // An abandoned checkout is not a conversion.
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_click_thru("pl_1", None, None);

    assert!(h.is_hidden_sync("pl_1"));
    assert!(!h.is_retired_sync("pl_1"));

    clock.advance(DEFAULT_DISMISS_COOLDOWN_MS + 1);
    assert!(!h.is_hidden_sync("pl_1"));
}

#[test]
fn an_impression_alone_hides_nothing() {
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_impression("pl_1", None);
    assert!(!h.is_hidden_sync("pl_1"));
}

#[test]
fn explicit_windows_override_the_defaults() {
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_dismissal("pl_1", None, Some(1_000));
    h.record_suppression("pl_2", None, Some(5_000));

    clock.advance(1_001);
    assert!(!h.is_hidden_sync("pl_1"), "1s window should have lapsed");
    assert!(h.is_hidden_sync("pl_2"), "5s window should still hold");

    clock.advance(4_000);
    assert!(!h.is_hidden_sync("pl_2"));
}

// ── Cache semantics ─────────────────────────────────────────────────────────

#[test]
fn sync_checks_return_false_on_a_cold_cache() {
    // Cold means "not yet known", not "nothing hidden" — the hot-path checks
    // deliberately do not hit the store.
    let clock = TestClock::new(T0);
    let mut store = InMemoryImpressionStore::new();
    store.append(
        "user_1",
        ImpressionRecord::new("pl_1", "cta_completed", "2023-11-14T22:13:20.123Z"),
    );

    let c = clock.0.clone();
    let mut h = ImpressionHistory::with_options(
        store,
        "user_1",
        DEFAULT_SUPPRESSION_MS,
        DEFAULT_DISMISS_COOLDOWN_MS,
        Box::new(move || c.load(Ordering::SeqCst)),
    );

    assert!(
        !h.is_retired_sync("pl_1"),
        "cold cache must not claim knowledge it does not have"
    );
    h.hydrate();
    assert!(h.is_retired_sync("pl_1"), "warm cache sees the conversion");
}

#[test]
fn an_expired_suppression_is_evicted_from_the_cache() {
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_dismissal("pl_1", None, Some(1_000));
    assert!(h.is_suppressed_sync("pl_1"));

    clock.advance(1_001);
    // First call evicts...
    assert!(!h.is_suppressed_sync("pl_1"));
    // ...and stays evicted.
    assert!(!h.is_suppressed_sync("pl_1"));
}

#[test]
fn switching_user_makes_the_caches_cold_not_empty() {
    // Empty would mean "nothing hidden for the new user" — a claim we have
    // not earned until their history is read.
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_conversion("pl_1", None);
    assert!(h.is_retired_sync("pl_1"));

    h.set_user_id("user_2");
    assert!(!h.is_retired_sync("pl_1"));

    h.set_user_id("user_1");
    assert!(!h.is_retired_sync("pl_1"), "still cold until hydrated");
    h.hydrate();
    assert!(
        h.is_retired_sync("pl_1"),
        "user_1's conversion is still there"
    );
}

#[test]
fn reset_clears_history_and_leaves_caches_warm_and_empty() {
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_conversion("pl_1", None);
    h.record_dismissal("pl_2", None, None);

    h.reset();
    assert!(!h.is_hidden_sync("pl_1"));
    assert!(!h.is_hidden_sync("pl_2"));
    assert!(h.query_history(None).is_empty());
}

// ── Store behaviour ─────────────────────────────────────────────────────────

#[test]
fn query_returns_most_recent_first() {
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_impression("pl_1", None);
    clock.advance(1_000);
    h.record_impression("pl_2", None);

    let all = h.query_history(None);
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].placement_id, "pl_2", "newest first");
    assert_eq!(all[1].placement_id, "pl_1");
}

#[test]
fn query_filters_by_placement_outcome_and_since() {
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_impression("pl_1", None);
    clock.advance(1_000);
    h.record_conversion("pl_2", None);

    let by_placement = h.query_history(Some(&ImpressionQuery {
        placement_ids: Some(vec!["pl_1".into()]),
        ..Default::default()
    }));
    assert_eq!(by_placement.len(), 1);
    assert_eq!(by_placement[0].placement_id, "pl_1");

    let by_outcome = h.query_history(Some(&ImpressionQuery {
        outcomes: Some(vec!["cta_completed".into()]),
        ..Default::default()
    }));
    assert_eq!(by_outcome.len(), 1);
    assert_eq!(by_outcome[0].placement_id, "pl_2");

    // `since` is inclusive of its own instant.
    let since = h.query_history(Some(&ImpressionQuery {
        since: Some(revturbine::state::impression_history_types::iso_from_ms(
            T0 + 1_000,
        )),
        ..Default::default()
    }));
    assert_eq!(since.len(), 1);
    assert_eq!(since[0].placement_id, "pl_2");
}

#[test]
fn the_most_recent_window_per_placement_wins() {
    // The store walks newest -> oldest, so a fresh dismissal must extend an
    // older one rather than being shadowed by it.
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_dismissal("pl_1", None, Some(1_000));
    clock.advance(500);
    h.record_dismissal("pl_1", None, Some(10_000));

    h.hydrate(); // re-read from the store rather than trusting the cache
    clock.advance(1_000);
    assert!(
        h.is_suppressed_sync("pl_1"),
        "the newer, longer window must win",
    );
}

#[test]
fn history_is_scoped_per_user() {
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_conversion("pl_1", None);

    h.set_user_id("user_2");
    h.hydrate();
    assert!(
        !h.is_retired_sync("pl_1"),
        "user_2 must not inherit user_1's history",
    );
}

#[test]
fn caller_metadata_is_preserved_alongside_suppress_until() {
    let clock = TestClock::new(T0);
    let mut h = history(&clock);
    h.record_dismissal("pl_1", Some(json!({ "source": "banner" })), Some(1_000));

    let records = h.query_history(None);
    let meta = records[0].metadata.as_ref().expect("metadata present");
    assert_eq!(meta.get("source").and_then(|v| v.as_str()), Some("banner"));
    assert!(
        meta.get("suppressUntil").is_some(),
        "suppressUntil must be merged in, not replace caller metadata",
    );
}
