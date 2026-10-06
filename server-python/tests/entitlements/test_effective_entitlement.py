"""D-61 (Kent, 2026-10-06): one effective entitlement answer — the shared
Playbook + user-context evaluation, merged with app-mirrored data. App wins
by default; precedence is configurable per provider and per field. Unknown
handles fail closed. Server runtimes and the browser SDK call this same
function on the same inputs.

Port of revturbine-scaffold
src/entitlements/controllers/effective-entitlement.test.ts (17 tests).
"""

from __future__ import annotations

import warnings
from typing import Any

from revturbine.core.adapters import create_static_providers
from revturbine.core.decisions.types import EntitlementCheckResult
from revturbine.core.entitlements.effective_entitlement import (
    EffectiveEntitlementBase,
    EntitlementMergeOptions,
    app_entitlement,
    derive_effective_entitlement,
    derive_effective_entitlements,
    merge_entitlement_results,
    reverse_trial_grants,
)
from revturbine.core.providers.types import DomainProviderName
from revturbine.core.runtime import LocalRuntime

PLAYBOOK: dict[str, Any] = {
    "artifact_type": "playbook",
    "format_version": "1.0.0",
    "playbook_handle": "default",
    "playbook_version_id": None,
    "tenant_id": "t",
    "environment_id": "production",
    "plans": [{"unique_handle": "free", "name": "Free"}, {"unique_handle": "pro", "name": "Pro"}],
    "entitlements": [
        {"unique_handle": "exports", "name": "Exports", "type": "feature"},
        {"unique_handle": "api_calls", "name": "API calls", "type": "usage_limit"},
    ],
    "entitlement_rules": [
        {
            "id": "r_exports_pro",
            "entitlement_id": "exports",
            "targets": [{"kind": "plan", "id": "pro"}],
            "segment_ids": [],
            "type_fields": {"kind": "feature", "enabled": True},
        },
        {
            "id": "r_api_free",
            "entitlement_id": "api_calls",
            "targets": [{"kind": "plan", "id": "free"}],
            "segment_ids": [],
            "type_fields": {
                "kind": "usage_limit",
                "limit_value": 100,
                "enforcement": "hard_block",
            },
        },
    ],
    "reverse_trial_rules": [
        {
            "id": "rt",
            "fallback_plan_id": "free",
            "premium_plan_id": "pro",
            "entitlements_during_trial": ["exports"],
            "is_active": True,
        }
    ],
    "segments": [],
    "content_ui_paths": [],
    "placements": [],
}


def _base(plan: str) -> EffectiveEntitlementBase:
    return {
        "current_plan_handle": plan,
        "segment_ids": set(),
        "usage_balances": {},
        "playbook": PLAYBOOK,
    }


def _subset(actual: Any, expected: dict[str, Any]) -> bool:
    """``toMatchObject``: every expected key is present with that value."""
    return all(k in actual and actual[k] == v for k, v in expected.items())


# ── merge_entitlement_results ───────────────────────────────────────────────


class TestMergeEntitlementResults:
    EVALUATED: EntitlementCheckResult = {
        "status": "denied",
        "allowed": False,
        "reason": "no_matching_entitlement_rule",
        "limit": 100,
        "used": 10,
        "remaining": 90,
    }

    def test_app_wins_by_default_and_reports_a_mirrored_reason(self) -> None:
        merged = merge_entitlement_results(self.EVALUATED, {"status": "allowed", "allowed": True})
        assert _subset(
            merged,
            {
                "status": "allowed",
                "allowed": True,
                "reason": "entitlement_mirrored",
                "limit": 100,
                "used": 10,
            },
        )

    def test_provider_level_precedence_can_make_the_playbook_win(self) -> None:
        merged = merge_entitlement_results(
            self.EVALUATED, {"status": "allowed", "used": 99}, {"precedence": "playbook"}
        )
        assert _subset(merged, {"status": "denied", "used": 10})

    def test_field_level_precedence_mixes_sources(self) -> None:
        merged = merge_entitlement_results(
            self.EVALUATED,
            {"status": "allowed", "used": 95, "remaining": 5},
            {"precedence": "app", "fields": {"status": "playbook"}},
        )
        assert _subset(
            merged,
            {
                "status": "denied",
                "reason": "no_matching_entitlement_rule",
                "used": 95,
                "remaining": 5,
                "limit": 100,
            },
        )

    def test_a_partial_app_entry_usage_only_keeps_the_playbook_status(self) -> None:
        merged = merge_entitlement_results(self.EVALUATED, {"used": 50})
        assert _subset(merged, {"status": "denied", "used": 50})


