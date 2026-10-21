"""Plan 234 TASK-15 — the plan-53 tier-3 urgency classes.

``tier3_class`` is the first stage of the plan-53 two-stage tier-3 urgency.
The staged comparator that consumed it,
``resolve_local_placement_from_candidates``, was removed in 0.12.0 (BL-0537):
no runtime path consulted it after ``getPlacement`` became a pure function of
(user context, Playbook) in 0.11.21 (D-39, BL-0379). The class helper stays
public alongside its TS original in scaffold core.
"""

from __future__ import annotations

from typing import Any, cast

from revturbine.core.helpers import PlacementOutput, tier3_class


def _candidate(
    output_id: str,
    category: str = "usage_limit",
    *,
    trigger_kind: str | None = None,
    usage_percent: float | None = None,
) -> PlacementOutput:
    content: dict[str, Any] = {}
    if trigger_kind is not None:
        content["__trigger_kind"] = trigger_kind
    if usage_percent is not None:
        content["usage_percent"] = usage_percent
    return cast(
        "PlacementOutput",
        {
            "output_id": output_id,
            "category": category,
            "content": content,
            "surface": {"type": "banner"},
        },
    )


class TestTier3Class:
    def test_transition_triggers_are_class_1(self) -> None:
        for kind in ("trial_started", "trial_ended", "trial_converted"):
            assert tier3_class(_candidate("o", trigger_kind=kind)) == 1

    def test_progress_style_triggers_are_class_3(self) -> None:
        for kind in ("trial_progress", "trial_ending"):
            assert tier3_class(_candidate("o", trigger_kind=kind, usage_percent=100)) == 3

    def test_at_or_over_limit_is_class_2(self) -> None:
        assert tier3_class(_candidate("o", usage_percent=100)) == 2
        assert tier3_class(_candidate("o", usage_percent=140)) == 2

    def test_approaching_is_class_3(self) -> None:
        assert tier3_class(_candidate("o", usage_percent=85)) == 3
        assert tier3_class(_candidate("o")) == 3
