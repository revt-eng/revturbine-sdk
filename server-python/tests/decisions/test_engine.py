"""Direct unit tests for ``revturbine.core.decisions.engine.DecisionEngine``.

The TS-side suite (revturbine-scaffold/src/core/e2e.test.ts) is
integration-style: it spins up a full DecisionEngine with providers,
storage, and resolvers configured. These tests cover the same
behavioral surface but at the unit boundary — the placement-resolver
path is covered by a stub callable, and the entitlement-check path
runs against a stub provider.

The ten-fixture pilot corpus lives in ``tests/decisions/test_engine_pilot.py``.
"""

from __future__ import annotations

from typing import Any

import pytest

from revturbine.core.decisions import DecisionEngine, PlacementDecision
from revturbine.core.decisions.types import PlacementDecisionInput, PlacementRecord
from revturbine.core.providers.registry import DomainProviderRegistry
from revturbine.core.state.cap_enforcer import CapEnforcer
from revturbine.core.state.interaction_tracker import InteractionTracker
from revturbine.core.state.storage import InMemoryStorage

# ── Stub providers ──────────────────────────────────────────────────────────


class _Provider:
    def __init__(self, *, domain: str, value: Any) -> None:
        self.domain = domain
        self._value = value

    def resolve(self) -> Any:
        return self._value


def _entitlement_provider(
    entries: dict[str, dict[str, Any]] | None = None,
    usage: dict[str, dict[str, Any]] | None = None,
) -> _Provider:
    state: dict[str, Any] = {"entries": entries or {}}
    if usage is not None:
        state["usage"] = usage
    return _Provider(domain="entitlements", value=state)


def _registry_with_entitlements(**kwargs: Any) -> DomainProviderRegistry:
    reg = DomainProviderRegistry()
    reg.register(_entitlement_provider(**kwargs))
    return reg


# ── No-resolver fallback ────────────────────────────────────────────────────


class TestNoResolver:
    def test_invisible_fallback_with_reason(self) -> None:
        engine = DecisionEngine(registry=DomainProviderRegistry())
        result = engine.evaluate({"placement_id": "p1", "user_id": "u1"})
        assert result["visible"] is False
        assert result["decision_source"] == "fallback"
        assert result["reason_codes"] == ["no_resolver_configured"]
        # Both legacy + canonical content fields populated.
        content = result["content"]
        assert content["header"] == "No resolver"
        assert content["title"] == "No resolver"
        assert content["cta_label"] == ""
        assert content["cta"] == ""

    def test_request_id_present_and_prefixed(self) -> None:
        engine = DecisionEngine(registry=DomainProviderRegistry())
        result = engine.evaluate({"placement_id": "p1", "user_id": "u1"})
        assert result["request_id"].startswith("core_")


# ── Suppression integration ─────────────────────────────────────────────────


