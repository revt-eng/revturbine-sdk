"""Standalone trial-trigger tests (plan 234 TASK-4 / AC-4).

``trial_ending`` / ``trial_ended`` / ``trial_progress`` were covered only
through the parity fixtures (``trial_ending_days_before_end``,
``trial_ended_post_expiry``, ``trial_progress_milestone_supersession``) —
resolver-level, cross-language, but nothing pinned the Python module's own
branch behaviour. Expected values traced from trial-gating.ts (the
executable spec this module ports byte-faithfully).
"""

from __future__ import annotations

from typing import Any

from revturbine.core.placements.trial_gating import (
    TrialCandidate,
    apply_milestone_supersession,
    compute_user_elapsed_percent,
    matches_trial_trigger,
    normalize_json_trigger,
)


def _plan(**kw: Any) -> dict[str, Any]:
    return {"trial_active": True, **kw}


class TestTrialEnding:
    TRIGGER = {"kind": "trial_ending", "days_before_end": 3.0}

    def test_matches_at_or_under_the_window(self) -> None:
        assert matches_trial_trigger(self.TRIGGER, _plan(trial_days_remaining=3)) is True
        assert matches_trial_trigger(self.TRIGGER, _plan(trial_days_remaining=1)) is True

    def test_outside_the_window_does_not_match(self) -> None:
        assert matches_trial_trigger(self.TRIGGER, _plan(trial_days_remaining=4)) is False

    def test_usage_limited_trials_are_excluded(self) -> None:
        # A usage-limited trial has no meaningful days-remaining countdown.
        plan = _plan(trial_days_remaining=1, trial_limit_type="usage")
        assert matches_trial_trigger(self.TRIGGER, plan) is False

    def test_missing_days_remaining_fails_closed(self) -> None:
        assert matches_trial_trigger(self.TRIGGER, _plan()) is False
        assert matches_trial_trigger(self.TRIGGER, _plan(trial_days_remaining="2")) is False

    def test_inactive_trial_never_matches(self) -> None:
        assert (
            matches_trial_trigger(self.TRIGGER, {"trial_active": False, "trial_days_remaining": 1})
            is False
        )


class TestTrialEnded:
    TRIGGER = {"kind": "trial_ended"}

    def test_expired_state_matches(self) -> None:
        assert matches_trial_trigger(self.TRIGGER, {"trial_state": "expired"}) is True

    def test_active_or_converted_does_not(self) -> None:
        assert matches_trial_trigger(self.TRIGGER, _plan(trial_state="active")) is False
        assert matches_trial_trigger(self.TRIGGER, {"trial_state": "converted"}) is False


class TestTrialProgress:
    TRIGGER = {"kind": "trial_progress", "progress_percent": 50.0}

    def test_active_unexpired_unconverted_matches(self) -> None:
        # Threshold crossing is supersession's job, not eligibility's —
        # an active trial matches regardless of the percent.
        assert matches_trial_trigger(self.TRIGGER, _plan(trial_state="active")) is True

    def test_expired_or_converted_does_not(self) -> None:
        assert matches_trial_trigger(self.TRIGGER, _plan(trial_state="expired")) is False
        assert matches_trial_trigger(self.TRIGGER, _plan(trial_state="converted")) is False

    def test_inactive_does_not(self) -> None:
        assert matches_trial_trigger(self.TRIGGER, {"trial_active": False}) is False


class TestNonTrialPassthrough:
    def test_none_trigger_always_passes(self) -> None:
        assert matches_trial_trigger(None, {"anything": True}) is True
        assert matches_trial_trigger(None, None) is True

    def test_unknown_kind_fails_closed(self) -> None:
        assert matches_trial_trigger({"kind": "mystery"}, _plan()) is False


class TestNormalizeJsonTrigger:
    def test_type_keyed_becomes_kind_keyed(self) -> None:
        assert normalize_json_trigger({"type": "trial_ending", "days_before_end": 2}) == {
            "kind": "trial_ending",
            "days_before_end": 2.0,
        }
        assert normalize_json_trigger({"type": "trial_ended"}) == {"kind": "trial_ended"}
        assert normalize_json_trigger({"type": "trial_progress", "progress_percent": 25}) == {
            "kind": "trial_progress",
            "progress_percent": 25.0,
        }

    def test_missing_numeric_payload_is_none(self) -> None:
        # A trial_progress / trial_ending trigger without its number is not
        # a trial trigger at all — it must NOT gate the placement.
        assert normalize_json_trigger({"type": "trial_progress"}) is None
        assert normalize_json_trigger({"type": "trial_ending"}) is None

    def test_non_trial_types_pass_through_as_none(self) -> None:
        assert normalize_json_trigger({"type": "entitlement_gate"}) is None
        assert normalize_json_trigger("trial_ended") is None


class TestElapsedPercent:
    def test_universal_progress_percent_wins_and_caps_at_100(self) -> None:
        assert compute_user_elapsed_percent(_plan(trial_progress_percent=40)) == 40.0
        assert compute_user_elapsed_percent(_plan(trial_progress_percent=140)) == 100.0

    def test_time_based_fallback(self) -> None:
        plan = _plan(trial_days_total=10, trial_days_remaining=7)
        assert compute_user_elapsed_percent(plan) == 30.0

    def test_expired_or_inactive_is_none(self) -> None:
        assert (
            compute_user_elapsed_percent(_plan(trial_state="expired", trial_progress_percent=50))
            is None
        )
        assert compute_user_elapsed_percent({"trial_active": False}) is None


class TestMilestoneSupersession:
    @staticmethod
    def _candidate(rule_id: str, pct: float, order: int) -> TrialCandidate:
        return {
            "rule_id": rule_id,
            "entry_order": order,
            "trial_trigger": {"kind": "trial_progress", "progress_percent": pct},
            "output": None,
        }

    def test_highest_crossed_threshold_wins_lower_siblings_superseded(self) -> None:
        result = apply_milestone_supersession(
            [
                self._candidate("r25", 25, 0),
                self._candidate("r50", 50, 1),
                self._candidate("r75", 75, 2),
            ],
            user_elapsed_percent=60.0,
        )
        assert result is not None
        assert result["winner"]["rule_id"] == "r50"
        assert result["superseded_ids"] == ["r25"]

    def test_tie_resolves_to_earliest_entry_order(self) -> None:
        result = apply_milestone_supersession(
            [self._candidate("r_late", 50, 5), self._candidate("r_early", 50, 1)],
            user_elapsed_percent=80.0,
        )
        assert result is not None
        assert result["winner"]["rule_id"] == "r_early"
        assert result["superseded_ids"] == ["r_late"]

    def test_nothing_crossed_is_none(self) -> None:
        assert (
            apply_milestone_supersession([self._candidate("r75", 75, 0)], user_elapsed_percent=10.0)
            is None
        )

    def test_no_progress_candidates_is_none(self) -> None:
        assert (
            apply_milestone_supersession(
                [
                    {
                        "rule_id": "r1",
                        "entry_order": 0,
                        "trial_trigger": {"kind": "trial_ending", "days_before_end": 3.0},
                        "output": None,
                    }
                ],
                user_elapsed_percent=90.0,
            )
            is None
        )
