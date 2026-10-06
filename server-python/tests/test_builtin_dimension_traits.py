"""Plan 279 TASK-4 (BL-0310/BL-0311): built-in dimension trait stamping.

``build_targeting_state`` stamps the reserved ``rt_<dimension>`` traits only
from ``builtin_dimensions`` (and ``rt_registration_state`` from ``id``), and
deletes any ``rt_*`` key arriving through ``custom``, ``entitlements`` or
usage. The byte-level contract with TS and Rust is the parity fixture
``builtin_dimension_traits.json``; these tests pin the port's own rules.
"""

from __future__ import annotations

from typing import Any

from revturbine.core.user_context import (
    BUILTIN_DIMENSION_VOCABULARIES,
    build_targeting_state,
    derive_builtin_dimension_traits,
    mirrored_entitlement_trait,
)


def _rt(bag: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in bag.items() if k.startswith("rt_")}


def test_anonymous_context_stamps_only_unregistered() -> None:
    state = build_targeting_state({})
    assert _rt(state["traits"]) == {"rt_registration_state": "unregistered"}
    assert _rt(state["segment_traits"]) == {"rt_registration_state": "unregistered"}


def test_registration_follows_a_non_empty_string_id() -> None:
    assert derive_builtin_dimension_traits({"id": "u"})["rt_registration_state"] == "registered"
    assert derive_builtin_dimension_traits({"id": ""})["rt_registration_state"] == "unregistered"
    assert derive_builtin_dimension_traits({"id": 7})["rt_registration_state"] == "unregistered"


def test_every_in_vocabulary_value_stamps() -> None:
    for key, vocabulary in BUILTIN_DIMENSION_VOCABULARIES.items():
        for value in vocabulary or ("editor", "a" * 87):
            traits = derive_builtin_dimension_traits({"builtin_dimensions": {key: value}})
            assert traits == {"rt_registration_state": "unregistered", f"rt_{key}": value}


def test_out_of_vocabulary_and_wrong_type_values_drop() -> None:
    traits = derive_builtin_dimension_traits(
        {
            "builtin_dimensions": {
                "registration_state": "registered",
                "activity_level": "active",
                "trial_type": "free",
                "email_type": "Business",
                "seat_type": "a" * 88,
                "buyer_role": True,
                "region": 3,
                "device_type": None,
                "billing_health": "",
            }
        }
    )
    assert traits == {"rt_registration_state": "unregistered"}
    assert derive_builtin_dimension_traits({"builtin_dimensions": ["paid"]}) == {
        "rt_registration_state": "unregistered"
    }


def test_reserved_keys_from_custom_entitlements_and_usage_are_deleted() -> None:
    state = build_targeting_state(
        {
            "custom": {
                "rt_subscription_state": "paid",
                "rt_email_type": "business",
                "role": "admin",
            },
            "entitlements": {"rt_region": True, "beta": True},
            "usage": {"rt_activity_level": {"amount": 5}, "api_calls": {"amount": 3}},
            "builtin_dimensions": {"subscription_state": "trial"},
        },
        None,
        {"rt_device_type": 1, "seats": 2},
    )
    assert _rt(state["traits"]) == {
        "rt_registration_state": "unregistered",
        "rt_subscription_state": "trial",
    }
    assert _rt(state["segment_traits"]) == _rt(state["traits"])
    assert _rt(state["usage"]) == {}
    assert state["traits"]["role"] == "admin"
    assert state["traits"]["beta"] is True
    assert state["usage"] == {"api_calls": 3, "seats": 2}


def test_mirrored_entitlement_grants_flatten_to_boolean_traits() -> None:
    # D-61: UserContext.entitlements takes the same mirrored input as the
    # effective-entitlement core (a boolean or a grant); segment traits stay
    # scalar — a grant counts unless it is denied. Mirrors user-context.ts
    # mirroredEntitlementTrait.
    state = build_targeting_state(
        {
            "entitlements": {
                "flag_on": True,
                "flag_off": False,
                "seats": {"status": "limited", "limit": 5},
                "held": {"status": "denied"},
                "revoked": {"status": "allowed", "allowed": False},
                "usage_only": {"used": 3},
            }
        }
    )
    assert {k: state["traits"][k] for k in ("flag_on", "flag_off", "seats", "held")} == {
        "flag_on": True,
        "flag_off": False,
        "seats": True,
        "held": False,
    }
    assert state["traits"]["revoked"] is False
    assert state["traits"]["usage_only"] is True
    assert mirrored_entitlement_trait({"status": "allowed"}) is True
