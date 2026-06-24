"""InteractionTracker — Python port of @revt-eng/core/state/interaction-tracker.ts.

Manages dismissal and interaction suppression state, persisting through any
``RevTurbineStorage`` backend. Per Q-5 of plan 33, the storage protocol is
sync, so this class is sync; HTTP-mode-coupled storage backends would
need a parallel async variant, which is a TASK-7 concern when the SDK
class lands.

Source: revturbine-scaffold/src/core/state/interaction-tracker.ts
"""

from __future__ import annotations

import contextlib
import json
import time
from datetime import datetime, timezone
from typing import Any

from revturbine.core.state.storage import RevTurbineStorage
from revturbine.core.state.types import (
    InteractionState,
    RevTurbineTreatmentInteractionInput,
    SuppressionResult,
)

__all__ = ["InteractionTracker", "InteractionTrackerOptions"]

_STORAGE_PREFIX = "revturbine:interaction-state"
_DEFAULT_DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000
_DEFAULT_REMIND_LATER_MS = 60 * 60 * 1000
_CTA_SUPPRESSION_MS = 5 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


def _now_iso() -> str:
    """Match JS's ``new Date(ms).toISOString()`` output (millisecond precision,
    trailing ``Z``)."""
    return datetime.now(tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class InteractionTrackerOptions(dict[str, Any]):
    """Constructor argument bundle. Kept as a dict for parity with TS object
    literals; field access is via the keyword params on ``InteractionTracker``.
    """


class InteractionTracker:
    """Tracks dismiss / remind-me-later / cta interactions, persisting
    suppression windows in a ``RevTurbineStorage``.

    Source: interaction-tracker.ts:29-150
    """

    def __init__(
        self,
        *,
        storage: RevTurbineStorage,
        tenant_id: str,
        user_id: str,
        default_dismiss_cooldown_ms: int = _DEFAULT_DISMISS_COOLDOWN_MS,
        default_remind_later_ms: int = _DEFAULT_REMIND_LATER_MS,
    ) -> None:
        self._storage = storage
        self._tenant_id = tenant_id
        self._user_id = user_id
        self._default_dismiss_cooldown_ms = default_dismiss_cooldown_ms
        self._default_remind_later_ms = default_remind_later_ms
        self._state: dict[str, InteractionState] = {}
        self.hydrate()

    # ── Public API ──────────────────────────────────────────────────────────

    def track(self, input_data: RevTurbineTreatmentInteractionInput) -> None:
        """Record an interaction and update suppression state.

        Source: interaction-tracker.ts:49-85
        """
        treatment_id = input_data.get("treatment_id")
        key = self._state_key(input_data["placement_id"], input_data["user_id"], treatment_id)
        now = _now_ms()
        metadata = input_data.get("metadata") or {}
        existing: InteractionState = self._state.get(key, InteractionState(updated_at=_now_iso()))

        next_state: InteractionState = InteractionState(
            updated_at=input_data.get("interaction_at") or _now_iso(),
        )
        # Preserve previous suppressed_until / last_interaction_type unless
        # the branches below overwrite them. Mirrors the TS spread-then-set
        # pattern.
        if "suppressed_until" in existing:
            next_state["suppressed_until"] = existing["suppressed_until"]
        if "last_interaction_type" in existing:
            next_state["last_interaction_type"] = existing["last_interaction_type"]

        next_state["last_interaction_type"] = input_data["interaction_type"]

        if input_data["interaction_type"] == "dismiss":
            cooldown_ms = self._coerce_positive_finite(metadata.get("cooldown_ms"))
            next_state["suppressed_until"] = now + int(
                cooldown_ms if cooldown_ms is not None else self._default_dismiss_cooldown_ms,
            )
        elif input_data["interaction_type"] == "remind_me_later":
            remind_after = self._coerce_positive_finite(metadata.get("remind_after_seconds"))
            next_state["suppressed_until"] = now + int(
                remind_after * 1000 if remind_after is not None else self._default_remind_later_ms,
            )
        elif input_data["interaction_type"] in ("cta_clicked", "cta_completed"):
            next_state["suppressed_until"] = now + _CTA_SUPPRESSION_MS

        self._state[key] = next_state
        self.persist()

    def check_suppression(
        self,
        placement_id: str,
        user_id: str,
        treatment_id: str | None = None,
    ) -> SuppressionResult:
        """Return whether the placement is currently suppressed by a recent
        interaction. Mirrors TS's `now > suppressedUntil` boundary semantics
        (boundary timestamps are *not* suppressed).

        Source: interaction-tracker.ts:88-104
        """
        key = self._state_key(placement_id, user_id, treatment_id)
        entry = self._state.get(key)
        if entry is None or "suppressed_until" not in entry:
            return SuppressionResult(suppressed=False)
        if entry["suppressed_until"] <= _now_ms():
            return SuppressionResult(suppressed=False)
        reason = (
            "suppressed_until_remind_window"
            if entry.get("last_interaction_type") == "remind_me_later"
            else "suppressed_by_dismiss_cooldown"
        )
        return SuppressionResult(suppressed=True, reason=reason)

    def clear_suppression(
        self,
        placement_id: str,
        user_id: str,
        treatment_id: str | None = None,
    ) -> None:
        """Drop the per-key suppression state.

        Source: interaction-tracker.ts:107-111
        """
        key = self._state_key(placement_id, user_id, treatment_id)
        self._state.pop(key, None)
        self.persist()

    # ── Serialization ──────────────────────────────────────────────────────

    def hydrate(self) -> None:
        """Load state from storage. Called automatically on construction.

        Malformed JSON is dropped and the storage entry is removed; matches
        the TS try/catch + ``removeItem`` recovery path.

        Source: interaction-tracker.ts:116-129
        """
        raw = self._storage.get_item(self._storage_key())
        if not raw:
            return
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            self._storage.remove_item(self._storage_key())
            return
        if not isinstance(parsed, dict):
            return
        for key, value in parsed.items():
            if isinstance(value, dict):
                self._state[key] = value  # type: ignore[assignment]

    def persist(self) -> None:
        """Write state to storage. Storage errors are swallowed (best-effort
        persistence; matches the TS try/catch).

        Source: interaction-tracker.ts:132-139
        """
        with contextlib.suppress(Exception):
            self._storage.set_item(self._storage_key(), json.dumps(self._state))

    # ── Internal ───────────────────────────────────────────────────────────

    def _storage_key(self) -> str:
        return f"{_STORAGE_PREFIX}:{self._tenant_id}:{self._user_id}"

    def _state_key(self, placement_id: str, user_id: str, treatment_id: str | None) -> str:
        return ":".join([self._tenant_id, user_id, placement_id, treatment_id or "default"])

    @staticmethod
    def _coerce_positive_finite(value: Any) -> float | None:
        """Coerce the metadata-bag override to a positive finite number; else
        return ``None`` so the caller falls back to the default. Mirrors TS's
        ``Number(metadata.x); Number.isFinite(...) && x > 0`` pattern."""
        if value is None or isinstance(value, bool):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        if number != number or number in (float("inf"), float("-inf")):
            return None
        return number if number > 0 else None
