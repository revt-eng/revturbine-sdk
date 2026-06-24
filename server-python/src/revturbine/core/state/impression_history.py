"""ImpressionHistory — Python port of @revt-eng/core/state/impression-history.ts.

Records and queries placement impression / interaction history; wraps any
``ImpressionHistoryStore``. Provides hot-path retired and time-based
suppression caches for synchronous resolver checks.

Source: revturbine-scaffold/src/core/state/impression-history.ts
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from revturbine.core.state.impression_history_types import (
    DEFAULT_SUPPRESSION_MS,
    ImpressionHistoryStore,
    ImpressionOutcome,
    ImpressionQuery,
    ImpressionRecord,
)

__all__ = ["DEFAULT_SUPPRESSION_MS", "ImpressionHistory", "ImpressionHistoryOptions"]


def _now_iso() -> str:
    """Match JS's ``new Date().toISOString()`` output (ms precision, ``Z`` suffix)."""
    return datetime.now(tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _suppress_until_iso(duration_ms: int) -> str:
    """Match JS's ``new Date(Date.now() + ms).toISOString()``."""
    target = datetime.fromtimestamp(time.time() + duration_ms / 1000, tz=timezone.utc)
    return target.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ImpressionHistoryOptions(dict[str, Any]):
    """Constructor argument bundle. Kept as a dict for parity with TS object
    literals; field access is via the keyword params on ``ImpressionHistory``."""


class ImpressionHistory:
    """Records and queries placement impression / interaction history.

    Source: impression-history.ts:29-239
    """

    def __init__(
        self,
        *,
        store: ImpressionHistoryStore,
        user_id: str,
        default_suppression_ms: int = DEFAULT_SUPPRESSION_MS,
    ) -> None:
        self._store = store
        self._user_id = user_id
        self._default_suppression_ms = default_suppression_ms
        self._retired_cache: set[str] | None = None
        self._suppressed_cache: dict[str, str] | None = None

    # ── Recording ──────────────────────────────────────────────────────────

    def record_impression(
        self,
        placement_id: str,
        payload_id: str | None = None,
        surface_template_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Source: impression-history.ts:55-62"""
        self._append_record(placement_id, "impressed", payload_id, surface_template_id, metadata)

    def record_dismissal(
        self,
        placement_id: str,
        payload_id: str | None = None,
        surface_template_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Records a dismissal (terminal — placement is permanently retired).

        Source: impression-history.ts:68-76
        """
        self._append_record(placement_id, "dismissed", payload_id, surface_template_id, metadata)
        self._retire_in_cache(placement_id)

    def record_click_thru(
        self,
        placement_id: str,
        payload_id: str | None = None,
        surface_template_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Records a click-through (terminal — placement is permanently retired).

        Source: impression-history.ts:82-90
        """
        self._append_record(placement_id, "clicked_thru", payload_id, surface_template_id, metadata)
        self._retire_in_cache(placement_id)

    def record_suppression(
        self,
        placement_id: str,
        payload_id: str | None = None,
        surface_template_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
    ) -> None:
        """Records a time-based suppression. The ``suppressUntil`` timestamp
        is appended to ``metadata`` so downstream queries can recover the
        window without external context.

        Source: impression-history.ts:98-112
        """
        ms = duration_ms if duration_ms is not None else self._default_suppression_ms
        suppress_until = _suppress_until_iso(ms)
        merged_metadata: dict[str, Any] = {**(metadata or {}), "suppressUntil": suppress_until}
        self._append_record(
            placement_id, "suppressed", payload_id, surface_template_id, merged_metadata
        )
        self._suppress_in_cache(placement_id, suppress_until)

    # ── Querying ───────────────────────────────────────────────────────────

    def is_retired(self, placement_id: str) -> bool:
        """Source: impression-history.ts:121-124"""
        return placement_id in self.get_retired_ids()

    def get_retired_ids(self) -> set[str]:
        """Returns the set of retired placement IDs and warms the cache.

        Source: impression-history.ts:130-135
        """
        if self._retired_cache is not None:
            return self._retired_cache
        retired = self._store.get_retired_placement_ids(self._user_id)
        self._retired_cache = retired
        return retired

    def is_retired_sync(self, placement_id: str) -> bool:
        """Synchronous check — only valid after the cache is warm. Cold cache
        returns False.

        Source: impression-history.ts:141-143
        """
        return self._retired_cache is not None and placement_id in self._retired_cache

    def is_suppressed_sync(self, placement_id: str) -> bool:
        """Synchronous check for time-based suppression. Expired entries are
        evicted from the cache as a side effect.

        Source: impression-history.ts:149-157
        """
        if self._suppressed_cache is None:
            return False
        until = self._suppressed_cache.get(placement_id)
        if until is None:
            return False
        if _parse_iso_to_ms(until) > int(time.time() * 1000):
            return True
        del self._suppressed_cache[placement_id]
        return False

    def is_hidden_sync(self, placement_id: str) -> bool:
        """Whether the placement should not be shown (retired OR suppressed).

        Source: impression-history.ts:162-164
        """
        return self.is_retired_sync(placement_id) or self.is_suppressed_sync(placement_id)

    def query_history(self, query: ImpressionQuery | None = None) -> list[ImpressionRecord]:
        """Source: impression-history.ts:169-171"""
        return self._store.query(self._user_id, query)

    # ── Lifecycle ──────────────────────────────────────────────────────────

    def hydrate(self) -> None:
        """Pre-warm the retired and suppressed caches from the store. Call
        during SDK initialization for synchronous access.

        Source: impression-history.ts:181-184
        """
        self._retired_cache = self._store.get_retired_placement_ids(self._user_id)
        self._suppressed_cache = self._store.get_suppressed_placements(self._user_id)

    def reset(self) -> None:
        """Clear all impression history for this user.

        Source: impression-history.ts:189-193
        """
        self._store.clear(self._user_id)
        self._retired_cache = set()
        self._suppressed_cache = {}

    def set_user_id(self, user_id: str) -> None:
        """Switch user identity — clears caches and points at a new user.

        Source: impression-history.ts:198-202
        """
        self._user_id = user_id
        self._retired_cache = None
        self._suppressed_cache = None

    # ── Internal ───────────────────────────────────────────────────────────

    def _append_record(
        self,
        placement_id: str,
        outcome: ImpressionOutcome,
        payload_id: str | None,
        surface_template_id: str | None,
        metadata: dict[str, Any] | None,
    ) -> None:
        record: ImpressionRecord = ImpressionRecord(
            placement_id=placement_id,
            outcome=outcome,
            occurred_at=_now_iso(),
        )
        if payload_id:
            record["payload_id"] = payload_id
        if surface_template_id:
            record["surface_template_id"] = surface_template_id
        if metadata:
            record["metadata"] = metadata
        self._store.append(self._user_id, record)

    def _retire_in_cache(self, placement_id: str) -> None:
        if self._retired_cache is None:
            self._retired_cache = set()
        self._retired_cache.add(placement_id)

    def _suppress_in_cache(self, placement_id: str, suppress_until: str) -> None:
        if self._suppressed_cache is None:
            self._suppressed_cache = {}
        self._suppressed_cache[placement_id] = suppress_until


def _parse_iso_to_ms(iso: str) -> int:
    """Mirror JS ``new Date(iso).getTime()``. Tolerates trailing ``Z``."""
    try:
        normalized = iso.replace("Z", "+00:00") if iso.endswith("Z") else iso
        return int(datetime.fromisoformat(normalized).timestamp() * 1000)
    except (TypeError, ValueError):
        return 0
