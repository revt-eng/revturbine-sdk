"""Python port of scaffold's ``entitlement-gate-gating.ts`` shared evaluation.

Byte-faithful port. Keep aligned with the TS when either side changes.

A tier-scoped ``entitlement_gate`` fires only when the user's current tier
ranks strictly BELOW the trigger's ``tier_threshold`` on the entitlement's
ordered ladder (placement-studio-ui.md §3.3: "one gate for users below Pro,
another for users below Enterprise"). The ladder is the authored
``tier_definitions`` (ARRAY ORDER = RANK); the current tier arrives on the
user context and is surfaced onto the entitlements provider state as ``tiers``.

Non-tier gates (no ``tier_threshold``) and non-gate triggers pass through.
Fail-closed (plan 138 Q-4): a missing ladder for the entitlement, or a
``tier_threshold`` that isn't on the ladder, means no defensible ordering, so
the gate does not fire.

Plan 138 TASK-4 (parity for the TS gate shipped in scaffold #165).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Literal, TypedDict


class EntitlementGateTriggerShape(TypedDict):
    kind: Literal["entitlement_gate"]
    entitlement_handle: str
    # ``None`` when the gate is not tier-scoped.
    tier_threshold: str | None


def matches_entitlement_gate_trigger(
    trigger: EntitlementGateTriggerShape | None,
    tier_ladders_by_handle: Mapping[str, Sequence[str]],
    entitlements: dict[str, Any] | None,
) -> bool:
    """Whether a tier-scoped ``entitlement_gate`` placement is eligible.

    Non-gate triggers (``None``) and gates with no ``tier_threshold`` pass
    through. Source: entitlement-gate-gating.ts matchesEntitlementGateTrigger.
    """
    if trigger is None:
        return True
    # A gate with no tier boundary is governed by entitlement status, not tier.
    tier_threshold = trigger.get("tier_threshold")
    if not tier_threshold:
        return True

    ladder = tier_ladders_by_handle.get(trigger["entitlement_handle"])
    if not ladder:
        return False  # Q-4: no ladder → fail closed

    ladder_list = list(ladder)
    if tier_threshold not in ladder_list:
        return False  # threshold not on the ladder → fail closed
    threshold_rank = ladder_list.index(tier_threshold)

    tiers = entitlements.get("tiers") if isinstance(entitlements, dict) else None
    current_tier = tiers.get(trigger["entitlement_handle"]) if isinstance(tiers, dict) else None
    # Absent or unrecognized current tier ranks below everything (rank -1) — a
    # user holding no tier is below every threshold, so the gate fires.
    current_rank = ladder_list.index(current_tier) if current_tier in ladder_list else -1

    # Fires when the current tier is strictly below the threshold tier.
    return current_rank < threshold_rank
