"""Impression history store implementations — Python port of
@revt-eng/core/state/impression-history-stores.ts.

- ``InMemoryImpressionStore`` — ephemeral, in-process.
- ``StorageImpressionStore`` — backed by ``RevTurbineStorage``
  (suitable for any sync storage backend).

Source: revturbine-scaffold/src/core/state/impression-history-stores.ts
"""

from __future__ import annotations

import contextlib
import json
import time
from typing import Any

from revturbine.core.state.impression_history_types import (
    TERMINAL_OUTCOMES,
    ImpressionHistoryStore,
    ImpressionQuery,
    ImpressionRecord,
)
from revturbine.core.state.storage import RevTurbineStorage

__all__ = ["InMemoryImpressionStore", "StorageImpressionStore"]


# ── Shared helpers ──────────────────────────────────────────────────────────


def _apply_query(
    records: list[ImpressionRecord],
    query: ImpressionQuery,
) -> list[ImpressionRecord]:
    """Filter ``records`` by placement IDs, outcomes, and ``since`` timestamp.

    Source: impression-history-stores.ts:147-165
    """
    filtered = records

    placement_ids = query.get("placement_ids")
    if placement_ids:
        ids_set = set(placement_ids)
        filtered = [r for r in filtered if r["placement_id"] in ids_set]

    outcomes = query.get("outcomes")
    if outcomes:
        outcomes_set = set(outcomes)
        filtered = [r for r in filtered if r["outcome"] in outcomes_set]

    since = query.get("since")
    if since:
        since_ms = _parse_iso_to_ms(since)
        filtered = [r for r in filtered if _parse_iso_to_ms(r["occurred_at"]) >= since_ms]

    return filtered


def _extract_retired_ids(records: list[ImpressionRecord]) -> set[str]:
    """Source: impression-history-stores.ts:168-176"""
    return {r["placement_id"] for r in records if r["outcome"] in TERMINAL_OUTCOMES}


def _extract_suppressed_placements(records: list[ImpressionRecord]) -> dict[str, str]:
    """Walk newest → oldest so the first hit per placement wins; drop any
    suppression whose ``suppressUntil`` is in the past.

    Source: impression-history-stores.ts:183-198
    """
    suppressed: dict[str, str] = {}
    now = int(time.time() * 1000)
    for record in reversed(records):
        if record["outcome"] != "suppressed":
            continue
        if record["placement_id"] in suppressed:
            continue
        metadata = record.get("metadata") or {}
        until = metadata.get("suppressUntil")
        if not isinstance(until, str):
            continue
        if _parse_iso_to_ms(until) > now:
            suppressed[record["placement_id"]] = until
    return suppressed


def _parse_iso_to_ms(iso: str) -> int:
    """Mirror JS's ``new Date(iso).getTime()``: returns ms since epoch.

    Tolerates the trailing ``Z`` form; falls back to ``0`` for unparseable
    input (matches JS's NaN → comparator-falsy semantics where the record
    is effectively excluded).
    """
    from datetime import datetime

    try:
        # Python's fromisoformat doesn't accept 'Z' until 3.11; normalize.
        normalized = iso.replace("Z", "+00:00") if iso.endswith("Z") else iso
        return int(datetime.fromisoformat(normalized).timestamp() * 1000)
    except (TypeError, ValueError):
        return 0


# ── In-memory store ─────────────────────────────────────────────────────────


class InMemoryImpressionStore(ImpressionHistoryStore):
    """Ephemeral, in-process impression history store. Suitable for SSR /
    testing.

    Source: impression-history-stores.ts:26-54
    """

    def __init__(self) -> None:
        self._records: dict[str, list[ImpressionRecord]] = {}

    def append(self, user_id: str, record: ImpressionRecord) -> None:
        self._records.setdefault(user_id, []).append(record)

    def query(
        self,
        user_id: str,
        query: ImpressionQuery | None = None,
    ) -> list[ImpressionRecord]:
        records = self._records.get(user_id, [])
        if query:
            records = _apply_query(records, query)
        # Reverse so most-recent is first, matching the TS slice().reverse().
        return list(reversed(records))

    def get_retired_placement_ids(self, user_id: str) -> set[str]:
        return _extract_retired_ids(self._records.get(user_id, []))

    def get_suppressed_placements(self, user_id: str) -> dict[str, str]:
        return _extract_suppressed_placements(self._records.get(user_id, []))

    def clear(self, user_id: str) -> None:
        self._records.pop(user_id, None)


# ── Storage-backed store ────────────────────────────────────────────────────


_STORAGE_PREFIX = "revturbine:impression-history"
_DEFAULT_MAX_RECORDS = 500


class StorageImpressionStore(ImpressionHistoryStore):
    """Impression history store backed by any ``RevTurbineStorage``.

    Records are serialized as a JSON array per user key. A configurable
    ``max_records`` limit prevents unbounded growth (default: 500).

    Source: impression-history-stores.ts:73-141
    """

    def __init__(
        self,
        *,
        storage: RevTurbineStorage,
        tenant_id: str,
        max_records: int = _DEFAULT_MAX_RECORDS,
    ) -> None:
        self._storage = storage
        self._tenant_id = tenant_id
        self._max_records = max_records

    def append(self, user_id: str, record: ImpressionRecord) -> None:
        records = self._load(user_id)
        records.append(record)
        if len(records) > self._max_records:
            del records[0 : len(records) - self._max_records]
        self._save(user_id, records)

    def query(
        self,
        user_id: str,
        query: ImpressionQuery | None = None,
    ) -> list[ImpressionRecord]:
        records = self._load(user_id)
        if query:
            records = _apply_query(records, query)
        return list(reversed(records))

    def get_retired_placement_ids(self, user_id: str) -> set[str]:
        return _extract_retired_ids(self._load(user_id))

    def get_suppressed_placements(self, user_id: str) -> dict[str, str]:
        return _extract_suppressed_placements(self._load(user_id))

    def clear(self, user_id: str) -> None:
        self._storage.remove_item(self._key(user_id))

    def _key(self, user_id: str) -> str:
        return f"{_STORAGE_PREFIX}:{self._tenant_id}:{user_id}"

    def _load(self, user_id: str) -> list[ImpressionRecord]:
        raw = self._storage.get_item(self._key(user_id))
        if not raw:
            return []
        try:
            parsed: Any = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return []
        return parsed if isinstance(parsed, list) else []

    def _save(self, user_id: str, records: list[ImpressionRecord]) -> None:
        with contextlib.suppress(Exception):
            self._storage.set_item(self._key(user_id), json.dumps(records))
