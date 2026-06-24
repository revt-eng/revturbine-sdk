"""Tests for ``revturbine.core.state.impression_history``."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from revturbine.core.state.impression_history import (
    DEFAULT_SUPPRESSION_MS,
    ImpressionHistory,
)
from revturbine.core.state.impression_history_stores import InMemoryImpressionStore


@pytest.fixture
def freeze_time(monkeypatch: pytest.MonkeyPatch) -> Callable[[float], None]:
    """Freeze ``time.time`` across both impression_history modules so the
    suppression-window math is deterministic."""
    state = {"now": 1_700_000_000.0}

    def _fake_time() -> float:
        return state["now"]

    monkeypatch.setattr("revturbine.core.state.impression_history.time.time", _fake_time)
    monkeypatch.setattr(
        "revturbine.core.state.impression_history_stores.time.time",
        _fake_time,
    )

    def setter(now_seconds: float) -> None:
        state["now"] = now_seconds

    return setter


def _make() -> tuple[InMemoryImpressionStore, ImpressionHistory]:
    store = InMemoryImpressionStore()
    history = ImpressionHistory(store=store, user_id="u1")
    return store, history


class TestRecording:
    def test_record_impression_appends(self) -> None:
        store, history = _make()
        history.record_impression("p1")
        records = store.query("u1")
        assert len(records) == 1
        assert records[0]["placement_id"] == "p1"
        assert records[0]["outcome"] == "impressed"

    def test_record_dismissal_retires_in_cache(self) -> None:
        _, history = _make()
        history.record_dismissal("p1")
        # is_retired_sync requires the cache; recording side-warms it.
        assert history.is_retired_sync("p1") is True
        assert history.is_retired_sync("p2") is False

    def test_record_click_thru_retires_in_cache(self) -> None:
        _, history = _make()
        history.record_click_thru("p1")
        assert history.is_retired_sync("p1") is True

    def test_record_suppression_warms_suppressed_cache(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1_700_000_000.0)
        _, history = _make()
        history.record_suppression("p1", duration_ms=60_000)
        assert history.is_suppressed_sync("p1") is True

    def test_optional_fields_make_it_into_record(self) -> None:
        store, history = _make()
        history.record_impression(
            "p1",
            payload_id="pay_1",
            surface_template_id="banner",
            metadata={"k": "v"},
        )
        record = store.query("u1")[0]
        assert record["payload_id"] == "pay_1"
        assert record["surface_template_id"] == "banner"
        assert record["metadata"] == {"k": "v"}

    def test_record_suppression_default_duration(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1_700_000_000.0)
        _, history = _make()
        history.record_suppression("p1")
        # Just before the default window expires — still suppressed.
        freeze_time(1_700_000_000.0 + DEFAULT_SUPPRESSION_MS / 1000 - 60)
        assert history.is_suppressed_sync("p1") is True
        # Past the window — cache cleans up.
        freeze_time(1_700_000_000.0 + DEFAULT_SUPPRESSION_MS / 1000 + 60)
        assert history.is_suppressed_sync("p1") is False


class TestQueries:
    def test_is_retired_async_warms_cache(self) -> None:
        store, history = _make()
        store.append(
            "u1",
            {
                "placement_id": "p1",
                "outcome": "dismissed",
                "occurred_at": "2026-05-14T00:00:00.000Z",
            },
        )
        # is_retired hits the store and caches.
        assert history.is_retired("p1") is True
        # Subsequent calls hit the warm cache.
        assert history.is_retired_sync("p1") is True

    def test_is_retired_sync_cold_cache_returns_false(self) -> None:
        store, history = _make()
        store.append(
            "u1",
            {
                "placement_id": "p1",
                "outcome": "dismissed",
                "occurred_at": "2026-05-14T00:00:00.000Z",
            },
        )
        # Cold cache (never hydrated, never recorded) → False.
        assert history.is_retired_sync("p1") is False

    def test_is_hidden_sync_combines_retired_and_suppressed(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1_700_000_000.0)
        _, history = _make()
        history.record_dismissal("retired_p")
        history.record_suppression("suppressed_p", duration_ms=60_000)
        history.record_impression("visible_p")
        assert history.is_hidden_sync("retired_p") is True
        assert history.is_hidden_sync("suppressed_p") is True
        assert history.is_hidden_sync("visible_p") is False

    def test_query_history_passes_through_to_store(self) -> None:
        _, history = _make()
        history.record_impression("p1")
        history.record_dismissal("p2")
        all_records = history.query_history()
        assert len(all_records) == 2
        # With filter.
        dismissed = history.query_history({"outcomes": ["dismissed"]})
        assert len(dismissed) == 1
        assert dismissed[0]["placement_id"] == "p2"

    def test_is_suppressed_sync_evicts_expired(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1_700_000_000.0)
        _, history = _make()
        history.record_suppression("p1", duration_ms=10_000)
        # Within window.
        assert history.is_suppressed_sync("p1") is True
        # Past window — expired entry gets evicted from the cache.
        freeze_time(1_700_000_000.0 + 11)
        assert history.is_suppressed_sync("p1") is False
        # Should not raise on second call after eviction.
        assert history.is_suppressed_sync("p1") is False


class TestLifecycle:
    def test_hydrate_pre_warms_caches(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1_700_000_000.0)
        store = InMemoryImpressionStore()
        store.append(
            "u1",
            {
                "placement_id": "retired_p",
                "outcome": "dismissed",
                "occurred_at": "2026-05-14T00:00:00.000Z",
            },
        )
        store.append(
            "u1",
            {
                "placement_id": "suppressed_p",
                "outcome": "suppressed",
                "occurred_at": "2026-05-14T00:00:00.000Z",
                "metadata": {"suppressUntil": "2030-01-01T00:00:00.000Z"},
            },
        )
        history = ImpressionHistory(store=store, user_id="u1")
        history.hydrate()
        assert history.is_retired_sync("retired_p") is True
        assert history.is_suppressed_sync("suppressed_p") is True

    def test_reset_clears_history(self) -> None:
        store, history = _make()
        history.record_dismissal("p1")
        history.reset()
        # Store is empty, cache is empty.
        assert store.query("u1") == []
        assert history.is_retired_sync("p1") is False

    def test_set_user_id_clears_caches(self) -> None:
        store, history = _make()
        history.record_dismissal("p1")
        assert history.is_retired_sync("p1") is True
        # Switch user — caches go cold; sync check returns False (cache cold).
        history.set_user_id("u2")
        assert history.is_retired_sync("p1") is False

    def test_set_user_id_routes_subsequent_records(self) -> None:
        store, history = _make()
        history.record_impression("p1")
        history.set_user_id("u2")
        history.record_impression("p2")
        assert len(store.query("u1")) == 1
        assert len(store.query("u2")) == 1

    def test_get_retired_ids_idempotent(self) -> None:
        store = InMemoryImpressionStore()
        store.append(
            "u1",
            {
                "placement_id": "p1",
                "outcome": "dismissed",
                "occurred_at": "2026-05-14T00:00:00.000Z",
            },
        )
        history = ImpressionHistory(store=store, user_id="u1")
        first = history.get_retired_ids()
        second = history.get_retired_ids()
        # Same set returned (cached).
        assert first is second


class TestRetireInCacheBranches:
    def test_retire_in_cold_cache_initializes(self) -> None:
        # Branch coverage: _retire_in_cache initializes when cache is None.
        _, history = _make()
        assert history.is_retired_sync("p1") is False  # cold
        history.record_dismissal("p1")
        assert history.is_retired_sync("p1") is True

    def test_suppress_in_cold_cache_initializes(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1_700_000_000.0)
        _, history = _make()
        assert history.is_suppressed_sync("p1") is False  # cold
        history.record_suppression("p1", duration_ms=60_000)
        assert history.is_suppressed_sync("p1") is True


class TestRecordPersistence:
    def test_records_include_iso_timestamp(self) -> None:
        store, history = _make()
        history.record_impression("p1")
        record = store.query("u1")[0]
        # ISO format with millisecond precision and Z suffix per JS parity.
        assert record["occurred_at"].endswith("Z")
        assert "T" in record["occurred_at"]


def _record(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "placement_id": "p1",
        "outcome": "impressed",
        "occurred_at": "2026-05-14T00:00:00.000Z",
    }
    base.update(overrides)
    return base
