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

from revturbine.core.adapters.static import create_static_providers


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


def test_segments_provider() -> None:
    config = {"segments": [{"id": "s1", "handle": "free"}, {"id": "s2", "handle": "pro"}]}
    state = _by_domain(create_static_providers(config=config))["segments"].resolve()
    assert state == {"segment_ids": ["s1", "s2"], "segment_slugs": ["free", "pro"]}


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
