"""Tests for ``threshold_gating`` — parity with scaffold's
threshold-gating.test.ts (plan 138 §3.4 formulas)."""

from __future__ import annotations

from typing import Any

from revturbine.core.placements.threshold_gating import (
    ThresholdTriggerShape,
    compute_consumed_percent,
    matches_threshold_trigger,
)


def _usage_state(handle: str, entry: dict[str, float]) -> dict[str, Any]:
    return {"entries": {}, "usage": {handle: entry}}


def _usage(pct: float) -> ThresholdTriggerShape:
    return {"kind": "usage_threshold", "entitlement_handle": "api_calls", "threshold_percent": pct}


def _credit(pct: float) -> ThresholdTriggerShape:
    return {"kind": "credit_threshold", "entitlement_handle": "credits", "threshold_percent": pct}


def _seat(pct: float) -> ThresholdTriggerShape:
    return {"kind": "seat_threshold", "entitlement_handle": "seats", "threshold_percent": pct}


class TestUsageThreshold:
    def test_below_does_not_fire(self) -> None:
        state = _usage_state("api_calls", {"used": 500, "limit": 1000, "remaining": 500})
        assert compute_consumed_percent(_usage(80), state) == 50
        assert matches_threshold_trigger(_usage(80), state) is False

    def test_above_fires(self) -> None:
        state = _usage_state("api_calls", {"used": 850, "limit": 1000, "remaining": 150})
        assert compute_consumed_percent(_usage(80), state) == 85
        assert matches_threshold_trigger(_usage(80), state) is True

    def test_exactly_at_fires(self) -> None:
        state = _usage_state("api_calls", {"used": 800, "limit": 1000, "remaining": 200})
        assert matches_threshold_trigger(_usage(80), state) is True

    def test_not_clamped_above_100(self) -> None:
        state = _usage_state("api_calls", {"used": 1200, "limit": 1000, "remaining": 0})
        assert compute_consumed_percent(_usage(100), state) == 120
        assert matches_threshold_trigger(_usage(100), state) is True


class TestCreditThreshold:
    def test_spec_worked_example(self) -> None:
        # "A 70% threshold on 1,000 credits fires when balance drops to 300."
        state = _usage_state("credits", {"used": 0, "limit": 1000, "remaining": 300})
        assert compute_consumed_percent(_credit(70), state) == 70
        assert matches_threshold_trigger(_credit(70), state) is True

    def test_balance_above_threshold_does_not_fire(self) -> None:
        state = _usage_state("credits", {"used": 0, "limit": 1000, "remaining": 400})
        assert compute_consumed_percent(_credit(70), state) == 60
        assert matches_threshold_trigger(_credit(70), state) is False

    def test_derives_from_balance_not_used(self) -> None:
        # used=0 but only 100 of 1000 remain -> consumed must be 90%.
        state = _usage_state("credits", {"used": 0, "limit": 1000, "remaining": 100})
        assert compute_consumed_percent(_credit(90), state) == 90

    def test_falls_back_to_used_without_balance(self) -> None:
        state: dict[str, Any] = {
            "entries": {},
            "grants": {"account": {"credits": {"status": "limited", "limit": 1000, "used": 750}}},
        }
        assert compute_consumed_percent(_credit(70), state) == 75


class TestSeatThreshold:
    def test_fires_at_threshold(self) -> None:
        state = _usage_state("seats", {"used": 9, "limit": 10, "remaining": 1})
        assert compute_consumed_percent(_seat(90), state) == 90
        assert matches_threshold_trigger(_seat(90), state) is True

    def test_below_does_not_fire(self) -> None:
        state = _usage_state("seats", {"used": 4, "limit": 10, "remaining": 6})
        assert matches_threshold_trigger(_seat(90), state) is False


class TestAllocationScoping:
    def _state(self, allocation: str) -> dict[str, Any]:
        return {
            "entries": {},
            "grants": {
                "account": {"api_calls": {"status": "limited", "limit": 1000, "used": 900}},
                "user": {
                    "api_calls": {
                        "status": "limited",
                        "limit": 100,
                        "used": 10,
                        "allocation": allocation,
                    }
                },
            },
        }

    def test_account_pool_measures_account_total(self) -> None:
        state = self._state("account_pool")
        assert compute_consumed_percent(_usage(80), state) == 90
        assert matches_threshold_trigger(_usage(80), state) is True

    def test_per_user_measures_individual(self) -> None:
        state = self._state("per_user")
        assert compute_consumed_percent(_usage(80), state) == 10
        assert matches_threshold_trigger(_usage(80), state) is False

    def test_per_user_pooled_measures_account(self) -> None:
        state = self._state("per_user_pooled")
        assert compute_consumed_percent(_usage(80), state) == 90


class TestFailClosed:
    def test_no_state(self) -> None:
        assert matches_threshold_trigger(_usage(80), None) is False

    def test_handle_absent(self) -> None:
        state = _usage_state("other", {"used": 999, "limit": 1000, "remaining": 1})
        assert compute_consumed_percent(_usage(80), state) is None
        assert matches_threshold_trigger(_usage(80), state) is False

    def test_zero_limit(self) -> None:
        state = _usage_state("api_calls", {"used": 5, "limit": 0, "remaining": 0})
        assert compute_consumed_percent(_usage(80), state) is None
        assert matches_threshold_trigger(_usage(80), state) is False

    def test_none_trigger_passes_through(self) -> None:
        assert matches_threshold_trigger(None, None) is True
