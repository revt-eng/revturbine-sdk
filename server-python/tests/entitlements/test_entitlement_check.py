"""Tests for
``revturbine.core.entitlements.entitlement_check`` — faithful port of
the plan-32/34-reconciled ``deriveLocalEntitlementFromConfiguredRules``.
Expected values traced from
revturbine-scaffold/src/entitlements/controllers/entitlement-check.ts.
(Cross-language byte parity additionally locked by
revturbine-sdk-internal/tests/parity entitlement_rule_* fixtures.)
"""

from __future__ import annotations

from typing import Any

from revturbine.core.entitlements.entitlement_check import (
    derive_local_entitlement_from_configured_rules,
)


def _cfg(rules: list[dict[str, Any]], plans: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "version": "1.0.0",
        "plans": plans if plans is not None else [{"id": "starter", "unique_handle": "starter"}],
        "entitlement_rules": rules,
    }


def _derive(cfg: dict[str, Any], handle: str, **kw: Any) -> Any:
    return derive_local_entitlement_from_configured_rules(
        handle=handle,
        context=kw.get("context"),
        current_plan_handle=kw.get("plan", "starter"),
        segment_ids=kw.get("segment_ids", set()),
        usage_balances=kw.get("usage_balances", {}),
        user_usage=kw.get("user_usage"),
        exported_config=cfg,
    )


def _rule(eid: str, type_fields: dict[str, Any], **kw: Any) -> dict[str, Any]:
    r: dict[str, Any] = {
        "id": f"r_{eid}",
        "entitlement_id": eid,
        "targets": kw.get("targets", [{"kind": "plan", "id": "starter"}]),
        "segment_id": kw.get("segment_id"),
        "type_fields": type_fields,
    }
    return r


class TestFeature:
    def test_enabled(self) -> None:
        cfg = _cfg([_rule("f", {"kind": "feature", "enabled": True})])
        assert _derive(cfg, "f") == {"status": "allowed", "allowed": True}

    def test_disabled(self) -> None:
        cfg = _cfg([_rule("f", {"kind": "feature", "enabled": False})])
        assert _derive(cfg, "f") == {
            "status": "denied",
            "allowed": False,
            "reason": "feature_not_enabled_for_plan",
        }

    def test_enabled_defaults_true_when_unset(self) -> None:
        # `enabled !== false` → only an explicit False disables.
        cfg = _cfg([_rule("f", {"kind": "feature"})])
        assert _derive(cfg, "f")["allowed"] is True


class TestNoMatch:
    def test_no_rule_for_handle(self) -> None:
        cfg = _cfg([_rule("other", {"kind": "feature", "enabled": True})])
        # No rule grants this entitlement to the user's plan → denied (fail closed).
        assert _derive(cfg, "missing") == {
            "status": "denied",
            "allowed": False,
            "reason": "no_matching_entitlement_rule",
        }

    def test_explicit_only_plan_targeting(self) -> None:
        # Rule targets plan "pro"; user on "starter" → no match (plan 34
        # REQ-9: targeting is always explicit).
        cfg = _cfg(
            [
                _rule(
                    "f",
                    {"kind": "feature", "enabled": True},
                    targets=[{"kind": "plan", "id": "pro"}],
                )
            ],
            plans=[
                {"id": "starter", "unique_handle": "starter"},
                {"id": "pro", "unique_handle": "pro"},
            ],
        )
        assert _derive(cfg, "f", plan="starter")["reason"] == "no_matching_entitlement_rule"


class TestUsageEnforcement:
    def _ul(self, enf: str | None) -> dict[str, Any]:
        tf: dict[str, Any] = {"kind": "usage_limit", "limit_value": 10}
        if enf is not None:
            tf["enforcement"] = enf
        return _cfg([_rule("u", tf)])

    def test_under_limit_allowed(self) -> None:
        assert _derive(self._ul("hard_block"), "u", context={"used": 3}) == {
            "status": "allowed",
            "allowed": True,
            "limit": 10,
            "used": 3,
            "remaining": 7,
        }

    def test_hard_block(self) -> None:
        assert _derive(self._ul("hard_block"), "u", context={"used": 12}) == {
            "status": "denied",
            "allowed": False,
            "reason": "usage_limit_reached",
            "limit": 10,
            "used": 12,
            "remaining": 0,
        }

    def test_soft_block(self) -> None:
        assert _derive(self._ul("soft_block"), "u", context={"used": 12})["reason"] == (
            "usage_limit_reached_soft_block"
        )

    def test_degrade_is_limited_but_allowed(self) -> None:
        r = _derive(self._ul("degrade"), "u", context={"used": 12})
        assert r == {
            "status": "limited",
            "allowed": True,
            "reason": "usage_limit_reached_degraded",
            "limit": 10,
            "used": 12,
            "remaining": 0,
        }

    def test_allow_overage(self) -> None:
        r = _derive(self._ul("allow_overage"), "u", context={"used": 12})
        assert r == {
            "status": "allowed",
            "allowed": True,
            "reason": "usage_limit_reached_overage",
            "limit": 10,
            "used": 12,
            "remaining": 0,
        }

    def test_unset_default_limited_not_allowed(self) -> None:
        r = _derive(self._ul(None), "u", context={"used": 12})
        assert r == {
            "status": "limited",
            "allowed": False,
            "reason": "usage_limit_reached",
            "limit": 10,
            "used": 12,
            "remaining": 0,
        }


