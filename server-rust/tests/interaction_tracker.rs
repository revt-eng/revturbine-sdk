//! Interaction tracking and suppression windows.
//!
//! Mirrors `server-python/tests/state/test_interaction_tracker.py`. The clock
//! is pinned throughout — suppression is time-dependent, and every window
//! boundary below would otherwise need a sleep.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::json;

use revturbine::state::{
    InMemoryStorage, InteractionTracker, RevTurbineStorage, TreatmentInteractionInput,
    CTA_SUPPRESSION_MS, DEFAULT_DISMISS_COOLDOWN_MS, DEFAULT_REMIND_LATER_MS,
};

const T0: i64 = 1_700_000_000_000;

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

fn tracker(clock: &TestClock) -> InteractionTracker<InMemoryStorage> {
    let c = clock.0.clone();
    InteractionTracker::with_options(
        InMemoryStorage::new(),
        "tenant_1",
        "user_1",
        DEFAULT_DISMISS_COOLDOWN_MS,
        DEFAULT_REMIND_LATER_MS,
        Box::new(move || c.load(Ordering::SeqCst)),
    )
}

fn interaction(kind: &'static str) -> TreatmentInteractionInput<'static> {
    TreatmentInteractionInput {
        placement_id: "pl_1",
        user_id: "user_1",
        treatment_id: None,
        interaction_type: kind,
        interaction_at: None,
        metadata: None,
    }
}

#[test]
fn nothing_is_suppressed_before_any_interaction() {
    let clock = TestClock::new(T0);
    let t = tracker(&clock);
    assert!(!t.check_suppression("pl_1", "user_1", None).suppressed);
}

#[test]
fn dismiss_suppresses_for_the_default_cooldown() {
    let clock = TestClock::new(T0);
    let mut t = tracker(&clock);
    t.track(&interaction("dismiss"));

    let r = t.check_suppression("pl_1", "user_1", None);
    assert!(r.suppressed);
    assert_eq!(r.reason.as_deref(), Some("suppressed_by_dismiss_cooldown"));

    // Exactly at expiry the window releases — `<= now` is not suppressed.
    clock.advance(DEFAULT_DISMISS_COOLDOWN_MS);
    assert!(!t.check_suppression("pl_1", "user_1", None).suppressed);
}

#[test]
fn remind_me_later_uses_its_own_window_and_reason() {
    let clock = TestClock::new(T0);
    let mut t = tracker(&clock);
    t.track(&interaction("remind_me_later"));

    let r = t.check_suppression("pl_1", "user_1", None);
    assert!(r.suppressed);
    assert_eq!(
        r.reason.as_deref(),
        Some("suppressed_until_remind_window"),
        "remind-me-later must be distinguishable from a dismissal",
    );

    clock.advance(DEFAULT_REMIND_LATER_MS - 1);
    assert!(t.check_suppression("pl_1", "user_1", None).suppressed);
    clock.advance(1);
    assert!(!t.check_suppression("pl_1", "user_1", None).suppressed);
}

#[test]
fn a_bare_cta_click_takes_the_dismiss_cooldown_not_the_short_window() {
    // Plan 167 Q-1: a click is not a confirmed conversion, so the user may
    // still return — it must NOT get the 5-minute completed window.
    let clock = TestClock::new(T0);
    let mut t = tracker(&clock);
    t.track(&interaction("cta_clicked"));

    clock.advance(CTA_SUPPRESSION_MS + 1);
    assert!(
        t.check_suppression("pl_1", "user_1", None).suppressed,
        "a click must outlast the completed-CTA window",
    );

    clock.advance(DEFAULT_DISMISS_COOLDOWN_MS);
    assert!(!t.check_suppression("pl_1", "user_1", None).suppressed);
}

#[test]
fn a_completed_cta_only_gets_the_short_transient_window() {
    // Permanence for a conversion is owned by impression history; this window
    // only covers the in-flight action.
    let clock = TestClock::new(T0);
    let mut t = tracker(&clock);
    t.track(&interaction("cta_completed"));

    assert!(t.check_suppression("pl_1", "user_1", None).suppressed);
    clock.advance(CTA_SUPPRESSION_MS);
    assert!(!t.check_suppression("pl_1", "user_1", None).suppressed);
}

#[test]
fn metadata_overrides_the_default_windows() {
    let clock = TestClock::new(T0);
    let mut t = tracker(&clock);
    let meta = json!({ "cooldown_ms": 1_000 });
    t.track(&TreatmentInteractionInput {
        metadata: Some(&meta),
        ..interaction("dismiss")
    });

    clock.advance(999);
    assert!(t.check_suppression("pl_1", "user_1", None).suppressed);
    clock.advance(1);
    assert!(!t.check_suppression("pl_1", "user_1", None).suppressed);
}

#[test]
fn remind_after_seconds_is_seconds_not_milliseconds() {
    // A unit mix-up here would shorten every reminder by 1000x.
    let clock = TestClock::new(T0);
    let mut t = tracker(&clock);
    let meta = json!({ "remind_after_seconds": 30 });
    t.track(&TreatmentInteractionInput {
        metadata: Some(&meta),
        ..interaction("remind_me_later")
    });

    clock.advance(29_999);
    assert!(t.check_suppression("pl_1", "user_1", None).suppressed);
    clock.advance(1);
    assert!(!t.check_suppression("pl_1", "user_1", None).suppressed);
}

#[test]
fn invalid_metadata_falls_back_to_the_default() {
    let clock = TestClock::new(T0);
    let mut t = tracker(&clock);
    for bad in [json!(0), json!(-5), json!(true), json!("abc"), json!(null)] {
        let meta = json!({ "cooldown_ms": bad });
        let mut t2 = tracker(&clock);
        t2.track(&TreatmentInteractionInput {
            metadata: Some(&meta),
            ..interaction("dismiss")
        });
        assert!(
            t2.check_suppression("pl_1", "user_1", None).suppressed,
            "bad override {bad} should fall back, not disable suppression",
        );
    }
    t.track(&interaction("dismiss"));
}

#[test]
fn suppression_is_scoped_per_placement_and_treatment() {
    let clock = TestClock::new(T0);
    let mut t = tracker(&clock);
    t.track(&interaction("dismiss"));

    assert!(t.check_suppression("pl_1", "user_1", None).suppressed);
    assert!(!t.check_suppression("pl_2", "user_1", None).suppressed);
    assert!(
        !t.check_suppression("pl_1", "user_1", Some("tr_a"))
            .suppressed
    );
    assert!(!t.check_suppression("pl_1", "user_2", None).suppressed);
}

#[test]
fn clear_suppression_drops_the_window() {
    let clock = TestClock::new(T0);
    let mut t = tracker(&clock);
    t.track(&interaction("dismiss"));
    assert!(t.check_suppression("pl_1", "user_1", None).suppressed);

    t.clear_suppression("pl_1", "user_1", None);
    assert!(!t.check_suppression("pl_1", "user_1", None).suppressed);
}

#[test]
fn an_unrecognized_interaction_type_leaves_an_existing_window_intact() {
    // The TS spreads the prior state then sets per-branch, so an unknown type
    // records the interaction without clearing suppression. Dropping the
    // window here would let a stray event un-dismiss a placement.
    let clock = TestClock::new(T0);
    let mut t = tracker(&clock);
    t.track(&interaction("dismiss"));
    t.track(&interaction("some_future_event"));

    assert!(
        t.check_suppression("pl_1", "user_1", None).suppressed,
        "an unknown event must not clear an active dismissal",
    );
}

#[test]
fn state_persists_and_rehydrates_across_instances() {
    let clock = TestClock::new(T0);
    let mut storage = InMemoryStorage::new();
    {
        let c = clock.0.clone();
        let mut t = InteractionTracker::with_options(
            &mut storage as &mut dyn RevTurbineStorage,
            "tenant_1",
            "user_1",
            DEFAULT_DISMISS_COOLDOWN_MS,
            DEFAULT_REMIND_LATER_MS,
            Box::new(move || c.load(Ordering::SeqCst)),
        );
        t.track(&interaction("dismiss"));
    }

    let c = clock.0.clone();
    let t2 = InteractionTracker::with_options(
        &mut storage as &mut dyn RevTurbineStorage,
        "tenant_1",
        "user_1",
        DEFAULT_DISMISS_COOLDOWN_MS,
        DEFAULT_REMIND_LATER_MS,
        Box::new(move || c.load(Ordering::SeqCst)),
    );
    assert!(
        t2.check_suppression("pl_1", "user_1", None).suppressed,
        "a dismissal must survive a process restart",
    );
}

#[test]
fn malformed_stored_json_is_discarded_not_fatal() {
    let clock = TestClock::new(T0);
    let mut storage = InMemoryStorage::new();
    storage.set_item("revturbine:interaction-state:tenant_1:user_1", "{not json");

    let c = clock.0.clone();
    let t = InteractionTracker::with_options(
        &mut storage as &mut dyn RevTurbineStorage,
        "tenant_1",
        "user_1",
        DEFAULT_DISMISS_COOLDOWN_MS,
        DEFAULT_REMIND_LATER_MS,
        Box::new(move || c.load(Ordering::SeqCst)),
    );
    assert!(!t.check_suppression("pl_1", "user_1", None).suppressed);
}
