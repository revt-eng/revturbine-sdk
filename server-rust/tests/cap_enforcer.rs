//! Presentation-cap and cooldown enforcement.
//!
//! Mirrors `server-python/tests/state/test_cap_enforcer.py`. Every case pins
//! the clock — cap decisions are time-dependent, and a window boundary cannot
//! be asserted against a live clock without sleeping.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use revturbine::state::{CapEnforcer, InMemoryStorage, RevTurbineStorage};

const MS_PER_DAY: i64 = 24 * 60 * 60 * 1000;
const T0: i64 = 1_700_000_000_000;

/// A clock the test drives explicitly.
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

fn enforcer(clock: &TestClock) -> CapEnforcer<InMemoryStorage> {
    let c = clock.0.clone();
    CapEnforcer::with_clock(
        InMemoryStorage::new(),
        "tenant_1",
        "user_1",
        Box::new(move || c.load(Ordering::SeqCst)),
    )
}

/// A placement output with a `max_per_period` cap at the top level.
fn capped(count: u32, period: &str) -> Value {
    json!({
        "output_id": "out_1",
        "surface": { "type": "banner" },
        "caps": { "max_per_period": { "count": count, "period": period } },
    })
}

#[test]
fn an_output_with_no_caps_is_always_allowed() {
    let clock = TestClock::new(T0);
    let mut e = enforcer(&clock);
    let output = json!({ "output_id": "out_1", "surface": { "type": "banner" } });
    for _ in 0..10 {
        assert!(e.enforce(&output).allowed);
    }
}

#[test]
fn allows_up_to_the_cap_then_denies() {
    let clock = TestClock::new(T0);
    let mut e = enforcer(&clock);
    let output = capped(2, "day");

    assert!(e.enforce(&output).allowed, "1st presentation");
    assert!(e.enforce(&output).allowed, "2nd presentation");

    let third = e.enforce(&output);
    assert!(!third.allowed, "3rd exceeds a cap of 2");
    assert_eq!(
        third.reason.as_deref(),
        Some("suppressed_by_payload_cap_day")
    );
}

#[test]
fn a_denied_presentation_is_not_recorded() {
    // Otherwise a blocked impression would count against the user's own cap
    // and the window would never drain.
    let clock = TestClock::new(T0);
    let mut e = enforcer(&clock);
    let output = capped(1, "day");

    assert!(e.enforce(&output).allowed);
    assert!(!e.enforce(&output).allowed);
    assert!(!e.enforce(&output).allowed);

    // Move just past the 24h window relative to the FIRST presentation. If the
    // denials had been recorded, the window would still be full.
    clock.advance(MS_PER_DAY + 1);
    assert!(e.enforce(&output).allowed, "window should have drained");
}

#[test]
fn the_window_slides() {
    let clock = TestClock::new(T0);
    let mut e = enforcer(&clock);
    let output = capped(1, "day");

    assert!(e.enforce(&output).allowed);
    clock.advance(MS_PER_DAY - 1_000); // still inside the window
    assert!(!e.enforce(&output).allowed);
    clock.advance(2_000); // now outside
    assert!(e.enforce(&output).allowed);
}

#[test]
fn lifetime_and_session_caps_never_drain() {
    for period in ["lifetime", "session"] {
        let clock = TestClock::new(T0);
        let mut e = enforcer(&clock);
        let output = capped(1, period);

        assert!(e.enforce(&output).allowed);
        clock.advance(MS_PER_DAY * 3650); // ten years
        let r = e.enforce(&output);
        assert!(!r.allowed, "{period} should still be capped");
        assert_eq!(
            r.reason.as_deref(),
            Some(format!("suppressed_by_payload_cap_{period}").as_str())
        );
    }
}

