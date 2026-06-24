"""Tests for ``revturbine.core.state.impression_history_stores``."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest

from revturbine.core.state.impression_history_stores import (
    InMemoryImpressionStore,
    StorageImpressionStore,
)
from revturbine.core.state.impression_history_types import ImpressionRecord
from revturbine.core.state.storage import InMemoryStorage


def _record(**overrides: Any) -> ImpressionRecord:
    base: dict[str, Any] = {
        "placement_id": "p1",
        "outcome": "impressed",
        "occurred_at": "2026-05-14T00:00:00.000Z",
    }
    base.update(overrides)
    return base  # type: ignore[return-value]


@pytest.fixture
def freeze_now_ms(monkeypatch: pytest.MonkeyPatch) -> Callable[[int], None]:
    """Freeze the wall-clock used by suppression-window calculations."""
    state = {"ms": 1_000_000_000_000}

    def _fake_time() -> float:
        return state["ms"] / 1000

    monkeypatch.setattr(
        "revturbine.core.state.impression_history_stores.time.time",
        _fake_time,
    )

    def setter(now_ms: int) -> None:
        state["ms"] = now_ms

    return setter


# ── InMemoryImpressionStore ─────────────────────────────────────────────────


class TestInMemoryImpressionStore:
    def test_append_and_query(self) -> None:
        store = InMemoryImpressionStore()
        r1 = _record(placement_id="p1")
        r2 = _record(placement_id="p2")
        store.append("u1", r1)
        store.append("u1", r2)
        # Newest first per the TS contract.
        assert store.query("u1") == [r2, r1]

    def test_query_with_placement_filter(self) -> None:
        store = InMemoryImpressionStore()
        store.append("u1", _record(placement_id="p1"))
        store.append("u1", _record(placement_id="p2"))
        store.append("u1", _record(placement_id="p3"))
        result = store.query("u1", {"placement_ids": ["p1", "p3"]})
        assert {r["placement_id"] for r in result} == {"p1", "p3"}

    def test_query_with_outcome_filter(self) -> None:
        store = InMemoryImpressionStore()
        store.append("u1", _record(outcome="impressed"))
        store.append("u1", _record(outcome="dismissed"))
        store.append("u1", _record(outcome="clicked_thru"))
        result = store.query("u1", {"outcomes": ["dismissed", "clicked_thru"]})
        assert all(r["outcome"] in ("dismissed", "clicked_thru") for r in result)
        assert len(result) == 2

    def test_query_with_since(self) -> None:
        store = InMemoryImpressionStore()
        store.append("u1", _record(occurred_at="2026-05-13T00:00:00.000Z"))
        store.append("u1", _record(occurred_at="2026-05-14T00:00:00.000Z"))
        store.append("u1", _record(occurred_at="2026-05-15T00:00:00.000Z"))
        result = store.query("u1", {"since": "2026-05-14T00:00:00.000Z"})
        assert len(result) == 2  # Includes the boundary; matches JS >=.

    def test_get_retired_placement_ids(self) -> None:
        store = InMemoryImpressionStore()
        store.append("u1", _record(placement_id="p1", outcome="impressed"))
        store.append("u1", _record(placement_id="p2", outcome="dismissed"))
        store.append("u1", _record(placement_id="p3", outcome="clicked_thru"))
        store.append("u1", _record(placement_id="p4", outcome="suppressed"))
        retired = store.get_retired_placement_ids("u1")
        assert retired == {"p2", "p3"}  # suppressed is NOT terminal.

    def test_get_suppressed_placements_only_active(
        self,
        freeze_now_ms: Callable[[int], None],
    ) -> None:
        freeze_now_ms(1_700_000_000_000)
        store = InMemoryImpressionStore()
        # Active suppression (suppressUntil > now).
        store.append(
            "u1",
            _record(
                placement_id="p1",
                outcome="suppressed",
                metadata={"suppressUntil": "2030-01-01T00:00:00.000Z"},
            ),
        )
        # Expired suppression.
        store.append(
            "u1",
            _record(
                placement_id="p2",
                outcome="suppressed",
                metadata={"suppressUntil": "2020-01-01T00:00:00.000Z"},
            ),
        )
        suppressed = store.get_suppressed_placements("u1")
        assert "p1" in suppressed
        assert "p2" not in suppressed

    def test_get_suppressed_walks_newest_first_active_wins(
        self,
        freeze_now_ms: Callable[[int], None],
    ) -> None:
        # Algorithm: walk newest → oldest; the placement is added to the
        # result map only when an *active* suppression record is found.
        # Expired records are silently skipped, leaving an older active
        # record free to win.
        freeze_now_ms(1_700_000_000_000)
        store = InMemoryImpressionStore()
        # Older active record first, then a newer expired one.
        store.append(
            "u1",
            _record(
                placement_id="p1",
                outcome="suppressed",
                metadata={"suppressUntil": "2030-01-01T00:00:00.000Z"},
            ),
        )
        store.append(
            "u1",
            _record(
                placement_id="p1",
                outcome="suppressed",
                metadata={"suppressUntil": "2020-01-01T00:00:00.000Z"},
            ),
        )
        # Newest is expired → skipped; older active wins.
        assert store.get_suppressed_placements("u1") == {
            "p1": "2030-01-01T00:00:00.000Z",
        }

    def test_get_suppressed_two_active_newest_wins(
        self,
        freeze_now_ms: Callable[[int], None],
    ) -> None:
        # When BOTH records are active, the newest wins (first-hit rule
        # combined with newest-first traversal).
        freeze_now_ms(1_700_000_000_000)
        store = InMemoryImpressionStore()
        store.append(
            "u1",
            _record(
                placement_id="p1",
                outcome="suppressed",
                metadata={"suppressUntil": "2030-01-01T00:00:00.000Z"},
            ),
        )
        store.append(
            "u1",
            _record(
                placement_id="p1",
                outcome="suppressed",
                metadata={"suppressUntil": "2031-01-01T00:00:00.000Z"},
            ),
        )
        assert store.get_suppressed_placements("u1") == {
            "p1": "2031-01-01T00:00:00.000Z",
        }

    def test_clear_user(self) -> None:
        store = InMemoryImpressionStore()
        store.append("u1", _record())
        store.append("u2", _record())
        store.clear("u1")
        assert store.query("u1") == []
        assert len(store.query("u2")) == 1

    def test_query_unknown_user_returns_empty(self) -> None:
        store = InMemoryImpressionStore()
        assert store.query("missing") == []

    def test_clear_unknown_user_is_noop(self) -> None:
        store = InMemoryImpressionStore()
        store.clear("missing")  # No raise.

    def test_get_suppressed_skips_records_without_suppress_until(self) -> None:
        store = InMemoryImpressionStore()
        store.append("u1", _record(outcome="suppressed"))  # no metadata
        store.append("u1", _record(outcome="suppressed", metadata={}))
        store.append(
            "u1",
            _record(
                outcome="suppressed",
                metadata={"suppressUntil": 12345},  # not a string
            ),
        )
        assert store.get_suppressed_placements("u1") == {}


# ── StorageImpressionStore ──────────────────────────────────────────────────


class TestStorageImpressionStore:
    def test_append_and_query(self) -> None:
        storage = InMemoryStorage()
        store = StorageImpressionStore(storage=storage, tenant_id="t1")
        r1 = _record(placement_id="p1")
        r2 = _record(placement_id="p2")
        store.append("u1", r1)
        store.append("u1", r2)
        assert store.query("u1") == [r2, r1]

    def test_persist_across_instances(self) -> None:
        storage = InMemoryStorage()
        store_a = StorageImpressionStore(storage=storage, tenant_id="t1")
        store_a.append("u1", _record(placement_id="p1"))
        # New instance over the same storage should see the prior write.
        store_b = StorageImpressionStore(storage=storage, tenant_id="t1")
        assert len(store_b.query("u1")) == 1

    def test_namespaced_by_tenant(self) -> None:
        storage = InMemoryStorage()
        a = StorageImpressionStore(storage=storage, tenant_id="t1")
        b = StorageImpressionStore(storage=storage, tenant_id="t2")
        a.append("u1", _record(placement_id="p1"))
        # Different tenant — independent storage namespace.
        assert b.query("u1") == []

    def test_max_records_trims_oldest(self) -> None:
        storage = InMemoryStorage()
        store = StorageImpressionStore(storage=storage, tenant_id="t1", max_records=3)
        store.append("u1", _record(placement_id="p1"))
        store.append("u1", _record(placement_id="p2"))
        store.append("u1", _record(placement_id="p3"))
        store.append("u1", _record(placement_id="p4"))
        records = store.query("u1")
        # Newest first → p4, p3, p2; p1 evicted.
        assert [r["placement_id"] for r in records] == ["p4", "p3", "p2"]

    def test_clear_removes_persisted_state(self) -> None:
        storage = InMemoryStorage()
        store = StorageImpressionStore(storage=storage, tenant_id="t1")
        store.append("u1", _record())
        store.clear("u1")
        # Fresh instance should see nothing.
        store2 = StorageImpressionStore(storage=storage, tenant_id="t1")
        assert store2.query("u1") == []

    def test_get_retired_and_suppressed(
        self,
        freeze_now_ms: Callable[[int], None],
    ) -> None:
        freeze_now_ms(1_700_000_000_000)
        storage = InMemoryStorage()
        store = StorageImpressionStore(storage=storage, tenant_id="t1")
        store.append("u1", _record(placement_id="dismissed_p", outcome="dismissed"))
        store.append(
            "u1",
            _record(
                placement_id="suppressed_p",
                outcome="suppressed",
                metadata={"suppressUntil": "2030-01-01T00:00:00.000Z"},
            ),
        )
        assert store.get_retired_placement_ids("u1") == {"dismissed_p"}
        assert "suppressed_p" in store.get_suppressed_placements("u1")

    def test_malformed_json_treated_as_empty(self) -> None:
        storage = InMemoryStorage()
        storage.set_item("revturbine:impression-history:t1:u1", "broken{")
        store = StorageImpressionStore(storage=storage, tenant_id="t1")
        assert store.query("u1") == []

    def test_non_array_payload_treated_as_empty(self) -> None:
        storage = InMemoryStorage()
        storage.set_item(
            "revturbine:impression-history:t1:u1",
            json.dumps({"not": "an array"}),
        )
        store = StorageImpressionStore(storage=storage, tenant_id="t1")
        assert store.query("u1") == []

    def test_query_unknown_user_empty(self) -> None:
        storage = InMemoryStorage()
        store = StorageImpressionStore(storage=storage, tenant_id="t1")
        assert store.query("missing") == []
