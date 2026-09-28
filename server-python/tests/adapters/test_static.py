"""Tests for ``revturbine.core.adapters.static.create_static_providers``.

Covers the six provider domains built from an ExportedConfig snapshot
(plan / entitlements / segments / rules / content / theme), the
usage-override + plan-name fallbacks, the targets→plan_ids filter, and
the empty-config no-provider path. Expected values traced from
revturbine-scaffold/src/core/adapters/static.ts. (End-to-end byte
parity with the TS adapter is additionally locked by
revturbine-sdk-internal/tests/parity.)
"""

from __future__ import annotations

from typing import Any

from revturbine.core.adapters.static import (
    apply_server_builtin_dimensions,
    create_static_providers,
)


def _by_domain(providers: list[Any]) -> dict[str, Any]:
    return {p.domain: p for p in providers}


def test_empty_config_yields_no_providers() -> None:
    assert create_static_providers(config={}) == []


def test_plan_provider_name_falls_back_to_handle() -> None:
    providers = _by_domain(create_static_providers(config={}, plan_handle="pro"))
    assert providers["plan"].resolve() == {
        "current_plan_handle": "pro",
        "current_plan_name": "pro",
    }
    explicit = _by_domain(
        create_static_providers(config={}, plan_handle="pro", plan_name="Professional")
    )
    assert explicit["plan"].resolve()["current_plan_name"] == "Professional"


def test_entitlements_default_policy_and_usage_override() -> None:
    config = {"entitlements": [{"unique_handle": "seats", "unit": "seat"}]}
    providers = _by_domain(
        create_static_providers(config=config, usage={"seats": {"used": 3, "limit": 5}})
    )
    state = providers["entitlements"].resolve()
    assert state["entries"]["seats"] == {
        "status": "allowed",
        "allowed": True,
        "reason": "static_config_default_allow",
    }
    assert state["usage"]["seats"] == {
        "used": 3,
        "limit": 5,
        "remaining": 2,
        "unit": "seat",
    }


def test_entitlements_deny_policy() -> None:
    config = {"entitlements": [{"unique_handle": "x"}]}
    state = _by_domain(create_static_providers(config=config, default_entitlement_policy="deny"))[
        "entitlements"
    ].resolve()
    assert state["entries"]["x"] == {
        "status": "denied",
        "allowed": False,
        "reason": "static_config_default_deny",
    }


# -- Segment membership (BL-0369) --------------------------------------------
#
# The segments provider reports the user's MEMBERSHIP. It used to report every
# configured segment, so a payload or rule chipped to any segment was served to
# every user. Mirrors static.test.ts (scaffold) and server-rust's
# tests/static_providers.rs.

_MEMBERSHIP_CONFIG: dict[str, Any] = {
    "segments": [
        {
            "id": "seg_paid",
            "handle": "rt.subscription_state.paid",
            "dimension_id": "rt.subscription_state",
            "predicates": [{"field": "rt_subscription_state", "operator": "eq", "value": "paid"}],
        },
        {
            "handle": "power_users",
            "predicates": [{"field": "sessions", "operator": "gte", "value": "10"}],
        },
        {"handle": "vip_accounts"},
    ]
}


def _membership(**kwargs: Any) -> Any:
    providers = create_static_providers(config=_MEMBERSHIP_CONFIG, **kwargs)
    return _by_domain(providers)["segments"].resolve()


def test_segments_provider_reports_no_membership_without_inputs() -> None:
    assert _membership() == {"segment_ids": [], "segment_slugs": []}


def test_segments_provider_matches_builtin_only_from_builtin_dimensions() -> None:
    # Handles, never the legacy `id` - segment identity is the handle (plan 120).
    assert _membership(
        user_context={"id": "u1", "builtin_dimensions": {"subscription_state": "paid"}}
    ) == {
        "segment_ids": ["rt.subscription_state.paid"],
        "segment_slugs": ["rt.subscription_state.paid"],
    }
    assert _membership(user_context={"id": "u1"})["segment_ids"] == []
    # A reserved rt_* key arriving through custom is deleted (plan 279 PD-1).
    shadow = {"id": "u1", "custom": {"rt_subscription_state": "paid"}}
    assert _membership(user_context=shadow)["segment_ids"] == []


def test_segments_provider_evaluates_trait_predicates() -> None:
    power = {"id": "u1", "custom": {"sessions": 12}}
    casual = {"id": "u1", "custom": {"sessions": 3}}
    assert _membership(user_context=power)["segment_ids"] == ["power_users"]
    assert _membership(user_context=casual)["segment_ids"] == []


def test_segments_provider_reports_supplied_ids_first_deduplicated() -> None:
    assert _membership(
        segment_ids=["vip_accounts", "power_users"],
        user_context={"id": "u1", "custom": {"sessions": 12}},
    )["segment_ids"] == ["vip_accounts", "power_users"]


def test_segments_provider_present_for_supplied_ids_without_configured_segments() -> None:
    providers = create_static_providers(config={"segments": []}, segment_ids=["vip_accounts"])
    assert _by_domain(providers)["segments"].resolve() == {
        "segment_ids": ["vip_accounts"],
        "segment_slugs": ["vip_accounts"],
    }


# -- Server built-in dimension overlay (BL-0366, plan 279 PD-3) --------------
#
# Mirrors static.test.ts (scaffold) and server-rust's tests/static_providers.rs.


