"""Tests for ``revturbine.core.trials.trial_status`` — faithful port of
scaffold's ``trial-status.ts``. Expected values trace the TS unit tests
in revturbine-scaffold/src/trials/controllers/trial-status.test.ts.

``TestEvaluateTrialStatus`` MIRRORS that file's
``evaluateTrialStatus`` describe block 1:1 (GV-1..GV-5) so the TS core
and this Python port derive ``UserTrialStatus`` byte-identically.
"""

from __future__ import annotations

from typing import Any

from revturbine.core.trials.trial_status import (
    derive_reverse_trial_grants,
    evaluate_trial_status,
    find_latest_started_trial_instance,
)
from revturbine.sdk import RevTurbineCustomerSdk


def _instance(**overrides: Any) -> dict[str, Any]:
    """Mirror trial-status.test.ts::makeInstance."""
    base: dict[str, Any] = {
        "id": "ti_test",
        "tenant_id": "t_test",
        "created_at": "2026-05-01T00:00:00Z",
        "updated_at": "2026-05-01T00:00:00Z",
        "customer_id": "cust_test",
        "rule_id": "ftr_pro_14d",
        "rule_type": "free_trial",
        "plan_id": "slack_pro",
        "status": "active",
        "started_at": "2026-05-01T00:00:00Z",
        "expires_at": "2026-05-15T00:00:00Z",
        "converted_at": None,
        "cancelled_at": None,
        "metadata": {},
    }
    base.update(overrides)
    return base


def _free_rule(**overrides: Any) -> dict[str, Any]:
    """Mirror trial-status.test.ts::makeFreeRule."""
    base: dict[str, Any] = {
        "id": "ftr_pro_14d",
        "name": "Pro 14d",
        "handle": "pro_14d",
        "plan_id": "slack_pro",
        "duration_days": 14,
        "grace_period_days": 0,
        "require_payment_method": False,
        "auto_convert": True,
        "limit_per_customer": 1,
        "is_active": True,
        "metadata": {},
    }
    base.update(overrides)
    return base


def _reverse_rule(**overrides: Any) -> dict[str, Any]:
    """Mirror trial-status.test.ts::makeReverseRule."""
    base: dict[str, Any] = {
        "id": "rtr_free_to_pro_14d",
        "name": "Free→Pro 14d",
        "handle": "free_to_pro_14d",
        "premium_plan_id": "slack_business_plus",
        "fallback_plan_id": "slack_free",
        "duration_days": 14,
        "start_policy": "signup",
        "entitlements_during_trial": ["workflow_builder", "enterprise_search"],
        "is_active": True,
        "metadata": {},
    }
    base.update(overrides)
    return base


class TestFindLatestStartedTrialInstance:
    def test_picks_latest_started_regardless_of_expiry(self) -> None:
        result = find_latest_started_trial_instance(
            [
                _instance(
                    id="ti_old",
                    started_at="2026-04-01T00:00:00Z",
                    status="expired",
                    expires_at="2026-04-15T00:00:00Z",
                ),
                _instance(id="ti_new", started_at="2026-05-01T00:00:00Z"),
            ],
            "2026-05-08T00:00:00Z",
        )
        assert result is not None
        assert result["id"] == "ti_new"

    def test_keeps_expired_by_bounds_instance(self) -> None:
        result = find_latest_started_trial_instance(
            [_instance(id="ti_exp", status="active", expires_at="2026-05-15T00:00:00Z")],
            "2026-05-20T00:00:00Z",
        )
        assert result is not None
        assert result["id"] == "ti_exp"

    def test_skips_not_started_and_cancelled(self) -> None:
        result = find_latest_started_trial_instance(
            [
                _instance(id="ti_ns", status="not_started", started_at="2026-05-05T00:00:00Z"),
                _instance(id="ti_cancel", status="cancelled", started_at="2026-05-06T00:00:00Z"),
                _instance(id="ti_ok", status="active", started_at="2026-05-01T00:00:00Z"),
            ],
            "2026-05-08T00:00:00Z",
        )
        assert result is not None
        assert result["id"] == "ti_ok"

    def test_skips_future_dated(self) -> None:
        result = find_latest_started_trial_instance(
            [
                _instance(id="ti_future", started_at="2026-06-01T00:00:00Z"),
                _instance(id="ti_now", started_at="2026-05-01T00:00:00Z"),
            ],
            "2026-05-08T00:00:00Z",
        )
        assert result is not None
        assert result["id"] == "ti_now"

    def test_returns_none_when_no_eligible_instance(self) -> None:
        assert find_latest_started_trial_instance([], "2026-05-08T00:00:00Z") is None


class TestDeriveReverseTrialGrants:
    def test_returns_grants_for_matching_reverse_trial(self) -> None:
        result = derive_reverse_trial_grants(
            _instance(rule_type="reverse_trial", rule_id="rtr_free_to_pro_14d"),
            _reverse_rule(),
        )
        assert result is not None
        assert result["effective_plan_handle"] == "slack_business_plus"
        assert result["trial_granted_entitlement_handles"] == {
            "workflow_builder",
            "enterprise_search",
        }

    def test_returns_none_for_free_trial(self) -> None:
        assert (
            derive_reverse_trial_grants(_instance(rule_type="free_trial"), _reverse_rule()) is None
        )

    def test_returns_none_on_rule_id_mismatch(self) -> None:
        result = derive_reverse_trial_grants(
            _instance(rule_type="reverse_trial", rule_id="rtr_other"),
            _reverse_rule(),
        )
        assert result is None

    def test_returns_none_when_entitlements_empty(self) -> None:
        result = derive_reverse_trial_grants(
            _instance(rule_type="reverse_trial"),
            _reverse_rule(entitlements_during_trial=[]),
        )
        assert result is None


