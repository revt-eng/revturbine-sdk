"""BUG-554: purchased quantities cross the public SDK/provider boundary."""

import json
from pathlib import Path
from typing import Any, cast

import pytest

from revturbine import RevTurbineCustomerSdk
from revturbine.core.entitlements.entitlement_check import (
    derive_local_entitlement_from_configured_rules,
)
from revturbine.core.entitlements.purchased_allowance import validate_purchased_addons
from revturbine.core.entitlements.rules import (
    RuleEvaluationContext,
    find_matching_entitlement_rule,
)
from revturbine.core.providers.types import EntitlementRuleSnapshot, RuleProviderState


def test_shared_corpus_has_independent_arithmetic_oracle() -> None:
    fixture = json.loads(
        (
            Path(__file__).parents[2]
            / "tests/parity/fixtures/entitlement_purchased_allowances.json"
        ).read_text()
    )
    sdk = RevTurbineCustomerSdk(
        playbook=fixture["playbook"],
        user_context={
            "tenant_id": "tenant_parity",
            "user_id": "user_purchased",
            "plan_handle": "pro",
            "billing_period": "monthly",
            "addons": fixture["userContext"]["addons"],
        },
    )
    for kind in ("seat", "usage_limit", "credits"):
        result = sdk.check_entitlement(kind)
        assert result["limit"] == 180
        assert result["remaining"] == 180
        assert result["rule_handle"] == f"{kind}_base"
        assert result["contributing_rule_handles"] == [
            f"{kind}_base",
            f"{kind}_variation",
            f"{kind}_extra",
        ]


@pytest.mark.parametrize(
    "kind,field",
    [("seat", "included_count"), ("usage_limit", "limit_value"), ("credits", "allowance_value")],
)
def test_maximum_baseline_plus_purchased_maximum(kind: str, field: str) -> None:
    common = {
        "entitlement_id": "capacity",
        "period_scope": "per_month",
        "reset_period": "month",
        "enforcement": "hard_block",
    }
    playbook: dict[str, Any] = {
        "version": "1.0.0",
        "segments": [],
        "content_ui_paths": [],
        "plans": [{"unique_handle": "pro"}],
        "addons": [{"unique_handle": "boost"}],
        "entitlements": [{"unique_handle": "capacity", "type": kind}],
        "entitlement_rules": [
            {**common, "id": "base_small", "targets": [{"kind": "plan", "id": "pro"}], field: 50},
            {**common, "id": "base", "targets": [{"kind": "plan", "id": "pro"}], field: 100},
            {
                **common,
                "id": "boost_small",
                "targets": [{"kind": "addon", "id": "boost"}],
                field: 10,
            },
            {**common, "id": "boost", "targets": [{"kind": "addon", "id": "boost"}], field: 25},
        ],
    }
    result = derive_local_entitlement_from_configured_rules(
        handle="capacity",
        current_plan_handle="pro",
        segment_ids=set(),
        usage_balances={},
        playbook=playbook,
        addons=[{"addon_handle": "boost", "quantity": 2}],
    )
    sdk = RevTurbineCustomerSdk(
        playbook=playbook,
        user_context={
            "tenant_id": "t",
            "user_id": "u",
            "plan_handle": "pro",
            "addons": [{"addon_handle": "boost", "quantity": 2}],
        },
    )
    assert sdk.check_entitlement("capacity") == result
    assert result == {
        "status": "allowed",
        "allowed": True,
        "limit": 150,
        "used": 0,
        "remaining": 150,
        "rule_handle": "base",
        "contributing_rule_handles": ["base", "boost"],
    }
    playbook["entitlement_rules"][-1]["period_scope"] = "lifetime"
    playbook["entitlement_rules"][-1]["reset_period"] = "lifetime"
    if kind != "seat":
        # TS parsePlaybookOrThrow admits the Playbook; the rejection is raised
        # when the incompatible grants are actually aggregated (parity scenario
        # entitlement_purchased_period_mismatch).
        mismatched = RevTurbineCustomerSdk(
            playbook=playbook,
            user_context={
                "tenant_id": "t",
                "user_id": "u",
                "plan_handle": "pro",
                "addons": [{"addon_handle": "boost", "quantity": 2}],
            },
        )
        with pytest.raises(ValueError, match="matching periods and scopes"):
            mismatched.check_entitlement("capacity")
        with pytest.raises(ValueError, match="matching periods and scopes"):
            derive_local_entitlement_from_configured_rules(
                handle="capacity",
                current_plan_handle="pro",
                segment_ids=set(),
                usage_balances={},
                playbook=playbook,
                addons=[{"addon_handle": "boost", "quantity": 2}],
            )