class TestCredits:
    def test_allowance_exhausted(self) -> None:
        cfg = _cfg([_rule("c", {"kind": "credits", "allowance": 5, "enforcement": "hard_block"})])
        assert _derive(cfg, "c", context={"used": 9})["reason"] == ("credit_balance_exhausted")

    def test_initial_grant_fallback_when_no_allowance(self) -> None:
        cfg = _cfg([_rule("c", {"kind": "credits", "initial_grant": 3})])
        assert _derive(cfg, "c", context={"used": 5})["status"] == "limited"
        assert _derive(cfg, "c", context={"used": 1}) == {
            "status": "allowed",
            "allowed": True,
            "limit": 3,
            "used": 1,
            "remaining": 2,
        }


class TestCapabilityTierAndUsageResolution:
    def test_capability_tier_emits_current_tier(self) -> None:
        cfg = _cfg([_rule("t", {"kind": "capability_tier", "tier_name": "gold"})])
        assert _derive(cfg, "t") == {
            "status": "allowed",
            "allowed": True,
            "current_tier": "gold",
        }

    def test_used_precedence_context_over_balances(self) -> None:
        cfg = _cfg(
            [_rule("u", {"kind": "usage_limit", "limit_value": 10, "enforcement": "hard_block"})]
        )
        # context.used (12) wins over usage_balances (1) → over limit.
        assert _derive(cfg, "u", context={"used": 12}, usage_balances={"u": 1})["allowed"] is False
        # No context → usage_balances consulted.
        assert _derive(cfg, "u", usage_balances={"u": 1})["allowed"] is True


class TestHandleIsTheOnlyIdentity:
    """Plan 191 REQ-1 — `id` is DB-internal and matches NOTHING.

    Both halves of identity resolution — the entitlement reference and the
    plan reference — key on `unique_handle` alone, mirroring
    entitlement-check.ts since plan 120 TASK-4. This port carried the
    pre-plan-120 `id`-or-handle fallback until plan 191 TASK-5, which made
    it DENY where TS granted on any config whose ids differ from its
    handles (every real export: `ent_core_credits` vs `core_credits`).
    Cross-language byte parity is additionally locked by the
    `entitlement_plan_identity_is_handle` fixture.
    """

    @staticmethod
    def _cfg_with_distinct_ids(rule_entitlement_ref: str, plan_target: str) -> dict[str, Any]:
        return {
            "version": "1.0.0",
            "plans": [{"id": "p_9f3", "unique_handle": "pro"}],
            "entitlements": [{"id": "ent_7c1", "unique_handle": "batch_export"}],
            "entitlement_rules": [
                {
                    "id": "er_4d8",
                    "entitlement_id": rule_entitlement_ref,
                    "targets": [{"kind": "plan", "id": plan_target}],
                    "segment_id": None,
                    "type_fields": {"kind": "feature", "enabled": False},
                }
            ],
        }

    def test_rule_entitlement_ref_is_the_handle(self) -> None:
        cfg = self._cfg_with_distinct_ids("batch_export", "pro")
        assert _derive(cfg, "batch_export", plan="pro")["reason"] == "feature_not_enabled_for_plan"

    def test_rule_entitlement_ref_by_db_id_matches_nothing(self) -> None:
        cfg = self._cfg_with_distinct_ids("ent_7c1", "pro")
        assert _derive(cfg, "batch_export", plan="pro") == {
            "status": "denied",
            "allowed": False,
            "reason": "no_matching_entitlement_rule",
        }

    def test_checking_by_entitlement_db_id_resolves_nothing(self) -> None:
        cfg = self._cfg_with_distinct_ids("batch_export", "pro")
        assert _derive(cfg, "ent_7c1", plan="pro")["reason"] == "no_matching_entitlement_rule"

    def test_plan_target_matches_the_handle(self) -> None:
        cfg = self._cfg_with_distinct_ids("batch_export", "pro")
        assert _derive(cfg, "batch_export", plan="pro")["reason"] == "feature_not_enabled_for_plan"

    def test_plan_identity_given_as_db_id_matches_nothing(self) -> None:
        """AC-1 — a context whose only plan signal is `plan.id` fails closed."""
        cfg = self._cfg_with_distinct_ids("batch_export", "pro")
        assert _derive(cfg, "batch_export", plan="p_9f3") == {
            "status": "denied",
            "allowed": False,
            "reason": "no_matching_entitlement_rule",
        }

    def test_plan_target_written_as_db_id_matches_nothing(self) -> None:
        cfg = self._cfg_with_distinct_ids("batch_export", "p_9f3")
        assert _derive(cfg, "batch_export", plan="pro")["reason"] == "no_matching_entitlement_rule"
