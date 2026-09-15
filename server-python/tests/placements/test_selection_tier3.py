"""Plan 234 TASK-15 — the plan-53 two-stage tier-3 urgency, ported.

The comparator in ``resolve_local_placement_from_candidates`` carried the
pre-plan-53 shape: no ``tier3_class`` staging, proximity applied over a
``2 <= bucket <= 3`` window that assumed the drifted category map (trial=3).
With the map aligned (trial folds into bucket 2), these tests pin the staged
comparator against the TS canonical's cases. The cross-language parity
fixture for this surface lands with TASK-8's Rust port of the selection
layer — until then this file and the TS suite are the mirrored locks.

Mutation proof (recorded in the PR): skipping the tier3_class stage fails
the class-ordering tests while the proximity tests survive — the stage is
load-bearing, not decorative.
"""

from __future__ import annotations

from typing import Any, cast

from revturbine.core.helpers import PlacementOutput, tier3_class
from revturbine.core.placements.placement_decision import (
    resolve_local_placement_from_candidates,
)


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


class TestStagedSelection:
    def test_stage1_transition_beats_at_limit(self) -> None:
        # A trial transition (class 1) outranks a usage candidate AT its
        # limit (class 2) — the exact competition the drifted map ordered
        # by bucket alone (usage strictly first) instead of by urgency.
        at_limit = _candidate("z_at_limit", usage_percent=100)
        transition = _candidate("a_transition", "trial", trigger_kind="trial_converted")
        winner = resolve_local_placement_from_candidates([at_limit, transition])
        assert winner is not None and winner["output_id"] == "a_transition"

    def test_stage1_at_limit_beats_approaching_even_at_lower_proximity(self) -> None:
        # Class and proximity DISAGREE here: the trial_progress candidate is
        # class 3 by trigger kind despite its higher percent (150), the
        # at-limit usage candidate class 2 at 100. Stage 1 must decide, so a
        # proximity-only comparator (the pre-port shape) picks the wrong one.
        progress_far_over = _candidate(
            "a_progress", "trial", trigger_kind="trial_progress", usage_percent=150
        )
        at_limit = _candidate("z_at_limit", usage_percent=100)
        winner = resolve_local_placement_from_candidates([progress_far_over, at_limit])
        assert winner is not None and winner["output_id"] == "z_at_limit"

    def test_stage2_proximity_breaks_class_ties(self) -> None:
        nearer = _candidate("z_nearer", usage_percent=92)
        farther = _candidate("a_farther", usage_percent=61)
        winner = resolve_local_placement_from_candidates([farther, nearer])
        assert winner is not None and winner["output_id"] == "z_nearer"

    def test_trial_and_usage_compete_in_one_tier(self) -> None:
        # Cross-category competition inside bucket 2: an approaching trial
        # (class 3) loses to an at-limit usage candidate (class 2). Under
        # the drifted map trial sat in its own bucket 3 and ALWAYS lost to
        # any usage candidate, however far from its limit.
        trial_progress = _candidate(
            "a_trial", "trial", trigger_kind="trial_progress", usage_percent=99
        )
        usage_far = _candidate("z_usage", usage_percent=61)
        winner = resolve_local_placement_from_candidates([trial_progress, usage_far])
        # Both are class 3 (trial_progress is class 3 by trigger kind; the
        # far usage candidate by percent) — proximity decides: 99 > 61.
        assert winner is not None and winner["output_id"] == "a_trial"

    def test_bucket_delta_still_dominates(self) -> None:
        gated = _candidate("z_gated", "gated")
        transition = _candidate("a_transition", "trial", trigger_kind="trial_converted")
        winner = resolve_local_placement_from_candidates([transition, gated])
        assert winner is not None and winner["output_id"] == "z_gated"
