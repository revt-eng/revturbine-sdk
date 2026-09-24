"""Upsert/merge parity for the trial-status PlanProvider overlay.

The TS control-plane ``mergeUserContext`` and the TS web-SDK
``synthesizeProviderContext`` both follow upsert semantics: a field that
is **absent or explicitly ``None``/``undefined``** in the incoming patch
must NOT clobber the value already on the base state. Only defined values
overwrite.

The Python server SDK is stateless (constructed once per
``(user_context, playbook)``) so it has no ``identify`` / ``set_user``
partial-update path — but ``_TrialOverlayPlanProvider`` is its one
merge-like path, overlaying a customer-supplied ``trial_status`` onto the
resolved PlanProviderState. These tests lock that it overlays with the
same non-clobbering rule, so the two languages stay aligned.
"""

from __future__ import annotations

from typing import Any

from revturbine.sdk import _TrialOverlayPlanProvider


class _FakePlanProvider:
    """Minimal DomainProvider whose ``resolve()`` returns a fixed dict."""

    domain = "plan"
    cache_ttl_ms = None

    def __init__(self, state: dict[str, Any]) -> None:
        self._state = state

    def resolve(self) -> dict[str, Any]:
        return dict(self._state)


def test_overlay_does_not_clobber_base_state_with_none() -> None:
    """A ``trial_status`` that carries explicit ``None`` values (the
    partial-update shape) leaves the base PlanProviderState untouched."""
    base = _FakePlanProvider({"plan_handle": "pro", "trial_active": False})
    overlay = _TrialOverlayPlanProvider(
        base,
        {"in_trial": None, "state": None, "progress_percent": None, "days_remaining": None},
    )

    merged = overlay.resolve()

    assert merged["plan_handle"] == "pro"  # base field survives
    assert merged["trial_active"] is False  # None in_trial did not overwrite
    # None-valued trial fields are not materialized as keys at all.
    assert "trial_state" not in merged
    assert "trial_progress_percent" not in merged


def test_overlay_applies_defined_trial_fields() -> None:
    """Defined ``trial_status`` values DO overwrite / add, and unrelated
    base fields are preserved."""
    base = _FakePlanProvider({"plan_handle": "pro"})
    overlay = _TrialOverlayPlanProvider(
        base,
        {"in_trial": True, "state": "active", "progress_percent": 42},
    )

    merged = overlay.resolve()

    assert merged["trial_active"] is True
    assert merged["trial_state"] == "active"
    assert merged["trial_progress_percent"] == 42
    assert merged["plan_handle"] == "pro"  # base field preserved alongside overlay


def test_overlay_preserves_integer_numeric_representation() -> None:
    """BL-0155 — the overlay passes numbers through instead of widening them
    to ``float``, so the PlanProviderState this port builds is structurally
    identical to the TS canonical's ``planTrialFields`` and the Rust crate's
    ``overlay_trial_status_on_plan_provider`` for the same input. ``==`` cannot
    see the difference in Python (``100 == 100.0``), so assert the type.
    """
    overlay = _TrialOverlayPlanProvider(
        _FakePlanProvider({}),
        {
            "in_trial": True,
            "trial_limit_type": "time",
            "progress_percent": 100,
            "days_remaining": 0,
            "day_number": 14,
            "usage_consumed": 8,
            "usage_limit": 10,
        },
    )

    merged = overlay.resolve()

    for key, expected in (
        ("trial_progress_percent", 100),
        ("trial_days_remaining", 0),
        ("trial_usage_consumed", 8),
        ("trial_usage_limit", 10),
        ("trial_days_total", 14),  # derived: int + int stays int
    ):
        assert merged[key] == expected
        assert type(merged[key]) is int, f"{key} widened to {type(merged[key]).__name__}"


def test_overlay_keeps_float_numeric_representation() -> None:
    """A fractional input stays a float — representation follows the INPUT."""
    overlay = _TrialOverlayPlanProvider(
        _FakePlanProvider({}),
        {"progress_percent": 62.5, "day_number": 10.5, "days_remaining": 4},
    )

    merged = overlay.resolve()

    assert merged["trial_progress_percent"] == 62.5
    assert merged["trial_days_total"] == 14.5


def test_overlay_skips_non_numeric_days_total_halves() -> None:
    """A non-numeric half derives no total instead of raising — the same guard
    the Rust port's ``as_f64()`` check applies. ``bool`` counts as non-numeric
    even though it is an ``int`` subclass, because JSON has no such number."""
    for trial in (
        {"day_number": "10", "days_remaining": 4},
        {"day_number": True, "days_remaining": 4},
    ):
        merged = _TrialOverlayPlanProvider(_FakePlanProvider({}), trial).resolve()
        assert "trial_days_total" not in merged