# ── app_entitlement ─────────────────────────────────────────────────────────


class TestAppEntitlement:
    def test_reads_booleans_and_grants_provider_overrides_user_context_field_by_field(
        self,
    ) -> None:
        assert app_entitlement({"user_context": True}) == {"status": "allowed", "allowed": True}
        assert app_entitlement({"user_context": {"status": "limited", "limit": 10, "used": 4}}) == {
            "status": "limited",
            "allowed": True,
            "limit": 10,
            "used": 4,
            "remaining": 6,
        }
        assert _subset(
            app_entitlement(
                {
                    "user_context": {"status": "allowed", "used": 1},
                    "provider": {"status": "denied", "allowed": False},
                }
            ),
            {"status": "denied", "allowed": False, "used": 1},
        )


# ── derive_effective_entitlement ────────────────────────────────────────────


class TestDeriveEffectiveEntitlement:
    def test_evaluates_the_playbook_when_the_app_is_silent(self) -> None:
        free = derive_effective_entitlement(**_base("free"), handle="exports")["result"]
        assert _subset(free, {"status": "denied"})
        pro = derive_effective_entitlement(**_base("pro"), handle="exports")["result"]
        assert _subset(pro, {"status": "allowed"})

    def test_a_mirrored_grant_overrides_the_playbook(self) -> None:
        out = derive_effective_entitlement(
            **_base("free"), handle="exports", app={"user_context": True}
        )
        assert out == {
            "result": {"status": "allowed", "allowed": True, "reason": "entitlement_mirrored"},
            "unknown_handle": False,
        }

    def test_an_app_only_entitlement_the_playbook_does_not_define_is_valid(self) -> None:
        result = derive_effective_entitlement(
            **_base("free"),
            handle="custom_seats",
            app={"user_context": {"status": "allowed", "limit": 5}},
        )["result"]
        assert _subset(result, {"status": "allowed", "limit": 5})

    def test_an_unknown_handle_fails_closed_and_is_flagged(self) -> None:
        assert derive_effective_entitlement(**_base("pro"), handle="nope") == {
            "result": {
                "status": "denied",
                "allowed": False,
                "reason": "entitlement_not_in_playbook",
            },
            "unknown_handle": True,
        }

    def test_mirrored_usage_feeds_the_evaluation_so_status_and_remaining_stay_coherent(
        self,
    ) -> None:
        near = derive_effective_entitlement(
            **_base("free"), handle="api_calls", app={"user_context": {"used": 95}}
        )["result"]
        assert _subset(near, {"status": "allowed", "used": 95, "remaining": 5, "limit": 100})
        over = derive_effective_entitlement(
            **_base("free"), handle="api_calls", app={"user_context": {"used": 120}}
        )["result"]
        assert _subset(over, {"status": "denied", "used": 120})

    def test_reverse_trial_grants_come_from_the_shared_helper(self) -> None:
        grants = reverse_trial_grants(
            PLAYBOOK, {"in_trial": True, "trial_type": "reverse", "plan_handle": "free"}
        )
        base = _base("free")
        base["trial_granted_entitlement_handles"] = grants["trial_granted_entitlement_handles"]
        base["effective_plan_handle"] = grants["effective_plan_handle"]
        result = derive_effective_entitlement(**base, handle="exports")["result"]
        assert _subset(result, {"status": "allowed"})

    def test_derive_effective_entitlements_covers_playbook_and_app_handles(self) -> None:
        entries = derive_effective_entitlements(
            _base("free"), {"custom_seats": {"user_context": True}}
        )
        assert sorted(entries) == ["api_calls", "custom_seats", "exports"]


