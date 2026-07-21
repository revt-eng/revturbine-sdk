"""Python port of scaffold's ``threshold-gating.ts`` shared evaluation.

Byte-faithful port. The TS file is the executable spec — every branch
mirrors a TS branch so cross-language parity stays a true equivalence
check rather than a re-derivation. Keep aligned with the TS when either
side changes.

Usage / credit / seat threshold triggers all gate on percent CONSUMED
(placement-studio-ui.md §3.4):

    usage_threshold   — usage_current / usage_limit * 100
    credit_threshold  — (allocation - balance) / allocation * 100
    seat_threshold    — seats_filled / seat_limit * 100

Credits pass the REMAINING balance, not the consumed amount; RT derives
the percentage. Percent is not clamped to 100 (the "Exceeded" direction).
Thresholds evaluate at the entitlement's Allocation level. Indeterminate
state fails closed.

Plan 138 TASK-3 (parity for the TS gate shipped in scaffold #157/#159).
"""

from __future__ import annotations

import math
from typing import Any, Literal, TypedDict

# ── ThresholdTriggerShape — discriminated union (kind-keyed) ────────────────


class ThresholdTriggerShape(TypedDict):
    kind: Literal["usage_threshold", "credit_threshold", "seat_threshold"]
    entitlement_handle: str
    threshold_percent: float


def _grant_for_allocation(handle: str, state: dict[str, Any]) -> dict[str, Any] | None:
    """Pick the grant whose counters the threshold is measured against, per
    the entitlement's Allocation (§3.4 "Pooling"). Source:
    threshold-gating.ts grantForAllocation.
    """
    grants = state.get("grants")
    if not isinstance(grants, dict):
        return None

    def _lvl(level: str) -> dict[str, Any] | None:
        lv = grants.get(level)
        entry = lv.get(handle) if isinstance(lv, dict) else None
        return entry if isinstance(entry, dict) else None

    declared = _lvl("user") or _lvl("instance") or _lvl("account")
    allocation = declared.get("allocation") if isinstance(declared, dict) else None
    if allocation in ("account_pool", "per_user_pooled"):
        return _lvl("account") or declared
    if allocation == "per_instance":
        return _lvl("instance") or declared
    if allocation == "per_user":
        return _lvl("user") or declared
    return declared


class _Counters(TypedDict, total=False):
    used: float
    limit: float
    remaining: float


def _resolve_counters(handle: str, state: dict[str, Any]) -> _Counters | None:
    """Allocation-scoped grant when one carries a limit, else the flat usage
    map. Source: threshold-gating.ts resolveCounters.
    """
    grant = _grant_for_allocation(handle, state)
    if (
        isinstance(grant, dict)
        and isinstance(grant.get("limit"), (int, float))
        and not isinstance(grant.get("limit"), bool)
    ):
        used = grant.get("used")
        return {
            "used": float(used)
            if isinstance(used, (int, float)) and not isinstance(used, bool)
            else 0.0,
            "limit": float(grant["limit"]),
        }

    usage = state.get("usage")
    entry = usage.get(handle) if isinstance(usage, dict) else None
    if (
        isinstance(entry, dict)
        and isinstance(entry.get("limit"), (int, float))
        and not isinstance(entry.get("limit"), bool)
    ):
        counters: _Counters = {"used": entry.get("used", 0.0), "limit": entry["limit"]}
        if isinstance(entry.get("remaining"), (int, float)) and not isinstance(
            entry.get("remaining"), bool
        ):
            counters["remaining"] = entry["remaining"]
        return counters

    return None


def compute_consumed_percent(
    trigger: ThresholdTriggerShape,
    entitlements: dict[str, Any] | None,
) -> float | None:
    """Percent of the allocation consumed, or ``None`` when it can't be
    determined (no state, no limit, non-positive limit). Not clamped.
    Source: threshold-gating.ts computeConsumedPercent.
    """
    if not isinstance(entitlements, dict):
        return None

    counters = _resolve_counters(trigger["entitlement_handle"], entitlements)
    if counters is None:
        return None
    limit = counters["limit"]
    if not math.isfinite(limit) or limit <= 0:
        return None

    remaining = counters.get("remaining")
    if (
        trigger["kind"] == "credit_threshold"
        and isinstance(remaining, (int, float))
        and not isinstance(remaining, bool)
    ):
        return ((limit - remaining) / limit) * 100

    used = counters["used"]
    if not (isinstance(used, (int, float)) and not isinstance(used, bool) and math.isfinite(used)):
        return None
    return (used / limit) * 100


def matches_threshold_trigger(
    trigger: ThresholdTriggerShape | None,
    entitlements: dict[str, Any] | None,
) -> bool:
    """Non-threshold triggers (``None``) pass through. Fires when consumed
    percent is at or above the configured threshold; fails closed when
    consumption can't be determined. Source:
    threshold-gating.ts matchesThresholdTrigger.
    """
    if trigger is None:
        return True
    consumed = compute_consumed_percent(trigger, entitlements)
    if consumed is None:
        return False
    return consumed >= trigger["threshold_percent"]
