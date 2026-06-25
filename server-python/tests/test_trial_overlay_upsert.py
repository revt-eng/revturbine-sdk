"""Upsert/merge parity for the trial-status PlanProvider overlay.

The TS control-plane ``mergeUserContext`` and the TS web-SDK
``synthesizeProviderContext`` both follow upsert semantics: a field that
is **absent or explicitly ``None``/``undefined``** in the incoming patch
must NOT clobber the value already on the base state. Only defined values
overwrite.

The Python server SDK is stateless (constructed once per
``(user_context, exported_config)``) so it has no ``identify`` / ``set_user``
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
    assert merged["trial_progress_percent"] == 42.0
    assert merged["plan_handle"] == "pro"  # base field preserved alongside overlay
