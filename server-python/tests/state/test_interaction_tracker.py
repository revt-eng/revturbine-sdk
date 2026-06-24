"""Tests for ``revturbine.core.state.interaction_tracker``."""

from __future__ import annotations

import json
from collections.abc import Callable

import pytest

from revturbine.core.state.interaction_tracker import InteractionTracker
from revturbine.core.state.storage import InMemoryStorage
from revturbine.core.state.types import RevTurbineTreatmentInteractionInput


@pytest.fixture
def freeze_time(monkeypatch: pytest.MonkeyPatch) -> Callable[[float], None]:
    """Freeze ``time.time`` across the interaction_tracker module."""
    state = {"now": 1_000_000.0}

    def _fake_time() -> float:
        return state["now"]

    monkeypatch.setattr("revturbine.core.state.interaction_tracker.time.time", _fake_time)

    def setter(now_seconds: float) -> None:
        state["now"] = now_seconds

    return setter


def _input(**overrides: object) -> RevTurbineTreatmentInteractionInput:
    base: dict[str, object] = {
        "user_id": "u1",
        "placement_id": "p1",
        "interaction_type": "dismiss",
    }
    base.update(overrides)
    return base  # type: ignore[return-value]


class TestTrackDismiss:
    def test_dismiss_creates_default_cooldown(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(_input(interaction_type="dismiss"))
        result = tracker.check_suppression("p1", "u1")
        assert result == {
            "suppressed": True,
            "reason": "suppressed_by_dismiss_cooldown",
        }

    def test_dismiss_metadata_override_in_ms(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)  # now = 1000ms
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(
            _input(
                interaction_type="dismiss",
                metadata={"cooldown_ms": 5000},
            ),
        )
        # 1.0s into 5s cooldown — still suppressed.
        freeze_time(2.0)
        assert tracker.check_suppression("p1", "u1")["suppressed"] is True
        # Past cooldown window — no longer suppressed.
        freeze_time(10.0)
        assert tracker.check_suppression("p1", "u1") == {"suppressed": False}

    def test_dismiss_invalid_metadata_falls_back_to_default(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        tracker = InteractionTracker(
            storage=storage,
            tenant_id="t1",
            user_id="u1",
            default_dismiss_cooldown_ms=10_000,
        )
        # Negative cooldown_ms is rejected — falls back to default.
        tracker.track(_input(interaction_type="dismiss", metadata={"cooldown_ms": -1}))
        # 5s passed — still inside default 10s window.
        freeze_time(6.0)
        assert tracker.check_suppression("p1", "u1")["suppressed"] is True


class TestTrackRemindMeLater:
    def test_default_remind_window(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        tracker = InteractionTracker(
            storage=storage,
            tenant_id="t1",
            user_id="u1",
            default_remind_later_ms=30_000,
        )
        tracker.track(_input(interaction_type="remind_me_later"))
        result = tracker.check_suppression("p1", "u1")
        assert result == {
            "suppressed": True,
            "reason": "suppressed_until_remind_window",
        }

    def test_metadata_override_in_seconds(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(
            _input(
                interaction_type="remind_me_later",
                metadata={"remind_after_seconds": 3},  # 3 seconds
            ),
        )
        # 2s in — still suppressed.
        freeze_time(3.0)
        assert tracker.check_suppression("p1", "u1")["suppressed"] is True
        # 4s in — past window.
        freeze_time(5.0)
        assert tracker.check_suppression("p1", "u1") == {"suppressed": False}


class TestTrackCta:
    def test_cta_clicked_suppresses_5_minutes(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(_input(interaction_type="cta_clicked"))
        # 4 minutes later — still suppressed.
        freeze_time(1.0 + 4 * 60)
        result = tracker.check_suppression("p1", "u1")
        assert result["suppressed"] is True
        # cta_clicked should fall through to the dismiss-cooldown reason
        # because it's not remind_me_later.
        assert result["reason"] == "suppressed_by_dismiss_cooldown"

    def test_cta_completed_same_5_minute_window(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(_input(interaction_type="cta_completed"))
        freeze_time(1.0 + 6 * 60)
        # Past 5-minute window.
        assert tracker.check_suppression("p1", "u1") == {"suppressed": False}


class TestKeyIsolation:
    def test_different_user_not_suppressed(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(_input(interaction_type="dismiss"))
        # Same placement, different user → not suppressed.
        assert tracker.check_suppression("p1", "u2") == {"suppressed": False}

    def test_different_placement_not_suppressed(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(_input(interaction_type="dismiss"))
        assert tracker.check_suppression("p2", "u1") == {"suppressed": False}

    def test_different_treatment_not_suppressed(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(_input(interaction_type="dismiss", treatment_id="A"))
        assert tracker.check_suppression("p1", "u1", "B") == {"suppressed": False}


class TestClearSuppression:
    def test_clear_removes_state(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(_input(interaction_type="dismiss"))
        assert tracker.check_suppression("p1", "u1")["suppressed"] is True
        tracker.clear_suppression("p1", "u1")
        assert tracker.check_suppression("p1", "u1") == {"suppressed": False}

    def test_clear_missing_is_noop(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.clear_suppression("missing", "u1")  # No raise.


class TestPersistence:
    def test_persist_then_hydrate_roundtrip(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(_input(interaction_type="dismiss"))

        # Construct a fresh tracker with the same storage — should hydrate.
        tracker2 = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        assert tracker2.check_suppression("p1", "u1")["suppressed"] is True

    def test_storage_is_namespaced_by_tenant_and_user(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(_input(interaction_type="dismiss"))

        # A tracker for a different tenant should see no state.
        other = InteractionTracker(storage=storage, tenant_id="t2", user_id="u1")
        assert other.check_suppression("p1", "u1") == {"suppressed": False}

    def test_malformed_json_is_dropped(self) -> None:
        storage = InMemoryStorage()
        # Pre-populate storage with garbage at the expected key.
        storage.set_item("revturbine:interaction-state:t1:u1", "not-json{")
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        # Hydration should clear the malformed entry.
        assert storage.get_item("revturbine:interaction-state:t1:u1") is None
        # Tracker still functional.
        tracker.track(_input(interaction_type="dismiss"))
        assert tracker.check_suppression("p1", "u1")["suppressed"] is True

    def test_hydrate_skips_non_dict_values(self) -> None:
        storage = InMemoryStorage()
        # Valid JSON object but with a non-dict value mixed in.
        payload = json.dumps(
            {
                "valid:key": {
                    "updated_at": "2026-05-14T00:00:00Z",
                    "suppressed_until": 999_999_999_999,
                },
                "bad:key": "not-a-dict",
            }
        )
        storage.set_item("revturbine:interaction-state:t1:u1", payload)
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        # The valid entry survives; the bad one is silently ignored.
        # (We can only observe via behavior — bad:key wouldn't suppress
        # anything even if it had been kept.)
        tracker.track(_input(interaction_type="dismiss"))
        assert tracker.check_suppression("p1", "u1")["suppressed"] is True

    def test_hydrate_skips_non_object_root(self) -> None:
        storage = InMemoryStorage()
        # JSON-parseable but not an object.
        storage.set_item("revturbine:interaction-state:t1:u1", '"a string"')
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        # Silently treated as no state.
        assert tracker.check_suppression("p1", "u1") == {"suppressed": False}


class TestPreservesPriorState:
    def test_subsequent_interaction_overrides_suppression(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        # First a dismiss — long cooldown.
        tracker.track(_input(interaction_type="dismiss", metadata={"cooldown_ms": 100_000}))
        # Then remind_me_later — should overwrite suppression with a new
        # window keyed on `last_interaction_type`.
        freeze_time(2.0)
        tracker.track(
            _input(
                interaction_type="remind_me_later",
                metadata={"remind_after_seconds": 5},
            ),
        )
        result = tracker.check_suppression("p1", "u1")
        assert result["reason"] == "suppressed_until_remind_window"

    def test_impression_does_not_set_cooldown(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(_input(interaction_type="impression"))
        # Impression-only — no suppression should be set.
        assert tracker.check_suppression("p1", "u1") == {"suppressed": False}
