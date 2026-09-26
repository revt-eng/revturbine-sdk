"""Python port of scaffold's ``user/controllers/user-context.ts``
targeting-state derivation (plan 234 TASK-8b).

Until this landed, segment parity was "agrees given the same traits" -
``evaluate_segments`` was byte-locked as a pure predicate, but the
derivation from a raw user context TO those traits existed only in the
TypeScript core and web SDK; this module (and its Rust twin) closes that to
"agrees given the same user context".
"""

from __future__ import annotations

import re
from typing import Any

from revturbine.core.helpers import (
    JsonObject,
    configured_plan_name_from_playbook,
    is_record,
    plan_identity_from_context,
    usage_amounts_from_entries,
)

# ── Built-in segment dimensions (plan 279 PD-1/PD-4) ──────────────────────
#
# Contract: targeting-studio-ui.md §4.1 "Built-in segment resolution
# contract". Source: scaffold segments/controllers/builtin-dimensions.ts (the
# catalogue) and user/controllers/user-context.ts (deriveBuiltinDimensionTraits).

#: The reserved trait-key prefix. Only ``builtin_dimensions`` (and ``id``, for
#: registration) may set a key under it.
BUILTIN_TRAIT_KEY_PREFIX = "rt_"

#: The delivered dimensions in catalogue order, each with its closed
#: vocabulary. ``None`` marks Seat Type, whose values are tenant seat-type
#: handles. Registration State is absent: it is SDK-local (from ``id``).
BUILTIN_DIMENSION_VOCABULARIES: dict[str, tuple[str, ...] | None] = {
    "activity_level": ("new", "high", "medium", "low", "inactive"),
    "subscription_state": ("none", "trial", "paid", "cancelled"),
    "trial_type": ("none", "free_trial", "reverse_trial"),
    "seat_type": None,
    "buyer_role": ("buyer", "non_buyer"),
    "email_type": ("business", "personal", "unknown"),
    "billing_health": (
        "no_billing",
        "good_standing",
        "trial_payment_method_attached",
        "payment_method_missing",
        "payment_failed",
        "payment_overdue",
        "cancelled",
    ),
    "region": ("us_canada", "europe", "rest_of_world"),
    "device_type": ("desktop", "mobile", "tablet", "unknown"),
}

# HANDLE_PATTERN (``^[a-z0-9._]{1,100}$``) capped at 87 characters, so that
# ``rt.seat_type.<handle>`` stays within the 100-character handle limit.
_SEAT_TYPE_VALUE = re.compile(r"[a-z0-9._]{1,87}")


def is_reserved_trait_key(key: str) -> bool:
    """Whether a trait key falls under the reserved ``rt_`` prefix.

    Source: builtin-dimensions.ts (isReservedTraitKey)
    """
    return key.startswith(BUILTIN_TRAIT_KEY_PREFIX)


def _is_builtin_dimension_value(key: str, value: str) -> bool:
    vocabulary = BUILTIN_DIMENSION_VOCABULARIES[key]
    if vocabulary is None:
        return _SEAT_TYPE_VALUE.fullmatch(value) is not None
    return value in vocabulary


def derive_builtin_dimension_traits(context: JsonObject) -> dict[str, str]:
    """The reserved ``rt_<dimension>`` segment traits for a user context.

    ``rt_registration_state`` is always stamped: ``registered`` iff ``id`` is
    a non-empty string. Every other dimension is stamped only from
    ``builtin_dimensions``, and only with an in-vocabulary string; an absent
    or out-of-vocabulary value stamps nothing (unknown is absence). A
    ``registration_state`` key inside ``builtin_dimensions`` is ignored.

    Source: user-context.ts (deriveBuiltinDimensionTraits)
    """
    user_id = context.get("id")
    traits: dict[str, str] = {
        "rt_registration_state": (
            "registered" if isinstance(user_id, str) and len(user_id) > 0 else "unregistered"
        ),
    }
    delivered = context.get("builtin_dimensions")
    if not is_record(delivered):
        return traits
    for key in BUILTIN_DIMENSION_VOCABULARIES:
        value = delivered.get(key)
        if isinstance(value, str) and _is_builtin_dimension_value(key, value):
            traits[f"{BUILTIN_TRAIT_KEY_PREFIX}{key}"] = value
    return traits