def test_unknown_or_mismatched_variation_contributes_nothing() -> None:
    """Snapshot matcher: scaffold rules.ts skips these holdings, never raises."""
    rules: list[EntitlementRuleSnapshot] = [
        cast(
            "EntitlementRuleSnapshot",
            {
                "rule_id": rule_id,
                "entitlement_id": "seats",
                "plan_ids": [],
                "kind": "seat",
                "targets": targets,
                "fields": {"included_count": count},
            },
        )
        for rule_id, targets, count in (
            ("base", [{"kind": "plan", "id": "pro"}], 100),
            ("variation", [{"kind": "addon_variation", "id": "boost_monthly"}], 25),
        )
    ]
    state: RuleProviderState = {
        "config_version": "1",
        "entitlement_rules": {"seats": rules},
        "addon_variations": {
            "boost_monthly": {"addon_handle": "boost", "billing_period": "monthly"},
        },
    }
    unknown: list[dict[str, Any]] = [
        {"addon_handle": "boost", "addon_variation_handle": "ghost_monthly", "quantity": 2},
        {"addon_handle": "extra", "addon_variation_handle": "boost_monthly", "quantity": 3},
        {"addon_handle": "ghost", "quantity": 4},
    ]
    context: RuleEvaluationContext = {
        "segment_ids": [],
        "current_plan_handle": "pro",
        "billing_period": "monthly",
        "addons": unknown,
    }
    selected = find_matching_entitlement_rule(state, "seats", context)
    assert selected is not None
    assert selected["rule_id"] == "base"
    assert "effective_allowance" not in selected
    valid = {"addon_handle": "boost", "addon_variation_handle": "boost_monthly", "quantity": 2}
    context["addons"] = [unknown[2], valid]
    selected = find_matching_entitlement_rule(state, "seats", context)
    assert selected is not None
    assert selected["effective_allowance"] == 150
    assert selected["contributing_rule_handles"] == ["base", "variation"]


def test_duplicate_holdings_are_rejected() -> None:
    with pytest.raises(ValueError, match="Duplicate"):
        validate_purchased_addons([{"addon_handle": "boost", "quantity": 1}] * 2)


def test_credit_topups_do_not_hide_recurring_allowances() -> None:
    playbook: dict[str, Any] = {
        "version": "1.0.0",
        "segments": [],
        "content_ui_paths": [],
        "plans": [{"unique_handle": "pro"}],
        "addons": [{"unique_handle": "pack"}],
        "entitlements": [{"unique_handle": "credits", "type": "credits"}],
        "entitlement_rules": [
            {
                "id": "base",
                "entitlement_id": "credits",
                "targets": [{"kind": "plan", "id": "pro"}],
                "allowance_value": 100,
                "reset_period": "month",
            },
            {
                "id": "topup",
                "entitlement_id": "credits",
                "targets": [{"kind": "addon", "id": "pack"}],
                "allowance_value": 1000,
            },
            {
                "id": "recurring",
                "entitlement_id": "credits",
                "targets": [{"kind": "addon", "id": "pack"}],
                "allowance_value": 25,
                "reset_period": "month",
            },
        ],
    }
    sdk = RevTurbineCustomerSdk(
        playbook=playbook,
        user_context={
            "tenant_id": "t",
            "user_id": "u",
            "plan_handle": "pro",
            "addons": [{"addon_handle": "pack", "quantity": 2}],
        },
    )
    assert sdk.check_entitlement("credits")["limit"] == 150
    assert sdk.check_entitlement("credits")["contributing_rule_handles"] == ["base", "recurring"]
    assert sdk.check_entitlement("credits")["limit"] == 150
