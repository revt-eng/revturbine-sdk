"""Tests for ``revturbine.core.entitlements.rules`` — faithful port of
the plan-34-reconciled ``rules.ts``. Expected values traced from
revturbine-scaffold/src/entitlements/controllers/rules.ts. (Cross-
language byte parity is separately locked by revturbine-sdk-internal/tests/parity.)
"""

from __future__ import annotations

from typing import Any, cast

from revturbine.core.entitlements.rules import (
    RuleEvaluationContext,
    evaluate_entitlement_rules,
    evaluate_plan_rules,
    find_matching_entitlement_rule,
)
from revturbine.core.providers.types import (
    EntitlementRuleSnapshot,
    RuleProviderState,
)


def _rule(**kw: Any) -> EntitlementRuleSnapshot:
    """Typed snapshot stand-in — the partial fixture dict is
    structurally an ``EntitlementRuleSnapshot``; ``cast`` keeps runtime
    value identical (test-fixture idiom, not a schema workaround).
    """
    base: dict[str, Any] = {
        "rule_id": "r",
        "entitlement_id": "e",
        "plan_ids": [],
        "kind": "feature",
        "fields": {},
    }
    base.update(kw)
    return cast("EntitlementRuleSnapshot", base)


def _state(rules: list[EntitlementRuleSnapshot]) -> RuleProviderState:
    return {"config_version": "1", "entitlement_rules": {"e": rules}}


class TestEvaluateEntitlementRules:
    def test_targets_any_match_wins(self) -> None:
        rules = [_rule(targets=[{"kind": "plan", "id": "pro"}])]
        out = evaluate_entitlement_rules(rules, {"segment_ids": [], "current_plan_id": "pro"})
        assert out[0]["matched"] is True

    def test_targets_present_but_none_match(self) -> None:
        rules = [_rule(targets=[{"kind": "plan", "id": "pro"}])]
        out = evaluate_entitlement_rules(rules, {"segment_ids": [], "current_plan_id": "starter"})
        assert out[0]["matches_plan"] is False

    def test_legacy_plan_ids_explicit_only(self) -> None:
        # Empty plan_ids matches NOTHING (plan 34 REQ-9 — no implicit
        # "empty ⇒ all plans").
        empty = evaluate_entitlement_rules(
            [_rule(plan_ids=[])], {"segment_ids": [], "current_plan_id": "pro"}
        )
        assert empty[0]["matches_plan"] is False
        listed = evaluate_entitlement_rules(
            [_rule(plan_ids=["pro"])], {"segment_ids": [], "current_plan_id": "pro"}
        )
        assert listed[0]["matches_plan"] is True

    def test_segment_gating(self) -> None:
        r = _rule(plan_ids=["pro"], segment_ids=["seg_a"])
        ctx_in: RuleEvaluationContext = {
            "segment_ids": ["seg_a"],
            "current_plan_id": "pro",
        }
        ctx_out: RuleEvaluationContext = {
            "segment_ids": ["seg_b"],
            "current_plan_id": "pro",
        }
        assert evaluate_entitlement_rules([r], ctx_in)[0]["matched"] is True
        assert evaluate_entitlement_rules([r], ctx_out)[0]["matched"] is False

    def test_addon_targets(self) -> None:
        r = _rule(targets=[{"kind": "addon", "id": "a1"}])
        assert (
            evaluate_entitlement_rules([r], {"segment_ids": [], "addon_ids": ["a1"]})[0]["matched"]
            is True
        )


class TestFindMatchingMostPermissive:
    def test_most_permissive_wins_not_source_order(self) -> None:
        # Two matched usage_limit rules; the higher limit_value is more
        # permissive and must win even though it is second in order.
        state = _state(
            [
                _rule(
                    rule_id="low", plan_ids=["pro"], kind="usage_limit", fields={"limit_value": 10}
                ),
                _rule(
                    rule_id="high",
                    plan_ids=["pro"],
                    kind="usage_limit",
                    fields={"limit_value": 100},
                ),
            ]
        )
        sel = find_matching_entitlement_rule(
            state, "e", {"segment_ids": [], "current_plan_id": "pro"}
        )
        assert sel is not None and sel["rule_id"] == "high"

    def test_unlimited_beats_finite(self) -> None:
        state = _state(
            [
                _rule(
                    rule_id="fin", plan_ids=["pro"], kind="usage_limit", fields={"limit_value": 999}
                ),
                _rule(
                    rule_id="unl",
                    plan_ids=["pro"],
                    kind="usage_limit",
                    fields={"limit_value": "unlimited"},
                ),
            ]
        )
        sel = find_matching_entitlement_rule(
            state, "e", {"segment_ids": [], "current_plan_id": "pro"}
        )
        assert sel is not None and sel["rule_id"] == "unl"

    def test_tie_resolves_to_source_order(self) -> None:
        state = _state(
            [
                _rule(rule_id="first", plan_ids=["pro"], kind="feature", fields={"enabled": True}),
                _rule(rule_id="second", plan_ids=["pro"], kind="feature", fields={"enabled": True}),
            ]
        )
        sel = find_matching_entitlement_rule(
            state, "e", {"segment_ids": [], "current_plan_id": "pro"}
        )
        assert sel is not None and sel["rule_id"] == "first"

    def test_no_rules_returns_none(self) -> None:
        empty: RuleProviderState = {"config_version": "1", "entitlement_rules": {}}
        assert find_matching_entitlement_rule(empty, "missing", {"segment_ids": []}) is None


class TestEvaluatePlanRules:
    def test_active_and_segment_filtering(self) -> None:
        rules: list[dict[str, Any]] = [
            {"status": "inactive", "segment_id": None},
            {"status": "active", "segment_id": None},
            {"status": "active", "segment_id": "seg_a"},
            {"status": "active", "segment_id": "seg_z"},
        ]
        out = evaluate_plan_rules(rules, {"segment_ids": ["seg_a"]})
        assert out == [
            {"status": "active", "segment_id": None},
            {"status": "active", "segment_id": "seg_a"},
        ]