class TestEvaluateTrialStatus:
    """Mirrors trial-status.test.ts::evaluateTrialStatus (GV-1..GV-5)."""

    def test_gv1_free_trial_day_7(self) -> None:
        result = evaluate_trial_status(
            free_trial_rules=[_free_rule()],
            instances=[_instance()],
            now_iso="2026-05-08T00:00:00Z",
        )
        assert result["trial"] == {
            "in_trial": True,
            "trial_type": "free",
            "state": "active",
            "trial_limit_type": "time",
            "progress_percent": 50.0,
            "day_number": 7,
            "days_remaining": 7,
            "plan_handle": "slack_pro",
        }
        assert result["reverse_grants"] is None

    def test_gv2_reverse_trial_day_7(self) -> None:
        result = evaluate_trial_status(
            reverse_trial_rules=[_reverse_rule()],
            instances=[
                _instance(
                    rule_type="reverse_trial",
                    rule_id="rtr_free_to_pro_14d",
                    plan_id="slack_business_plus",
                )
            ],
            now_iso="2026-05-08T00:00:00Z",
            base_plan_handle="slack_free",
        )
        assert result["trial"] == {
            "in_trial": True,
            "trial_type": "reverse",
            "state": "active",
            "trial_limit_type": "time",
            "progress_percent": 50.0,
            "day_number": 7,
            "days_remaining": 7,
            "plan_handle": "slack_free",
        }
        assert result["reverse_grants"] is not None
        assert result["reverse_grants"]["effective_plan_handle"] == "slack_business_plus"
        assert result["reverse_grants"]["trial_granted_entitlement_handles"] == {
            "workflow_builder",
            "enterprise_search",
        }

    def test_gv3_no_instances(self) -> None:
        result = evaluate_trial_status(
            free_trial_rules=[_free_rule()],
            instances=[],
            now_iso="2026-05-08T00:00:00Z",
        )
        assert result == {"trial": None, "reverse_grants": None}

    def test_gv4_past_expiry_surfaces_expired(self) -> None:
        result = evaluate_trial_status(
            free_trial_rules=[_free_rule()],
            instances=[_instance()],
            now_iso="2026-05-20T00:00:00Z",
        )
        trial = result["trial"]
        assert trial is not None
        assert trial["in_trial"] is False
        assert trial["trial_type"] == "free"
        assert trial["state"] == "expired"
        assert trial["progress_percent"] == 100.0
        assert trial["day_number"] == 14
        assert trial["days_remaining"] == 0
        assert result["reverse_grants"] is None

    def test_gv5_rule_id_not_in_config_arrays(self) -> None:
        result = evaluate_trial_status(
            free_trial_rules=[_free_rule()],  # id ftr_pro_14d — does not match ftr_unknown
            instances=[_instance(rule_id="ftr_unknown")],
            now_iso="2026-05-08T00:00:00Z",
        )
        trial = result["trial"]
        assert trial is not None
        assert trial["in_trial"] is True
        assert trial["trial_type"] == "free"
        assert trial["state"] == "active"
        assert trial["day_number"] == 7
        assert trial["days_remaining"] == 7
        assert "plan_handle" not in trial
        assert result["reverse_grants"] is None


class TestSdkEvaluateTrialStatus:
    """The RevTurbineCustomerSdk method reads the trial-rule arrays from the
    exported config it was constructed with (the SDK-facing 'ability')."""

    def _config(self, **extra: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "version": "1.0.0",
            "plans": [{"id": "slack_pro", "unique_handle": "slack_pro", "name": "Pro"}],
            "entitlements": [],
            "entitlement_rules": [],
            "segments": [],
            "content_ui_paths": [],
        }
        base.update(extra)
        return base

    def test_reads_free_trial_rules_from_config(self) -> None:
        sdk = RevTurbineCustomerSdk(
            user_context={"tenant_id": "t", "user_id": "u"},
            exported_config=self._config(free_trial_rules=[_free_rule()]),
        )
        result = sdk.evaluate_trial_status(instances=[_instance()], now_iso="2026-05-08T00:00:00Z")
        assert result["trial"] is not None
        assert result["trial"]["progress_percent"] == 50.0
        assert result["trial"]["plan_handle"] == "slack_pro"
        assert result["reverse_grants"] is None

    def test_reverse_grants_from_config(self) -> None:
        sdk = RevTurbineCustomerSdk(
            user_context={"tenant_id": "t", "user_id": "u"},
            exported_config=self._config(reverse_trial_rules=[_reverse_rule()]),
        )
        result = sdk.evaluate_trial_status(
            instances=[
                _instance(
                    rule_type="reverse_trial",
                    rule_id="rtr_free_to_pro_14d",
                    plan_id="slack_business_plus",
                )
            ],
            now_iso="2026-05-08T00:00:00Z",
            base_plan_handle="slack_free",
        )
        assert result["trial"] is not None
        assert result["trial"]["trial_type"] == "reverse"
        assert result["reverse_grants"] is not None
        assert result["reverse_grants"]["effective_plan_handle"] == "slack_business_plus"

    def test_no_config_rules_returns_none(self) -> None:
        sdk = RevTurbineCustomerSdk(
            user_context={"tenant_id": "t", "user_id": "u"},
            exported_config=self._config(),
        )
        result = sdk.evaluate_trial_status(instances=[], now_iso="2026-05-08T00:00:00Z")
        assert result == {"trial": None, "reverse_grants": None}