def test_server_builtin_dimensions_win_over_the_app_set_value() -> None:
    assert _membership(
        user_context={"id": "u1", "builtin_dimensions": {"subscription_state": "free"}},
        server_builtin_dimensions={"subscription_state": "paid"},
    )["segment_ids"] == ["rt.subscription_state.paid"]
    # And the reverse: a server value demotes an app-set paid.
    assert (
        _membership(
            user_context={"id": "u1", "builtin_dimensions": {"subscription_state": "paid"}},
            server_builtin_dimensions={"subscription_state": "trial"},
        )["segment_ids"]
        == []
    )


def test_server_overlay_keeps_app_leaves_the_server_did_not_deliver() -> None:
    overlaid = apply_server_builtin_dimensions(
        {"id": "u1", "builtin_dimensions": {"subscription_state": "trial", "seat_type": "admin"}},
        {"activity_level": "high"},
    )
    assert overlaid is not None
    assert overlaid["builtin_dimensions"] == {
        "subscription_state": "trial",
        "seat_type": "admin",
        "activity_level": "high",
    }


def test_server_overlay_applies_onto_a_context_with_no_dimensions() -> None:
    assert _membership(
        user_context={"id": "u1"},
        server_builtin_dimensions={"subscription_state": "paid"},
    )["segment_ids"] == ["rt.subscription_state.paid"]


def test_server_overlay_is_ignored_without_a_user_context() -> None:
    assert (
        _membership(server_builtin_dimensions={"subscription_state": "paid"})["segment_ids"] == []
    )


def test_server_overlay_never_mutates_and_passes_through_when_absent() -> None:
    context = {"id": "u1", "builtin_dimensions": {"subscription_state": "trial"}}
    apply_server_builtin_dimensions(context, {"subscription_state": "paid"})
    assert context["builtin_dimensions"] == {"subscription_state": "trial"}
    assert apply_server_builtin_dimensions(context, None) is context
    assert apply_server_builtin_dimensions(None, {"subscription_state": "paid"}) is None


def test_rules_provider_carries_segment_dimensions_and_playbook_version() -> None:
    config = {
        **_MEMBERSHIP_CONFIG,
        "format_version": "1.0.0",
        "entitlement_rules": [{"id": "r1", "entitlement_id": "x", "segment_ids": []}],
    }
    state = _by_domain(create_static_providers(config=config))["rules"].resolve()
    assert state["segment_dimensions"] == {"rt.subscription_state.paid": "rt.subscription_state"}
    assert state["config_version"] == "1.0.0"


def test_rules_provider_flat_wire() -> None:
    # Plan 147 (OQ-6): flat wire — the rule carries its per-kind fields at the
    # top level, `kind` derives from the parent entitlement's type, and `fields`
    # is the flat rule (extra keys are harmless; the evaluator reads specific
    # ones). Mirrors static.ts.
    config = {
        "version": "1.0.0",
        "entitlements": [{"unique_handle": "ent_a", "name": "A", "type": "credits"}],
        "entitlement_rules": [
            {
                "id": "r1",
                "entitlement_id": "ent_a",
                "targets": [
                    {"kind": "plan", "id": "starter"},
                    {"kind": "addon", "id": "pack"},
                ],
                "segment_ids": ["seg1"],
                "allowance_value": 5,
            }
        ],
    }
    state = _by_domain(create_static_providers(config=config))["rules"].resolve()
    assert state["config_version"] == "1.0.0"
    snap = state["entitlement_rules"]["ent_a"][0]
    assert snap["rule_id"] == "r1"
    assert snap["plan_ids"] == ["starter"]  # addon target filtered out
    assert snap["segment_ids"] == ["seg1"]
    assert snap["kind"] == "credits"  # derived from the entitlement's type
    assert snap["fields"]["allowance_value"] == 5


def test_rules_provider_tolerates_legacy_nested_type_fields() -> None:
    # Migration-window tolerance: a legacy nested `type_fields` bag still resolves
    # (kind from the nested bag, its fields merged under the flat rule).
    config = {
        "version": "1.0.0",
        "entitlement_rules": [
            {
                "id": "r1",
                "entitlement_id": "ent_a",
                "targets": [{"kind": "plan", "id": "starter"}],
                "segment_ids": [],
                "type_fields": {"kind": "credits", "allowance": 5},
            }
        ],
    }
    snap = _by_domain(create_static_providers(config=config))["rules"].resolve()[
        "entitlement_rules"
    ]["ent_a"][0]
    assert snap["kind"] == "credits"
    assert snap["fields"].get("allowance") == 5


def test_content_provider_message_blocks() -> None:
    config = {
        "message_blocks": [
            {
                "block_id": "b1",
                "name": "Hero",
                "default_content": {"header": "Hi"},
                "status": "active",
                "segment_overrides": [{"segment_value_id": "s1", "content": {"header": "Yo"}}],
            }
        ]
    }
    state = _by_domain(create_static_providers(config=config))["content"].resolve()
    block = state["message_blocks"]["b1"]
    assert block["block_id"] == "b1"
    assert block["name"] == "Hero"
    assert block["segment_overrides"] == [{"segment_id": "s1", "content": {"header": "Yo"}}]
    assert state["personalization"] == {}


def test_theme_provider_only_when_non_empty() -> None:
    assert "theme" not in _by_domain(create_static_providers(config={"theme": {}}))
    state = _by_domain(create_static_providers(config={"theme": {"colors": {"primary": "#000"}}}))[
        "theme"
    ].resolve()
    assert state == {"overrides": {"colors": {"primary": "#000"}}}