#[test]
fn cooldown_suppresses_and_takes_precedence_over_caps() {
    let clock = TestClock::new(T0);
    let mut e = enforcer(&clock);
    let output = json!({
        "output_id": "out_1",
        "surface": { "type": "banner" },
        "caps": {
            "max_per_period": { "count": 99, "period": "day" },
            "cooldown_days": 7,
        },
    });

    assert!(e.enforce(&output).allowed);

    // Well under the cap of 99, but inside the cooldown.
    let second = e.enforce(&output);
    assert!(!second.allowed);
    assert_eq!(
        second.reason.as_deref(),
        Some("suppressed_by_payload_cooldown"),
        "cooldown reason must win over the cap reason",
    );

    clock.advance(7 * MS_PER_DAY + 1);
    assert!(e.enforce(&output).allowed, "cooldown should have expired");
}

#[test]
fn caps_are_scoped_per_output_and_surface() {
    let clock = TestClock::new(T0);
    let mut e = enforcer(&clock);
    let a = capped(1, "day");
    let mut b = capped(1, "day");
    b["output_id"] = json!("out_2");

    assert!(e.enforce(&a).allowed);
    assert!(!e.enforce(&a).allowed);
    assert!(
        e.enforce(&b).allowed,
        "a different output has its own budget"
    );
}

#[test]
fn caps_nested_under_content_are_honoured() {
    // Caps may be declared at the output level or on any of the legacy
    // content nests; all of them apply.
    let clock = TestClock::new(T0);
    let mut e = enforcer(&clock);
    let output = json!({
        "output_id": "out_1",
        "surface": { "type": "banner" },
        "content": {
            "payload": { "caps": { "max_per_period": { "count": 1, "period": "day" } } }
        },
    });

    assert!(e.enforce(&output).allowed);
    assert!(!e.enforce(&output).allowed);
}

#[test]
fn the_strictest_of_several_declared_caps_wins() {
    let clock = TestClock::new(T0);
    let mut e = enforcer(&clock);
    let output = json!({
        "output_id": "out_1",
        "surface": { "type": "banner" },
        "caps": { "max_per_period": { "count": 5, "period": "day" } },
        "content": {
            "caps": { "max_per_period": { "count": 1, "period": "day" } }
        },
    });

    assert!(e.enforce(&output).allowed);
    assert!(!e.enforce(&output).allowed, "the count-1 policy must bind");
}

#[test]
fn malformed_caps_are_ignored_rather_than_failing_closed() {
    let clock = TestClock::new(T0);
    let mut e = enforcer(&clock);
    let output = json!({
        "output_id": "out_1",
        "surface": { "type": "banner" },
        "caps": { "max_per_period": { "count": 0, "period": "not_a_period" } },
    });
    // An unparseable rule yields a policy with no rules — nothing to enforce.
    for _ in 0..5 {
        assert!(e.enforce(&output).allowed);
    }
}

#[test]
fn state_persists_and_rehydrates_across_instances() {
    let clock = TestClock::new(T0);
    let output = capped(1, "day");

    let mut storage = InMemoryStorage::new();
    {
        let c = clock.0.clone();
        let mut e = CapEnforcer::with_clock(
            &mut storage as &mut dyn RevTurbineStorage,
            "tenant_1",
            "user_1",
            Box::new(move || c.load(Ordering::SeqCst)),
        );
        assert!(e.enforce(&output).allowed);
    }

    // A fresh enforcer over the same storage must see the prior presentation.
    let c = clock.0.clone();
    let mut e2 = CapEnforcer::with_clock(
        &mut storage as &mut dyn RevTurbineStorage,
        "tenant_1",
        "user_1",
        Box::new(move || c.load(Ordering::SeqCst)),
    );
    assert!(!e2.enforce(&output).allowed, "hydrated state should cap");
}

#[test]
fn malformed_stored_json_is_discarded_not_fatal() {
    let clock = TestClock::new(T0);
    let mut storage = InMemoryStorage::new();
    storage.set_item("revturbine:presentation-caps:tenant_1:user_1", "{not json");

    let c = clock.0.clone();
    let mut e = CapEnforcer::with_clock(
        &mut storage as &mut dyn RevTurbineStorage,
        "tenant_1",
        "user_1",
        Box::new(move || c.load(Ordering::SeqCst)),
    );
    // Starts clean rather than panicking or refusing everything.
    assert!(e.enforce(&capped(1, "day")).allowed);
}
