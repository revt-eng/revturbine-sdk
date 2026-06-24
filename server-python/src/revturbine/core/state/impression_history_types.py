"""Impression history types — Python port of @revt-eng/core/state/impression-history-types.ts.

Tracks placement impressions and terminal interactions (dismiss, click-through,
suppress) so the decision engine can permanently exclude placements the user
has already acted on.

Source: revturbine-scaffold/src/core/state/impression-history-types.ts
"""

from __future__ import annotations

from typing import Any, Literal, Protocol, TypedDict, runtime_checkable

__all__ = [
    "DEFAULT_SUPPRESSION_MS",
    "TERMINAL_OUTCOMES",
    "ImpressionHistoryStore",
    "ImpressionOutcome",
    "ImpressionQuery",
    "ImpressionRecord",
]


# ── Outcome vocabulary ──────────────────────────────────────────────────────


ImpressionOutcome = Literal["impressed", "dismissed", "clicked_thru", "suppressed"]
"""Source: impression-history-types.ts:21-25"""


TERMINAL_OUTCOMES: frozenset[ImpressionOutcome] = frozenset({"dismissed", "clicked_thru"})
"""Outcomes that **permanently** prevent re-presentation. Suppression is
intentionally excluded — it has a configurable time window.

Source: impression-history-types.ts:31-34
"""


DEFAULT_SUPPRESSION_MS: int = 24 * 60 * 60 * 1000
"""Default suppression duration: 24 hours.

Source: impression-history-types.ts:37
"""


# ── Records ─────────────────────────────────────────────────────────────────


class _ImpressionRecordRequired(TypedDict):
    placement_id: str
    outcome: ImpressionOutcome
    occurred_at: str


class ImpressionRecord(_ImpressionRecordRequired, total=False):
    """A single impression / interaction history record.

    Source: impression-history-types.ts:46-59
    """

    payload_id: str
    surface_template_id: str
    metadata: dict[str, Any]


# ── Query ───────────────────────────────────────────────────────────────────


class ImpressionQuery(TypedDict, total=False):
    """Optional filter for ``ImpressionHistory.query_history``.

    Source: impression-history-types.ts:65-72
    """

    placement_ids: list[str]
    outcomes: list[ImpressionOutcome]
    since: str


# ── Store protocol ──────────────────────────────────────────────────────────


@runtime_checkable
class ImpressionHistoryStore(Protocol):
    """Pluggable persistence backend for impression history.

    The TS protocol's ``void | Promise<void>`` is collapsed to plain sync
    return types here per Q-5 of plan 33 — local-mode storage is CPU-bound
    and stays sync; HTTP-mode-coupled storage would need a parallel
    async variant in a TASK-7 follow-up.

    Source: impression-history-types.ts:87-113
    """

    def append(self, user_id: str, record: ImpressionRecord) -> None: ...
    def query(
        self,
        user_id: str,
        query: ImpressionQuery | None = None,
    ) -> list[ImpressionRecord]: ...
    def get_retired_placement_ids(self, user_id: str) -> set[str]: ...
    def get_suppressed_placements(self, user_id: str) -> dict[str, str]: ...
    def clear(self, user_id: str) -> None: ...