# ── LocalRuntime — server verifies with the same evaluation (D-61) ──────────


def _runtime(plan: str, **extra: Any) -> LocalRuntime:
    return LocalRuntime(
        tenant_id="t",
        user_id="u",
        playbook=PLAYBOOK,
        providers=create_static_providers(config=PLAYBOOK, plan_handle=plan),
        **extra,
    )


class _EntitlementsProvider:
    """An app-registered entitlement provider (no ``playbook_default``
    origin), so its entries are app-mirrored data."""

    domain: DomainProviderName = "entitlements"
    cache_ttl_ms: int | None = None

    def __init__(self, entries: dict[str, Any]) -> None:
        self._entries = entries

    def resolve(self) -> Any:
        return {"entries": self._entries}


class TestLocalRuntimeServerVerifiesWithTheSameEvaluation:
    def test_decides_from_the_playbook_rules_not_a_blanket_default(self) -> None:
        assert _runtime("free").check_entitlement("exports")["status"] == "denied"
        assert _runtime("pro").check_entitlement("exports")["status"] == "allowed"

    def test_honours_reverse_trial_grants_on_the_server(self) -> None:
        r = _runtime(
            "free",
            trial_status={"in_trial": True, "trial_type": "reverse", "plan_handle": "free"},
        )
        assert r.check_entitlement("exports")["status"] == "allowed"

    def test_applies_user_context_mirroring_and_the_configured_precedence(self) -> None:
        mirrored = _runtime("free", user_entitlements={"exports": True})
        assert mirrored.check_entitlement("exports")["status"] == "allowed"
        playbook_wins = _runtime(
            "free",
            user_entitlements={"exports": True},
            entitlement_merge={"precedence": "playbook"},
        )
        assert playbook_wins.check_entitlement("exports")["status"] == "denied"

    def test_an_app_entitlement_provider_mirrors_too(self) -> None:
        r = _runtime("free")
        r.update_providers(
            [_EntitlementsProvider({"exports": {"status": "allowed", "allowed": True}})]
        )
        assert r.check_entitlement("exports")["status"] == "allowed"

    def test_denies_an_unknown_handle_warns_once_and_reports_it(self) -> None:
        reported: list[str] = []
        r = _runtime("pro", on_unknown_entitlement=reported.append)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            first = r.check_entitlement("nope")
            r.check_entitlement("nope")
        assert _subset(first, {"status": "denied", "reason": "entitlement_not_in_playbook"})
        assert reported == ["nope"]
        assert len([w for w in caught if issubclass(w.category, RuntimeWarning)]) == 1

    def test_a_server_side_access_gate_fires_for_a_rule_denied_user(self) -> None:
        with_gate: dict[str, Any] = {
            **PLAYBOOK,
            "placements": [
                {
                    "id": "pl_gate",
                    "name": "gate",
                    "category": "gated",
                    "order": 0,
                    "trigger": {"type": "entitlement_gate", "entitlement_handle": "exports"},
                    "payloads": [
                        {
                            "id": "p_gate",
                            "target": {"plan_ids": [], "segment_ids": []},
                            "surfaces": [
                                {
                                    "template_id": "modal_overlay",
                                    "fields": {"header": "Unlock exports"},
                                    "ctas": [],
                                }
                            ],
                        }
                    ],
                }
            ],
        }

        def make(plan: str) -> LocalRuntime:
            return LocalRuntime(
                tenant_id="t",
                user_id="u",
                playbook=with_gate,
                providers=create_static_providers(config=with_gate, plan_handle=plan),
            )

        free = make("free").get_placement_decision({"placement_id": "pl_gate", "user_id": "u"})
        assert free["visible"] is True
        pro = make("pro").get_placement_decision({"placement_id": "pl_gate", "user_id": "u"})
        assert pro["visible"] is False


