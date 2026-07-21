"""Tests for ``entitlement_gate_gating`` — parity with scaffold's
entitlement-gate-gating.test.ts (plan 138 TASK-4 §3.3)."""

from __future__ import annotations

from typing import Any

from revturbine.core.placements.entitlement_gate_gating import (
    EntitlementGateTriggerShape,
    matches_entitlement_gate_trigger,
)

# Ordered ladder: free < pro < enterprise.
_LADDERS: dict[str, list[str]] = {"seats": ["free", "pro", "enterprise"]}


def _gate(tier_threshold: str | None) -> EntitlementGateTriggerShape:
    return {
        "kind": "entitlement_gate",
        "entitlement_handle": "seats",
        "tier_threshold": tier_threshold,
    }


def _ents(tiers: dict[str, str] | None = None) -> dict[str, Any]:
    state: dict[str, Any] = {"entries": {}}
    if tiers is not None:
        state["tiers"] = tiers
    return state


class TestFiresBelowThreshold:
    def test_lower_tier_fires(self) -> None:
        assert (
            matches_entitlement_gate_trigger(_gate("pro"), _LADDERS, _ents({"seats": "free"}))
            is True
        )

    def test_no_tier_at_all_fires(self) -> None:
        assert matches_entitlement_gate_trigger(_gate("pro"), _LADDERS, _ents()) is True
        assert (
            matches_entitlement_gate_trigger(_gate("pro"), _LADDERS, _ents({"other": "pro"}))
            is True
        )

    def test_unrecognized_current_tier_fires(self) -> None:
        assert (
            matches_entitlement_gate_trigger(_gate("pro"), _LADDERS, _ents({"seats": "legacy"}))
            is True
        )


class TestDoesNotFireAtOrAbove:
    def test_at_threshold_does_not_fire(self) -> None:
        assert (
            matches_entitlement_gate_trigger(_gate("pro"), _LADDERS, _ents({"seats": "pro"}))
            is False
        )

    def test_above_threshold_does_not_fire(self) -> None:
        assert (
            matches_entitlement_gate_trigger(_gate("pro"), _LADDERS, _ents({"seats": "enterprise"}))
            is False
        )


class TestFailClosed:
    def test_no_ladder_fails_closed(self) -> None:
        assert matches_entitlement_gate_trigger(_gate("pro"), {}, _ents({"seats": "free"})) is False

    def test_empty_ladder_fails_closed(self) -> None:
        assert (
            matches_entitlement_gate_trigger(_gate("pro"), {"seats": []}, _ents({"seats": "free"}))
            is False
        )

    def test_threshold_off_ladder_fails_closed(self) -> None:
        assert (
            matches_entitlement_gate_trigger(_gate("platinum"), _LADDERS, _ents({"seats": "free"}))
            is False
        )


class TestPassThrough:
    def test_non_tier_gate_passes_through(self) -> None:
        assert (
            matches_entitlement_gate_trigger(_gate(None), _LADDERS, _ents({"seats": "enterprise"}))
            is True
        )

    def test_none_trigger_passes_through(self) -> None:
        assert matches_entitlement_gate_trigger(None, _LADDERS, _ents()) is True
