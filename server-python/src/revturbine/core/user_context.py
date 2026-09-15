"""Python port of scaffold's ``user/controllers/user-context.ts``
targeting-state derivation (plan 234 TASK-8b).

Until this landed, segment parity was "agrees given the same traits" -
``evaluate_segments`` was byte-locked as a pure predicate, but the
derivation from a raw user context TO those traits existed only in the
TypeScript core and web SDK; this module (and its Rust twin) closes that to
"agrees given the same user context".
"""

from __future__ import annotations

from typing import Any

from revturbine.core.helpers import (
    JsonObject,
    configured_plan_name_from_exported_config,
    is_record,
    plan_identity_from_context,
    usage_amounts_from_entries,
)


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
    exported_config: JsonObject | None = None,
    usage_overrides: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Build the full targeting state from a user context snapshot.

    Derives effective_plan, merged traits, usage amounts, and the
    scalar-only segment-evaluation traits as one pure computation.
    ``plan_handle`` is a RESERVED trait key: always sourced from the
    first-class identity - a ``custom.plan_handle`` can never shadow or
    impersonate it (plan 191 REQ-2).

    Source: user-context.ts (buildTargetingState)
    """
    plan_identity = plan_identity_from_context(context)
    configured_plan_name = configured_plan_name_from_exported_config(exported_config, plan_identity)
    effective_plan = configured_plan_name or plan_identity

    custom = context.get("custom")
    traits: JsonObject = dict(custom) if is_record(custom) else {}

    entitlements = context.get("entitlements")
    if is_record(entitlements):
        for key, value in entitlements.items():
            if key not in traits:
                traits[key] = value

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