# ── D-61 — app provides BOTH plan and entitlements (server runtime) ─────────


class _AppProvider:
    """An app-registered domain provider — no static adapter, so an
    entitlements state carries no ``playbook_default`` origin."""

    cache_ttl_ms: int | None = None

    def __init__(self, domain: DomainProviderName, state: dict[str, Any]) -> None:
        self.domain: DomainProviderName = domain
        self._state = state

    def resolve(self) -> Any:
        return self._state


class TestAppProvidesBothPlanAndEntitlements:
    """exports: Playbook only (Pro rule). api_calls: Playbook (Pro, limit
    1000) AND the app (billing hold + usage). custom_seats: app only."""

    MIXED_PLAYBOOK: dict[str, Any] = {
        **PLAYBOOK,
        "entitlement_rules": [
            {
                "id": "r_exports_pro",
                "entitlement_id": "exports",
                "targets": [{"kind": "plan", "id": "pro"}],
                "segment_ids": [],
                "type_fields": {"kind": "feature", "enabled": True},
            },
            {
                "id": "r_api_pro",
                "entitlement_id": "api_calls",
                "targets": [{"kind": "plan", "id": "pro"}],
                "segment_ids": [],
                "type_fields": {
                    "kind": "usage_limit",
                    "limit_value": 1000,
                    "enforcement": "hard_block",
                },
            },
        ],
    }

    def _runtime(self, merge: EntitlementMergeOptions | None = None) -> LocalRuntime:
        return LocalRuntime(
            tenant_id="t",
            user_id="u",
            playbook=self.MIXED_PLAYBOOK,
            # No static adapter: the app is the only provider of plan and
            # entitlements.
            providers=[
                _AppProvider("plan", {"current_plan_handle": "pro"}),
                _AppProvider(
                    "entitlements",
                    {
                        "entries": {
                            "api_calls": {
                                "status": "denied",
                                "allowed": False,
                                "reason": "billing_hold",
                            },
                            "custom_seats": {"status": "allowed", "allowed": True, "limit": 5},
                        },
                        "usage": {"api_calls": {"used": 10, "limit": 1000, "remaining": 990}},
                    },
                ),
            ],
            entitlement_merge=merge,
        )

    def test_playbook_only_handle_evaluates_the_rules_against_the_app_provided_plan(
        self,
    ) -> None:
        assert _subset(
            self._runtime().check_entitlement("exports"),
            {"status": "allowed", "rule_handle": "r_exports_pro"},
        )

    def test_overlapping_handle_the_app_entry_wins_by_default_playbook_numbers_fill_gaps(
        self,
    ) -> None:
        assert _subset(
            self._runtime().check_entitlement("api_calls"),
            {
                "status": "denied",
                "allowed": False,
                "reason": "billing_hold",
                "limit": 1000,
                "used": 10,
                "remaining": 990,
            },
        )

    def test_overlapping_handle_provider_level_precedence_playbook_lets_the_pro_rule_decide(
        self,
    ) -> None:
        assert _subset(
            self._runtime({"precedence": "playbook"}).check_entitlement("api_calls"),
            {"status": "allowed", "limit": 1000, "used": 10, "remaining": 990},
        )

    def test_overlapping_handle_field_level_status_from_playbook_usage_from_app(self) -> None:
        assert _subset(
            self._runtime({"fields": {"status": "playbook"}}).check_entitlement("api_calls"),
            {"status": "allowed", "used": 10, "limit": 1000},
        )

    def test_app_only_handle_comes_from_the_app_provider(self) -> None:
        assert _subset(
            self._runtime().check_entitlement("custom_seats"),
            {"status": "allowed", "limit": 5, "reason": "entitlement_mirrored"},
        )

    def test_a_handle_neither_side_knows_is_denied(self) -> None:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            result = self._runtime().check_entitlement("never_defined")
        assert _subset(result, {"status": "denied", "reason": "entitlement_not_in_playbook"})
