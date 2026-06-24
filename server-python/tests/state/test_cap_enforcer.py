"""Tests for ``revturbine.core.state.cap_enforcer``."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest

from revturbine.core.state.cap_enforcer import CapEnforcer
from revturbine.core.state.storage import InMemoryStorage


@pytest.fixture
def freeze_time(monkeypatch: pytest.MonkeyPatch) -> Callable[[float], None]:
    """Freeze ``time.time`` across the cap_enforcer module."""
    state = {"now": 1_000_000.0}

    def _fake_time() -> float:
        return state["now"]

    monkeypatch.setattr("revturbine.core.state.cap_enforcer.time.time", _fake_time)

    def setter(now_seconds: float) -> None:
        state["now"] = now_seconds

    return setter


def _placement_output(**fields: Any) -> dict[str, Any]:
    """Build a minimal PlacementOutput dict."""
    base: dict[str, Any] = {
        "output_id": "out_1",
        "surface": {"type": "banner"},
    }
    base.update(fields)
    return base


def _with_caps(
    rules_count: int = 2, period: str = "day", cooldown_days: int | None = None
) -> dict[str, Any]:
    caps: dict[str, Any] = {"max_per_period": {"count": rules_count, "period": period}}
    if cooldown_days is not None:
        caps["cooldown_days"] = cooldown_days
    return _placement_output(content={"caps": caps})


class TestNoPolicies:
    def test_no_caps_anywhere_allows(self) -> None:
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        assert enforcer.enforce(_placement_output()) == {"allowed": True}


class TestCapRules:
    def test_within_cap_allows_and_records(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output = _with_caps(rules_count=2, period="day")
        assert enforcer.enforce(output) == {"allowed": True}
        # Second presentation still within cap.
        assert enforcer.enforce(output) == {"allowed": True}

    def test_cap_exceeded_denies(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output = _with_caps(rules_count=2, period="day")
        enforcer.enforce(output)
        enforcer.enforce(output)
        # Third presentation hits the cap.
        result = enforcer.enforce(output)
        assert result == {
            "allowed": False,
            "reason": "suppressed_by_payload_cap_day",
        }

    def test_session_cap_uses_window_zero(self, freeze_time: Callable[[float], None]) -> None:
        # session windows start from 0 — every prior presentation counts.
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output = _with_caps(rules_count=1, period="session")
        assert enforcer.enforce(output)["allowed"] is True
        # Even with a far-future "now", session cap still hits because
        # window_start = 0 covers all history.
        freeze_time(1_000_000_000.0)
        assert enforcer.enforce(output)["allowed"] is False

    def test_day_cap_window_drops_old_entries(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output = _with_caps(rules_count=1, period="day")
        assert enforcer.enforce(output)["allowed"] is True
        # 25h later — outside the 24h window. Earlier presentation falls
        # off and the cap is fresh again.
        freeze_time(1.0 + 25 * 60 * 60)
        assert enforcer.enforce(output)["allowed"] is True


class TestCooldown:
    def test_cooldown_blocks_within_window(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        # Cap = 5 (effectively unbounded for these calls); cooldown = 1 day.
        output = _with_caps(rules_count=5, period="day", cooldown_days=1)
        assert enforcer.enforce(output)["allowed"] is True
        # Within cooldown — denied with cooldown reason.
        freeze_time(1.0 + 12 * 60 * 60)
        assert enforcer.enforce(output) == {
            "allowed": False,
            "reason": "suppressed_by_payload_cooldown",
        }

    def test_cooldown_clears_after_expiry(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output = _with_caps(rules_count=5, period="day", cooldown_days=1)
        enforcer.enforce(output)
        freeze_time(1.0 + 25 * 60 * 60)
        # Past 1-day cooldown — allowed.
        assert enforcer.enforce(output)["allowed"] is True


class TestPolicyExtraction:
    def test_caps_at_root_recognized(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output: dict[str, Any] = {
            "output_id": "o",
            "surface": {"type": "banner"},
            "caps": {"max_per_period": {"count": 1, "period": "day"}},
        }
        assert enforcer.enforce(output)["allowed"] is True
        assert enforcer.enforce(output)["allowed"] is False

    def test_caps_at_content_payload(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output: dict[str, Any] = {
            "output_id": "o",
            "surface": {"type": "banner"},
            "content": {
                "payload": {
                    "caps": {"max_per_period": {"count": 1, "period": "day"}},
                },
            },
        }
        assert enforcer.enforce(output)["allowed"] is True
        assert enforcer.enforce(output)["allowed"] is False

    def test_caps_at_content_placement(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output: dict[str, Any] = {
            "output_id": "o",
            "surface": {"type": "banner"},
            "content": {
                "placement": {
                    "caps": {"max_per_period": {"count": 1, "period": "day"}},
                },
            },
        }
        assert enforcer.enforce(output)["allowed"] is True
        assert enforcer.enforce(output)["allowed"] is False

    def test_caps_at_content_surface(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output: dict[str, Any] = {
            "output_id": "o",
            "surface": {"type": "banner"},
            "content": {
                "surface": {
                    "caps": {"max_per_period": {"count": 1, "period": "day"}},
                },
            },
        }
        assert enforcer.enforce(output)["allowed"] is True
        assert enforcer.enforce(output)["allowed"] is False

    def test_invalid_cap_rule_silently_dropped(self, freeze_time: Callable[[float], None]) -> None:
        # Bad shape — no rules collected, so no enforcement happens.
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output: dict[str, Any] = {
            "output_id": "o",
            "surface": {"type": "banner"},
            "content": {"caps": {"max_per_period": {"count": 0, "period": "day"}}},
        }
        # Even though there's a caps block, the rule is invalid (count=0)
        # and the policy has no rules + no cooldown → effectively allows.
        for _ in range(10):
            assert enforcer.enforce(output)["allowed"] is True


class TestKeyIsolation:
    def test_different_output_id_separate_state(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        a = _with_caps(rules_count=1, period="day")
        a["output_id"] = "out_A"
        b = _with_caps(rules_count=1, period="day")
        b["output_id"] = "out_B"
        # Each cap is per-output.
        assert enforcer.enforce(a)["allowed"] is True
        assert enforcer.enforce(b)["allowed"] is True

    def test_different_surface_type_separate_state(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        banner = _with_caps(rules_count=1, period="day")
        modal = _with_caps(rules_count=1, period="day")
        modal["surface"] = {"type": "modal"}
        assert enforcer.enforce(banner)["allowed"] is True
        assert enforcer.enforce(modal)["allowed"] is True


class TestPersistence:
    def test_persist_then_hydrate_roundtrip(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output = _with_caps(rules_count=2, period="day")
        enforcer.enforce(output)
        enforcer.enforce(output)

        # Fresh enforcer from same storage should see the prior state.
        enforcer2 = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        assert enforcer2.enforce(output) == {
            "allowed": False,
            "reason": "suppressed_by_payload_cap_day",
        }

    def test_namespaced_by_tenant_and_user(self, freeze_time: Callable[[float], None]) -> None:
        freeze_time(1.0)
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        output = _with_caps(rules_count=1, period="day")
        enforcer.enforce(output)
        # Different tenant — fresh state.
        other = CapEnforcer(storage=storage, tenant_id="t2", user_id="u1")
        assert other.enforce(output)["allowed"] is True

    def test_malformed_json_is_dropped(self) -> None:
        storage = InMemoryStorage()
        storage.set_item("revturbine:presentation-caps:t1:u1", "broken{")
        CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        # Hydration should clear the bad entry.
        assert storage.get_item("revturbine:presentation-caps:t1:u1") is None

    def test_hydrate_filters_malformed_entries(self) -> None:
        storage = InMemoryStorage()
        payload = json.dumps(
            {
                "good:key": {"seen_at": [1, 2, 3], "cooldown_until": 100},
                "bad:list": {"seen_at": "not-a-list"},
                "bad:value": "not-a-dict",
                "garbage:cooldown": {"seen_at": [], "cooldown_until": "nan"},
            }
        )
        storage.set_item("revturbine:presentation-caps:t1:u1", payload)
        # Should hydrate without raising.
        CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
