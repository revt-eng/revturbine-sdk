"""ImpressionHistory — Python port of @revt-eng/core/state/impression-history.ts.

Records and queries placement impression / interaction history; wraps any
``ImpressionHistoryStore``. Provides hot-path time-based
suppression caches for synchronous resolver checks.

Source: revturbine-scaffold/src/core/state/impression-history.ts
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from revturbine.core.helpers import category_bucket
from revturbine.core.state.impression_history_types import (
    DEFAULT_DISMISS_COOLDOWN_MS,
    DEFAULT_SUPPRESSION_MS,
    ImpressionHistoryStore,
    ImpressionOutcome,
    ImpressionQuery,
    ImpressionRecord,
)

__all__ = [
    "DEFAULT_DISMISS_COOLDOWN_MS",
    "DEFAULT_SUPPRESSION_MS",
    "ImpressionHistory",
    "ImpressionHistoryOptions",
]


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
        default_dismiss_cooldown_ms: int = DEFAULT_DISMISS_COOLDOWN_MS,
    ) -> None:
        self._store = store
        self._user_id = user_id
        self._default_suppression_ms = default_suppression_ms
        self._default_dismiss_cooldown_ms = default_dismiss_cooldown_ms
        self._explicit_suppressed_cache: dict[str, str] = {}
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
        cooldown_ms: int | None = None,
    ) -> None:
        """Records a dismissal. Time-boxed: the placement is hidden for the
        dismiss cooldown (``cooldown_after_dismiss_days``, default 7 days) and
        re-shows once it elapses. NOT permanent (plan 167, Q-1).

        Source: impression-history.ts:68-76
        """
        ms = cooldown_ms if cooldown_ms is not None else self._default_dismiss_cooldown_ms
        suppress_until = _suppress_until_iso(ms)
        merged_metadata: dict[str, Any] = {**(metadata or {}), "suppressUntil": suppress_until}
        self._append_record(
            placement_id, "dismissed", payload_id, surface_template_id, merged_metadata
        )
        self._suppress_in_cache(placement_id, suppress_until)

    def record_click_thru(
        self,
        placement_id: str,
        payload_id: str | None = None,
        surface_template_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        cooldown_ms: int | None = None,
    ) -> None:
        """Records a bare click-through — clicked but not confirmed complete
        (e.g. abandoned checkout). Treated as a dismiss cooldown; the placement
        may return. For a confirmed conversion use ``record_conversion``
        (plan 167, Q-1).

        Source: impression-history.ts:82-90
        """
        ms = cooldown_ms if cooldown_ms is not None else self._default_dismiss_cooldown_ms
        suppress_until = _suppress_until_iso(ms)
        merged_metadata: dict[str, Any] = {**(metadata or {}), "suppressUntil": suppress_until}
        self._append_record(
            placement_id, "clicked_thru", payload_id, surface_template_id, merged_metadata
        )
        self._suppress_in_cache(placement_id, suppress_until)

    def record_conversion(
        self,
        placement_id: str,
        payload_id: str | None = None,
        surface_template_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Records conversion analytics without changing eligibility (plan 254).

        Source: impression-history.ts:record_conversion
        """
        self._append_record(
            placement_id, "cta_completed", payload_id, surface_template_id, metadata
        )

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
        self._explicit_suppressed_cache[placement_id] = suppress_until

    # ── Querying ───────────────────────────────────────────────────────────

    def is_retired(self, placement_id: str) -> bool:
        """Compatibility method: conversion no longer retires placements."""
        return False

    def get_retired_ids(self) -> set[str]:
        """Compatibility method: no interaction permanently retires a placement."""
        return set()

    def is_retired_sync(self, placement_id: str) -> bool:
        """Compatibility method: conversion no longer retires placements."""
        return False

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

    def is_hidden_sync(self, placement_id: str, category: str | None = None) -> bool:
        """Fixed/Gated bypass user cooldowns, retaining explicit suppression."""
        until = self._explicit_suppressed_cache.get(placement_id)
        if until and _parse_iso_to_ms(until) > int(time.time() * 1000):
            return True
        self._explicit_suppressed_cache.pop(placement_id, None)
        if category_bucket(category or "") <= 1:
            return False
        return self.is_suppressed_sync(placement_id)

    def query_history(self, query: ImpressionQuery | None = None) -> list[ImpressionRecord]:
        """Source: impression-history.ts:169-171"""
        return self._store.query(self._user_id, query)

    # ── Lifecycle ──────────────────────────────────────────────────────────

    def hydrate(self) -> None:
        """Pre-warm the timed suppression caches from the store. Call
        during SDK initialization for synchronous access.

        Source: impression-history.ts:181-184
        """
        self._suppressed_cache = self._store.get_suppressed_placements(self._user_id)
        self._explicit_suppressed_cache = {}
        for record in self._store.query(self._user_id, ImpressionQuery(outcomes=["suppressed"])):
            until = (record.get("metadata") or {}).get("suppressUntil")
            if (
                record["outcome"] == "suppressed"
                and isinstance(until, str)
                and _parse_iso_to_ms(until) > int(time.time() * 1000)
            ):
                self._explicit_suppressed_cache.setdefault(record["placement_id"], until)

    def reset(self) -> None:
        """Clear all impression history for this user.

        Source: impression-history.ts:189-193
        """
        self._store.clear(self._user_id)
        self._explicit_suppressed_cache.clear()
        self._suppressed_cache = {}

    def set_user_id(self, user_id: str) -> None:
        """Switch user identity — clears caches and points at a new user.

        Source: impression-history.ts:198-202
        """
        self._user_id = user_id
        self._explicit_suppressed_cache.clear()
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