class TestSuppressionIntegration:
    def test_dismissed_placement_returns_suppressed(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(
            {"user_id": "u1", "placement_id": "p1", "interaction_type": "dismiss"},
        )
        engine = DecisionEngine(
            registry=DomainProviderRegistry(),
            interaction_tracker=tracker,
        )
        result = engine.evaluate({"placement_id": "p1", "user_id": "u1"})
        assert result["visible"] is False
        assert result["decision_source"] == "cache"
        assert "suppressed_by_dismiss_cooldown" in result["reason_codes"]
        assert result.get("suppression_reason") == "suppressed_by_dismiss_cooldown"

    def test_remind_me_later_uses_distinct_reason(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(
            {
                "user_id": "u1",
                "placement_id": "p1",
                "interaction_type": "remind_me_later",
            },
        )
        engine = DecisionEngine(
            registry=DomainProviderRegistry(),
            interaction_tracker=tracker,
        )
        result = engine.evaluate({"placement_id": "p1", "user_id": "u1"})
        assert "suppressed_until_remind_window" in result["reason_codes"]

    def test_suppression_uses_placement_record_name_when_known(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(
            {"user_id": "u1", "placement_id": "p1", "interaction_type": "dismiss"},
        )
        record: PlacementRecord = PlacementRecord(placement_id="p1", name="Upgrade Banner")
        engine = DecisionEngine(
            registry=DomainProviderRegistry(),
            interaction_tracker=tracker,
            placements={"p1": record},
        )
        result = engine.evaluate({"placement_id": "p1", "user_id": "u1"})
        assert result["content"]["header"] == "Upgrade Banner suppressed"

    def test_suppression_falls_back_to_placement_id_when_unknown(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(
            {"user_id": "u1", "placement_id": "p1", "interaction_type": "dismiss"},
        )
        engine = DecisionEngine(
            registry=DomainProviderRegistry(),
            interaction_tracker=tracker,
        )
        result = engine.evaluate({"placement_id": "p1", "user_id": "u1"})
        assert result["content"]["header"] == "p1 suppressed"

    def test_no_tracker_no_suppression_check(self) -> None:
        engine = DecisionEngine(registry=DomainProviderRegistry())
        result = engine.evaluate({"placement_id": "p1", "user_id": "u1"})
        # No tracker → no suppression-cache hit, falls through to no-resolver.
        assert result["decision_source"] == "fallback"


# ── Resolver integration ────────────────────────────────────────────────────


def _stub_resolver_visible(
    input_data: PlacementDecisionInput,
    placement: PlacementRecord | None,
    context: dict[str, Any],
) -> PlacementDecision:
    return PlacementDecision(
        placement_id=input_data["placement_id"],
        request_id="resolver-rid",
        visible=True,
        decision_source="computed",
        reason_codes=[],
        output={
            "output_id": "out_1",
            "surface": {"type": "banner"},
            "content": {"header": "Upgrade!"},
        },
        content={
            "header": "Upgrade!",
            "body": "",
            "cta_label": "Go",
            "title": "Upgrade!",
            "cta": "Go",
        },
    )


def _stub_resolver_invisible(
    input_data: PlacementDecisionInput,
    placement: PlacementRecord | None,
    context: dict[str, Any],
) -> PlacementDecision:
    return PlacementDecision(
        placement_id=input_data["placement_id"],
        request_id="resolver-rid",
        visible=False,
        decision_source="computed",
        reason_codes=["unqualified"],
        content={"header": "", "body": "", "cta_label": "", "title": "", "cta": ""},
    )


class TestResolverIntegration:
    def test_resolver_visible_decision_passed_through(self) -> None:
        engine = DecisionEngine(
            registry=DomainProviderRegistry(),
            placement_resolver=_stub_resolver_visible,
        )
        result = engine.evaluate({"placement_id": "p1", "user_id": "u1"})
        assert result["visible"] is True
        assert result["content"]["header"] == "Upgrade!"

    def test_resolver_receives_input_placement_and_context(self) -> None:
        seen: dict[str, Any] = {}

        def _capture(
            input_data: PlacementDecisionInput,
            placement: PlacementRecord | None,
            context: dict[str, Any],
        ) -> PlacementDecision:
            seen["input"] = input_data
            seen["placement"] = placement
            seen["context"] = context
            return _stub_resolver_invisible(input_data, placement, context)

        record: PlacementRecord = PlacementRecord(placement_id="p1", name="Banner")
        reg = DomainProviderRegistry()
        engine = DecisionEngine(
            registry=reg,
            placements={"p1": record},
            placement_resolver=_capture,
        )
        engine.evaluate({"placement_id": "p1", "user_id": "u1", "traits": {"plan": "pro"}})
        assert seen["input"]["placement_id"] == "p1"
        assert seen["placement"] == record
        # Provider context surfaced under __providers; explicit traits also
        # propagated to the context bag.
        assert "__providers" in seen["context"]
        assert seen["context"]["traits"] == {"plan": "pro"}


# ── Cap enforcement on visible resolver decisions ───────────────────────────


class TestCapEnforcementHook:
    def test_cap_denial_flips_visible_false(self) -> None:
        storage = InMemoryStorage()
        # Pre-populate the enforcer state by enforcing once outside the
        # engine, then attach to the engine with a resolver that returns
        # the same surface/output_id.
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        # Burn the one allowed slot.
        capped_output = {
            "output_id": "out_1",
            "surface": {"type": "banner"},
            "content": {"caps": {"max_per_period": {"count": 1, "period": "day"}}},
        }
        enforcer.enforce(capped_output)

        # The stub resolver returns an output that's now over-cap.
        def _resolver_with_caps(
            input_data: PlacementDecisionInput,
            placement: PlacementRecord | None,
            context: dict[str, Any],
        ) -> PlacementDecision:
            decision = _stub_resolver_visible(input_data, placement, context)
            decision["output"] = capped_output
            return decision

        engine = DecisionEngine(
            registry=DomainProviderRegistry(),
            cap_enforcer=enforcer,
            placement_resolver=_resolver_with_caps,
        )
        result = engine.evaluate({"placement_id": "p1", "user_id": "u1"})
        assert result["visible"] is False
        assert any("cap" in code for code in result["reason_codes"])
        assert result.get("suppression_reason") is not None

    def test_caps_enforcement_disabled_via_options(self) -> None:
        storage = InMemoryStorage()
        enforcer = CapEnforcer(storage=storage, tenant_id="t1", user_id="u1")
        # Burn the one allowed slot.
        capped_output = {
            "output_id": "out_1",
            "surface": {"type": "banner"},
            "content": {"caps": {"max_per_period": {"count": 1, "period": "day"}}},
        }
        enforcer.enforce(capped_output)

        def _resolver(
            input_data: PlacementDecisionInput,
            placement: PlacementRecord | None,
            context: dict[str, Any],
        ) -> PlacementDecision:
            decision = _stub_resolver_visible(input_data, placement, context)
            decision["output"] = capped_output
            return decision

        engine = DecisionEngine(
            registry=DomainProviderRegistry(),
            cap_enforcer=enforcer,
            options={"enable_caps_enforcement": False},
            placement_resolver=_resolver,
        )
        result = engine.evaluate({"placement_id": "p1", "user_id": "u1"})
        assert result["visible"] is True


# ── check_entitlement ───────────────────────────────────────────────────────


class TestCheckEntitlement:
    def test_allowed_passes_through(self) -> None:
        reg = _registry_with_entitlements(
            entries={"feat": {"status": "allowed", "allowed": True}},
        )
        engine = DecisionEngine(registry=reg)
        assert engine.check_entitlement("feat") == {"status": "allowed", "allowed": True}

    def test_denied_carries_reason(self) -> None:
        reg = _registry_with_entitlements(
            entries={
                "feat": {"status": "denied", "allowed": False, "reason": "plan_too_low"},
            },
        )
        engine = DecisionEngine(registry=reg)
        result = engine.check_entitlement("feat")
        assert result == {"status": "denied", "allowed": False, "reason": "plan_too_low"}

    def test_no_provider_default_allow(self) -> None:
        engine = DecisionEngine(registry=DomainProviderRegistry())
        result = engine.check_entitlement("feat")
        assert result == {
            "status": "allowed",
            "allowed": True,
            "reason": "no_entitlement_provider",
        }

    def test_no_provider_default_deny_via_options(self) -> None:
        engine = DecisionEngine(
            registry=DomainProviderRegistry(),
            options={"default_entitlement_policy": "deny"},
        )
        result = engine.check_entitlement("feat")
        assert result == {
            "status": "denied",
            "allowed": False,
            "reason": "no_entitlement_provider_default_deny",
        }

    def test_handle_not_found_default_allow(self) -> None:
        reg = _registry_with_entitlements(entries={})
        engine = DecisionEngine(registry=reg)
        result = engine.check_entitlement("missing")
        assert result["allowed"] is True
        assert result["reason"] == "entitlement_not_found_default_allow"

    def test_handle_not_found_default_deny(self) -> None:
        reg = _registry_with_entitlements(entries={})
        engine = DecisionEngine(
            registry=reg,
            options={"default_entitlement_policy": "deny"},
        )
        result = engine.check_entitlement("missing")
        assert result["allowed"] is False
        assert result["reason"] == "entitlement_not_found_default_deny"

    def test_usage_limit_exceeded_short_circuits(self) -> None:
        reg = _registry_with_entitlements(
            entries={"feat": {"status": "allowed", "allowed": True}},
            usage={"feat": {"used": 100, "limit": 100, "remaining": 0}},
        )
        engine = DecisionEngine(registry=reg)
        result = engine.check_entitlement("feat", context={"used": 100})
        assert result == {
            "status": "denied",
            "allowed": False,
            "reason": "usage_limit_exceeded",
            "limit": 100,
            "used": 100,
            "remaining": 0,
        }

    def test_usage_limit_zero_skips_enforcement(self) -> None:
        # limit == 0 means "no limit" per TS: `if (usage.limit > 0 && context.used >= usage.limit)`.
        reg = _registry_with_entitlements(
            entries={"feat": {"status": "allowed", "allowed": True}},
            usage={"feat": {"used": 999, "limit": 0, "remaining": 0}},
        )
        engine = DecisionEngine(registry=reg)
        result = engine.check_entitlement("feat", context={"used": 9999})
        assert result["allowed"] is True

    def test_usage_below_limit_includes_usage_fields(self) -> None:
        reg = _registry_with_entitlements(
            entries={"feat": {"status": "allowed", "allowed": True}},
            usage={"feat": {"used": 30, "limit": 100, "remaining": 70}},
        )
        engine = DecisionEngine(registry=reg)
        result = engine.check_entitlement("feat", context={"used": 30})
        assert result["limit"] == 100
        assert result["used"] == 30
        assert result["remaining"] == 70


# ── Entitlement rule surfacing (plan 133) ───────────────────────────────────


def _rules_provider(rules_by_handle: dict[str, list[dict[str, Any]]]) -> _Provider:
    return _Provider(
        domain="rules",
        value={"entitlement_rules": rules_by_handle, "config_version": "v1"},
    )


def _plan_provider(handle: str) -> _Provider:
    return _Provider(domain="plan", value={"current_plan_handle": handle})


class TestEntitlementRuleSurfacing:
    """Mirrors 'Entitlement rule surfacing (plan 133)' in e2e.test.ts —
    a matched configured rule is authoritative over the provider entry's
    default-policy status, and limit-bearing outcomes carry the numbers."""

    def _registry(self) -> DomainProviderRegistry:
        reg = _registry_with_entitlements(
            entries={"api_calls": {"status": "allowed", "allowed": True}},
        )
        reg.register(_plan_provider("pro"))
        reg.register(
            _rules_provider(
                {
                    "api_calls": [
                        {
                            "rule_id": "rule_limit",
                            "entitlement_id": "api_calls",
                            "plan_ids": ["pro"],
                            "segment_ids": [],
                            "kind": "usage_limit",
                            "fields": {
                                "kind": "usage_limit",
                                "limit_value": 5,
                                "enforcement": "hard_block",
                            },
                        }
                    ]
                }
            )
        )
        return reg

    def test_matched_rule_surfaces_limit_fields_under_limit(self) -> None:
        engine = DecisionEngine(registry=self._registry())
        result = engine.check_entitlement("api_calls", context={"used": 3})
        assert result == {
            "status": "allowed",
            "allowed": True,
            "limit": 5,
            "used": 3,
            "remaining": 2,
        }

    def test_matched_rule_enforces_at_limit(self) -> None:
        engine = DecisionEngine(registry=self._registry())
        result = engine.check_entitlement("api_calls", context={"used": 7})
        assert result == {
            "status": "denied",
            "allowed": False,
            "reason": "usage_limit_reached",
            "limit": 5,
            "used": 7,
            "remaining": 0,
        }

    def test_no_matching_rule_fails_closed(self) -> None:
        # Kent's 2026-07-13 ruling: a configured entitlement with no rule
        # assigning it to the user's plan is DENIED (plan-#39 alignment,
        # same reason string as the ExportedConfig evaluator).
        reg = _registry_with_entitlements(
            entries={"api_calls": {"status": "allowed", "allowed": True}},
        )
        reg.register(_plan_provider("starter"))  # rule targets 'pro' only
        reg.register(
            _rules_provider(
                {
                    "api_calls": [
                        {
                            "rule_id": "rule_limit",
                            "entitlement_id": "api_calls",
                            "plan_ids": ["pro"],
                            "segment_ids": [],
                            "kind": "usage_limit",
                            "fields": {"kind": "usage_limit", "limit_value": 5},
                        }
                    ]
                }
            )
        )
        engine = DecisionEngine(registry=reg)
        assert engine.check_entitlement("api_calls") == {
            "status": "denied",
            "allowed": False,
            "reason": "no_matching_entitlement_rule",
        }

    def test_unknown_handle_keeps_default_policy_despite_rules_provider(self) -> None:
        # Fail-closed judges rule assignments for configured entitlements; a
        # handle with no entry at all keeps default-policy behavior.
        reg = _registry_with_entitlements(
            entries={"api_calls": {"status": "allowed", "allowed": True}},
        )
        reg.register(_plan_provider("pro"))
        reg.register(_rules_provider({"api_calls": []}))
        engine = DecisionEngine(registry=reg)
        result = engine.check_entitlement("never_configured")
        assert result["allowed"] is True
        assert result["reason"] == "entitlement_not_found_default_allow"

    def test_matched_unshaped_kind_falls_through_to_usage_logic(self) -> None:
        # Legacy kinds (e.g. 'metered') prove the plan assignment without the
        # shaper modeling them — usage-snapshot enforcement still applies and
        # the result is NOT the fail-closed denial.
        reg = _registry_with_entitlements(
            entries={"api_calls": {"status": "allowed", "allowed": True}},
            usage={"api_calls": {"used": 1000, "limit": 1000, "remaining": 0}},
        )
        reg.register(_plan_provider("pro"))
        reg.register(
            _rules_provider(
                {
                    "api_calls": [
                        {
                            "rule_id": "rule_metered",
                            "entitlement_id": "api_calls",
                            "plan_ids": ["pro"],
                            "segment_ids": [],
                            "kind": "metered",
                            "fields": {"kind": "metered", "limit": 1000},
                        }
                    ]
                }
            )
        )
        engine = DecisionEngine(registry=reg)
        result = engine.check_entitlement("api_calls", context={"used": 1000})
        assert result["allowed"] is False
        assert result["reason"] == "usage_limit_exceeded"

    def test_matched_disabled_feature_rule_overrides_default_allow(self) -> None:
        reg = _registry_with_entitlements(
            entries={"dashboard": {"status": "allowed", "allowed": True}},
        )
        reg.register(_plan_provider("pro"))
        reg.register(
            _rules_provider(
                {
                    "dashboard": [
                        {
                            "rule_id": "rule_off",
                            "entitlement_id": "dashboard",
                            "plan_ids": ["pro"],
                            "segment_ids": [],
                            "kind": "feature",
                            "fields": {"kind": "feature", "enabled": False},
                        }
                    ]
                }
            )
        )
        engine = DecisionEngine(registry=reg)
        assert engine.check_entitlement("dashboard") == {
            "status": "denied",
            "allowed": False,
            "reason": "feature_not_enabled_for_plan",
        }


# ── Convenience APIs ────────────────────────────────────────────────────────


class TestConvenienceMethods:
    def test_evaluate_batch_runs_each_input(self) -> None:
        engine = DecisionEngine(
            registry=DomainProviderRegistry(),
            placement_resolver=_stub_resolver_visible,
        )
        results = engine.evaluate_batch(
            [
                {"placement_id": "p1", "user_id": "u1"},
                {"placement_id": "p2", "user_id": "u1"},
            ],
        )
        assert len(results) == 2
        assert all(r["visible"] for r in results)

    def test_track_interaction_delegates(self) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        engine = DecisionEngine(
            registry=DomainProviderRegistry(),
            interaction_tracker=tracker,
        )
        engine.track_interaction(
            {"user_id": "u1", "placement_id": "p1", "interaction_type": "dismiss"},
        )
        # Tracker now has the suppression entry.
        assert tracker.check_suppression("p1", "u1")["suppressed"] is True

    def test_track_interaction_without_tracker_is_noop(self) -> None:
        engine = DecisionEngine(registry=DomainProviderRegistry())
        engine.track_interaction(
            {"user_id": "u1", "placement_id": "p1", "interaction_type": "dismiss"},
        )  # No raise.

    def test_resolve_providers_returns_merged_context(self) -> None:
        reg = DomainProviderRegistry()
        reg.register(_entitlement_provider(entries={"a": {"status": "allowed", "allowed": True}}))
        reg.register(_Provider(domain="plan", value={"current_plan_handle": "pro"}))
        engine = DecisionEngine(registry=reg)
        ctx = engine.resolve_providers()
        assert "entitlements" in ctx
        assert ctx["plan"]["current_plan_handle"] == "pro"


# ── Cross-stub guard rails ──────────────────────────────────────────────────


class TestEdgeCases:
    @pytest.mark.parametrize(
        "interaction",
        ["dismiss", "remind_me_later", "cta_clicked", "cta_completed"],
    )
    def test_each_suppressing_interaction_blocks_evaluate(self, interaction: str) -> None:
        storage = InMemoryStorage()
        tracker = InteractionTracker(storage=storage, tenant_id="t1", user_id="u1")
        tracker.track(
            {"user_id": "u1", "placement_id": "p1", "interaction_type": interaction},  # type: ignore[typeddict-item]
        )
        engine = DecisionEngine(
            registry=DomainProviderRegistry(),
            interaction_tracker=tracker,
            placement_resolver=_stub_resolver_visible,
        )
        result = engine.evaluate({"placement_id": "p1", "user_id": "u1"})
        # Visible resolver but suppressed by tracker.
        assert result["visible"] is False