def _strip_reserved_trait_keys(bag: dict[str, Any]) -> None:
    for key in [k for k in bag if is_reserved_trait_key(k)]:
        del bag[key]


def to_segment_evaluation_traits(
    traits: JsonObject,
    effective_plan: str | None,
    usage: dict[str, float],
) -> dict[str, str | float | bool]:
    """Scalar-only trait view for segment evaluation; non-scalars drop.

    Source: user-context.ts (toSegmentEvaluationTraits)
    """
    segment_traits: dict[str, str | float | bool] = {}
    for key, value in traits.items():
        if isinstance(value, (str, bool)) or (
            isinstance(value, (int, float)) and not isinstance(value, bool)
        ):
            segment_traits[key] = value

    if effective_plan and "plan" not in segment_traits:
        segment_traits["plan"] = effective_plan

    for key, amount in usage.items():
        if key not in segment_traits:
            segment_traits[key] = amount

    return segment_traits


def build_targeting_state(
    context: JsonObject,
    playbook: JsonObject | None = None,
    usage_overrides: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Build the full targeting state from a user context snapshot.

    Derives effective_plan, merged traits, usage amounts, and the
    scalar-only segment-evaluation traits as one pure computation.
    ``plan_handle`` is a RESERVED trait key: always sourced from the
    first-class identity - a ``custom.plan_handle`` can never shadow or
    impersonate it (plan 191 REQ-2). So is every ``rt_*`` key: stamped only
    from ``builtin_dimensions`` and ``id``, and deleted when it arrives through
    ``custom``, ``entitlements`` or usage (plan 279 PD-1).

    Source: user-context.ts (buildTargetingState)
    """
    plan_identity = plan_identity_from_context(context)
    configured_plan_name = configured_plan_name_from_playbook(playbook, plan_identity)
    effective_plan = configured_plan_name or plan_identity

    custom = context.get("custom")
    traits: JsonObject = dict(custom) if is_record(custom) else {}

    entitlements = context.get("entitlements")
    if is_record(entitlements):
        for key, value in entitlements.items():
            if key not in traits:
                traits[key] = value

    # ``rt_*`` is a reserved trait-key PREFIX (plan 279 PD-1 - plan 191
    # REQ-2's ``plan_handle`` rule extended to a namespace): a custom or
    # entitlement ``rt_*`` key is DELETED, and the built-in dimension traits
    # are stamped from the first-class fields only.
    _strip_reserved_trait_keys(traits)
    traits.update(derive_builtin_dimension_traits(context))

    if plan_identity:
        traits["plan_handle"] = plan_identity
    else:
        traits.pop("plan_handle", None)
    if configured_plan_name and "plan_name" not in traits:
        traits["plan_name"] = configured_plan_name
    if effective_plan and "plan" not in traits:
        traits["plan"] = effective_plan

    usage_raw = context.get("usage")
    usage: dict[str, float] = {
        **usage_amounts_from_entries(usage_raw if is_record(usage_raw) else None),
        **(usage_overrides or {}),
    }
    # Usage never reaches a reserved key either (plan 279 PD-1).
    _strip_reserved_trait_keys(usage)

    for key, amount in usage.items():
        if key not in traits:
            traits[key] = amount

    state: dict[str, Any] = {
        "traits": traits,
        "usage": usage,
        "segment_traits": to_segment_evaluation_traits(traits, effective_plan, usage),
    }
    # JSON.stringify drops an undefined effectivePlan on the TS side, so the
    # key is OMITTED (never null) when there is no plan - byte parity.
    if effective_plan is not None:
        state["effective_plan"] = effective_plan
    return state
