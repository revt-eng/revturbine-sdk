"""Tests for ``qualifier_gating`` — parity with scaffold's
qualifier-gating.test.ts (plan 138 §3.6/§3.7)."""

from __future__ import annotations

from typing import Any

from revturbine.core.placements.qualifier_gating import (
    QualifierTriggerShape,
    matches_qualifier_trigger,
)


def _q(qualifier: str) -> QualifierTriggerShape:
    return {"kind": "qualifier", "qualifier": qualifier}


def _plan(**overrides: Any) -> dict[str, Any]:
    base = {"current_plan_handle": "pro"}
    base.update(overrides)
    return base


class TestNoneAlwaysOn:
    def test_always_matches_in_category(self) -> None:
        assert matches_qualifier_trigger(_q("none_always_on"), "other_conversion", None) is True
        assert matches_qualifier_trigger(_q("none_always_on"), "other_conversion", _plan()) is True


class TestPaymentFailed:
    def test_fires_when_signal_set(self) -> None:
        assert (
            matches_qualifier_trigger(_q("payment_failed"), "retention", _plan(payment_failed=True))
            is True
        )

    def test_good_standing_does_not_fire(self) -> None:
        assert matches_qualifier_trigger(_q("payment_failed"), "retention", _plan()) is False

    def test_explicit_false_does_not_fire(self) -> None:
        assert (
            matches_qualifier_trigger(
                _q("payment_failed"), "retention", _plan(payment_failed=False)
            )
            is False
        )

    def test_no_plan_state_fails_closed(self) -> None:
        assert matches_qualifier_trigger(_q("payment_failed"), "retention", None) is False


class TestPaymentAtRisk:
    def test_fires_when_set(self) -> None:
        assert (
            matches_qualifier_trigger(
                _q("payment_at_risk"), "retention", _plan(payment_at_risk=True)
            )
            is True
        )

    def test_unset_does_not_fire(self) -> None:
        assert matches_qualifier_trigger(_q("payment_at_risk"), "retention", _plan()) is False


class TestPassThroughQualifiers:
    def test_overage_vs_upgrade_passes_through(self) -> None:
        assert matches_qualifier_trigger(_q("overage_vs_upgrade"), "other_conversion", None) is True

    def test_time_bound_passes_through(self) -> None:
        assert matches_qualifier_trigger(_q("time_bound"), "other_conversion", None) is True


class TestCategoryScoping:
    def test_payment_failed_on_conversion_never_fires(self) -> None:
        assert (
            matches_qualifier_trigger(
                _q("payment_failed"), "other_conversion", _plan(payment_failed=True)
            )
            is False
        )

    def test_conversion_qualifier_on_retention_rejected(self) -> None:
        assert matches_qualifier_trigger(_q("time_bound"), "retention", _plan()) is False

    def test_qualifier_on_category_with_none(self) -> None:
        assert matches_qualifier_trigger(_q("none_always_on"), "fixed", _plan()) is False

    def test_value_outside_enum(self) -> None:
        assert matches_qualifier_trigger(_q("always_on"), "other_conversion", _plan()) is False


def test_none_trigger_passes_through() -> None:
    assert matches_qualifier_trigger(None, "retention", None) is True
