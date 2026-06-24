"""Tests for ``revturbine.core.rules.plan_eligibility``.

Expected values traced from
revturbine-scaffold/src/core/rules/kinds/plan-eligibility.ts
(``evaluatePlanEligibility``, lines 60-86).
"""

from __future__ import annotations

from revturbine.core.rules import (
    PlanEligibilityContext,
    PlanEligibilityRule,
    evaluate_plan_eligibility,
)


class TestEvaluatePlanEligibility:
    def test_empty_config_is_eligible(self) -> None:
        assert evaluate_plan_eligibility({}, {}) == {"eligible": True}

    def test_plan_in_target_list_is_eligible(self) -> None:
        cfg: PlanEligibilityRule = {"target_plan_ids": ["plan_pro", "plan_team"]}
        ctx: PlanEligibilityContext = {"current_plan_id": "plan_pro"}
        assert evaluate_plan_eligibility(cfg, ctx) == {"eligible": True}

    def test_plan_not_in_target_list_is_plan_mismatch(self) -> None:
        cfg: PlanEligibilityRule = {"target_plan_ids": ["plan_pro"]}
        ctx: PlanEligibilityContext = {"current_plan_id": "plan_free"}
        assert evaluate_plan_eligibility(cfg, ctx) == {
            "eligible": False,
            "reason": "plan_mismatch",
        }

    def test_empty_target_plan_ids_skips_plan_check(self) -> None:
        # length == 0 → "applies to all plans"
        cfg: PlanEligibilityRule = {"target_plan_ids": []}
        ctx: PlanEligibilityContext = {"current_plan_id": "anything"}
        assert evaluate_plan_eligibility(cfg, ctx) == {"eligible": True}

    def test_missing_current_plan_id_skips_plan_check(self) -> None:
        # `ctx.currentPlanId` falsy → guard short-circuits.
        cfg: PlanEligibilityRule = {"target_plan_ids": ["plan_pro"]}
        assert evaluate_plan_eligibility(cfg, {}) == {"eligible": True}

    def test_empty_string_current_plan_id_is_falsy_like_js(self) -> None:
        cfg: PlanEligibilityRule = {"target_plan_ids": ["plan_pro"]}
        ctx: PlanEligibilityContext = {"current_plan_id": ""}
        assert evaluate_plan_eligibility(cfg, ctx) == {"eligible": True}

    def test_billing_period_mismatch(self) -> None:
        cfg: PlanEligibilityRule = {"target_billing_periods": ["annual"]}
        ctx: PlanEligibilityContext = {"billing_period": "monthly"}
        assert evaluate_plan_eligibility(cfg, ctx) == {
            "eligible": False,
            "reason": "billing_period_mismatch",
        }

    def test_billing_period_in_list_is_eligible(self) -> None:
        cfg: PlanEligibilityRule = {"target_billing_periods": ["monthly", "annual"]}
        ctx: PlanEligibilityContext = {"billing_period": "annual"}
        assert evaluate_plan_eligibility(cfg, ctx) == {"eligible": True}

    def test_missing_billing_period_skips_check(self) -> None:
        cfg: PlanEligibilityRule = {"target_billing_periods": ["annual"]}
        assert evaluate_plan_eligibility(cfg, {}) == {"eligible": True}

    def test_plan_check_precedes_billing_check(self) -> None:
        # Both would fail; plan_mismatch wins by ordering.
        cfg: PlanEligibilityRule = {
            "target_plan_ids": ["plan_pro"],
            "target_billing_periods": ["annual"],
        }
        ctx: PlanEligibilityContext = {
            "current_plan_id": "plan_free",
            "billing_period": "monthly",
        }
        assert evaluate_plan_eligibility(cfg, ctx) == {
            "eligible": False,
            "reason": "plan_mismatch",
        }

    def test_upsell_enterprise_suppressed(self) -> None:
        cfg: PlanEligibilityRule = {"category": "upsell"}
        ctx: PlanEligibilityContext = {"plan_handle": "enterprise"}
        assert evaluate_plan_eligibility(cfg, ctx) == {
            "eligible": False,
            "reason": "enterprise_upsell_suppressed",
        }

    def test_trial_conversion_enterprise_suppressed(self) -> None:
        cfg: PlanEligibilityRule = {"category": "trial_conversion"}
        ctx: PlanEligibilityContext = {"plan_handle": "enterprise"}
        assert evaluate_plan_eligibility(cfg, ctx) == {
            "eligible": False,
            "reason": "enterprise_upsell_suppressed",
        }

    def test_upsell_non_enterprise_is_eligible(self) -> None:
        cfg: PlanEligibilityRule = {"category": "upsell"}
        ctx: PlanEligibilityContext = {"plan_handle": "pro"}
        assert evaluate_plan_eligibility(cfg, ctx) == {"eligible": True}

    def test_non_upsell_enterprise_is_eligible(self) -> None:
        cfg: PlanEligibilityRule = {"category": "gated"}
        ctx: PlanEligibilityContext = {"plan_handle": "enterprise"}
        assert evaluate_plan_eligibility(cfg, ctx) == {"eligible": True}

    def test_billing_check_precedes_enterprise_check(self) -> None:
        cfg: PlanEligibilityRule = {
            "target_billing_periods": ["annual"],
            "category": "upsell",
        }
        ctx: PlanEligibilityContext = {
            "billing_period": "monthly",
            "plan_handle": "enterprise",
        }
        assert evaluate_plan_eligibility(cfg, ctx) == {
            "eligible": False,
            "reason": "billing_period_mismatch",
        }
