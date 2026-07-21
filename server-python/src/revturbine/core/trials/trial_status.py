"""Python port of scaffold's ``trial-status.ts`` shared derivation.

Byte-faithful port of ``revturbine-scaffold/src/trials/controllers/
trial-status.ts``. The TS file is the executable spec — every branch
mirrors a TS branch so cross-language parity stays a true equivalence
check rather than a re-derivation. Keep the function bodies aligned with
the TS when either side changes.

Translates the persisted trial schemas (``TrialInstance`` +
``FreeTrialRule`` / ``ReverseTrialRule``) into the transient runtime
shape (``UserTrialStatus``) the SDK consumes, and — via
:func:`evaluate_trial_status` — resolves an instance's matching rule
straight from a Playbook's ``free_trial_rules`` / ``reverse_trial_rules``
arrays.

All functions are pure and deterministic (the caller supplies
``now_iso``); they never read the wall clock, so server + SDK derive the
same result for the same instant. Instances and rules are plain
``Mapping`` (dict) records per the port convention — the config-view
trial-rule items are opaque (``RootModel[Any]``) on the Python side.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

# One day in milliseconds. Trials are measured in whole days.
# Source: trial-status.ts MS_PER_DAY.
_MS_PER_DAY = 24 * 60 * 60 * 1000

# When 25% or less of the trial remains (by universal progress percent),
# the runtime state surfaces as 'running_out'.
# Source: trial-status.ts RUNNING_OUT_PERCENT_THRESHOLD.
_RUNNING_OUT_PERCENT_THRESHOLD = 75


def _date_parse_ms(iso: Any) -> float:
    """Mirror JS ``Date.parse(iso)`` — ms since epoch, or ``nan`` when
    unparseable (the TS branches on ``Number.isNaN``).

    Tolerates the trailing ``Z`` form (``datetime.fromisoformat`` didn't
    accept ``Z`` before 3.11). Inputs are tz-aware ISO datetimes.
    """
    if not isinstance(iso, str):
        return math.nan
    try:
        normalized = iso.replace("Z", "+00:00") if iso.endswith("Z") else iso
        return datetime.fromisoformat(normalized).timestamp() * 1000
    except (TypeError, ValueError):
        return math.nan


def _js_math_round(value: float) -> int:
    """JS ``Math.round`` — round half toward +Infinity.

    ``math.floor(x + 0.5)`` reproduces this for every finite input;
    Python's built-in ``round`` is banker's rounding and would diverge on
    ``.5`` ties. Source: trial-status.ts uses ``Math.round``.
    """
    return math.floor(value + 0.5)


def _effective_status(persisted_status: Any, is_expired_by_bounds: bool) -> Any:
    """Lazy expiry: surface an active-but-bounds-crossed trial as
    ``expired`` at read time. Source: trial-status.ts effectiveStatus.
    """
    if persisted_status == "converted" or persisted_status == "cancelled":
        return persisted_status
    if is_expired_by_bounds and persisted_status == "active":
        return "expired"
    return persisted_status


def _map_state_for_runtime(status: Any, progress_percent: float) -> str:
    """Persisted ``TrialInstance.status`` → transient
    ``UserTrialStatus.state``. Source: trial-status.ts mapStateForRuntime.
    """
    if status == "expired":
        return "expired"
    if status == "converted":
        return "converted"
    if status == "cancelled":
        return "expired"
    if status == "not_started":
        return "none"
    # status == "active"
    if progress_percent >= _RUNNING_OUT_PERCENT_THRESHOLD:
        return "running_out"
    return "active"


def _derive_time_based(started_at_ms: float, expires_at_ms: float, now_ms: float) -> dict[str, Any]:
    """Source: trial-status.ts deriveTimeBased."""
    total_ms = max(0.0, expires_at_ms - started_at_ms)
    elapsed_ms = max(0.0, now_ms - started_at_ms)
    remaining_ms = max(0.0, expires_at_ms - now_ms)
    days_total = max(1, _js_math_round(total_ms / _MS_PER_DAY))
    day_number = min(days_total, math.floor(elapsed_ms / _MS_PER_DAY))
    days_remaining = max(0, math.ceil(remaining_ms / _MS_PER_DAY))
    progress_percent = min(100.0, max(0.0, (elapsed_ms / max(1.0, total_ms)) * 100.0))
    return {
        "is_expired_by_bounds": now_ms >= expires_at_ms,
        "day_number": day_number,
        "days_remaining": days_remaining,
        "days_total": days_total,
        "progress_percent": progress_percent,
    }


def _derive_usage_based(consumed: float, limit: float) -> dict[str, Any]:
    """Source: trial-status.ts deriveUsageBased."""
    safe_limit = max(1, limit)
    safe_consumed = max(0, consumed)
    remaining = max(0, safe_limit - safe_consumed)
    progress_percent = min(100.0, max(0.0, (safe_consumed / safe_limit) * 100.0))
    return {
        "is_expired_by_bounds": safe_consumed >= safe_limit,
        "usage_consumed": safe_consumed,
        "usage_remaining": remaining,
        "usage_limit": safe_limit,
        "progress_percent": progress_percent,
    }


def derive_local_trial_status_from_instance(
    *,
    instance: Mapping[str, Any],
    rule: Mapping[str, Any] | None = None,
    now_iso: str,
    base_plan_handle: str | None = None,
    usage_balances: Mapping[str, float] | None = None,
) -> dict[str, Any] | None:
    """Derive the runtime ``UserTrialStatus`` from a persisted trial
    instance + matching rule + current time.

    Returns ``None`` when the instance is not yet started, its persisted
    status is ``not_started``, or a usage-based trial is missing its
    limit snapshot. Source: trial-status.ts deriveLocalTrialStatusFromInstance.
    """
    started_at_ms = _date_parse_ms(instance.get("started_at"))
    now_ms = _date_parse_ms(now_iso)
    if math.isnan(started_at_ms) or math.isnan(now_ms):
        return None

    status = instance.get("status")
    if status == "not_started" or now_ms < started_at_ms:
        return None

    limit_type = instance.get("trial_limit_type") or "time"

    progress_percent = 0.0
    is_expired_by_bounds = False
    day_number: int | None = None
    days_remaining: int | None = None
    usage_consumed: float | None = None
    usage_remaining: float | None = None
    usage_limit: float | None = None
    usage_entitlement_handle: str | None = None

    if limit_type == "usage":
        handle = instance.get("usage_entitlement_handle")
        if handle is None and rule is not None:
            handle = rule.get("usage_entitlement_handle")
        limit = instance.get("usage_limit_value")
        if limit is None and rule is not None:
            limit = rule.get("usage_limit_value")
        if (
            not isinstance(handle, str)
            or isinstance(limit, bool)
            or not isinstance(limit, (int, float))
            or limit < 1
        ):
            # Usage-based trial missing its bounds — treat as malformed.
            return None
        consumed = (usage_balances or {}).get(handle, 0)
        u = _derive_usage_based(consumed, limit)
        progress_percent = u["progress_percent"]
        is_expired_by_bounds = u["is_expired_by_bounds"]
        usage_consumed = u["usage_consumed"]
        usage_remaining = u["usage_remaining"]
        usage_limit = u["usage_limit"]
        usage_entitlement_handle = handle
    else:
        # 'time' mode (default) — requires an expires_at bound.
        expires = instance.get("expires_at")
        expires_at_ms = _date_parse_ms(expires) if expires else math.nan
        if math.isnan(expires_at_ms):
            return None
        t = _derive_time_based(started_at_ms, expires_at_ms, now_ms)
        progress_percent = t["progress_percent"]
        is_expired_by_bounds = t["is_expired_by_bounds"]
        day_number = t["day_number"]
        days_remaining = t["days_remaining"]

    resolved_status = _effective_status(status, is_expired_by_bounds)
    state = _map_state_for_runtime(resolved_status, progress_percent)

    plan_handle: str | None = None
    rule_type = instance.get("rule_type")
    if rule_type == "reverse_trial":
        plan_handle = base_plan_handle
    elif rule_type == "free_trial" and rule is not None and isinstance(rule.get("plan_id"), str):
        plan_handle = rule.get("plan_id")

    trial_type = "reverse" if rule_type == "reverse_trial" else "free"

    result: dict[str, Any] = {
        "in_trial": resolved_status == "active",
        "trial_type": trial_type,
        "state": state,
        "trial_limit_type": limit_type,
        "progress_percent": progress_percent,
    }
    if plan_handle is not None:
        result["plan_handle"] = plan_handle
    if day_number is not None:
        result["day_number"] = day_number
    if days_remaining is not None:
        result["days_remaining"] = days_remaining
    if usage_entitlement_handle is not None:
        result["usage_entitlement_handle"] = usage_entitlement_handle
    if usage_consumed is not None:
        result["usage_consumed"] = usage_consumed
    if usage_remaining is not None:
        result["usage_remaining"] = usage_remaining
    if usage_limit is not None:
        result["usage_limit"] = usage_limit
    return result


def find_active_trial_instance(
    instances: Sequence[Mapping[str, Any]],
    now_iso: str,
    usage_balances: Mapping[str, float] | None = None,
) -> Mapping[str, Any] | None:
    """Latest-started instance whose derived status is ``active`` or
    ``converted`` (expired/cancelled skipped). Source:
    trial-status.ts findActiveTrialInstance.
    """
    now_ms = _date_parse_ms(now_iso)
    if math.isnan(now_ms):
        return None

    best: Mapping[str, Any] | None = None
    best_started_at = float("-inf")
    for inst in instances:
        started_at_ms = _date_parse_ms(inst.get("started_at"))
        if math.isnan(started_at_ms):
            continue
        if now_ms < started_at_ms:
            continue

        is_expired_by_bounds = False
        if (inst.get("trial_limit_type") or "time") == "usage":
            handle = inst.get("usage_entitlement_handle")
            limit = inst.get("usage_limit_value")
            if (
                usage_balances is not None
                and isinstance(handle, str)
                and not isinstance(limit, bool)
                and isinstance(limit, (int, float))
            ):
                consumed = usage_balances.get(handle, 0)
                is_expired_by_bounds = consumed >= limit
        else:
            expires = inst.get("expires_at")
            if expires:
                expires_at_ms = _date_parse_ms(expires)
                if not math.isnan(expires_at_ms):
                    is_expired_by_bounds = now_ms >= expires_at_ms

        resolved = _effective_status(inst.get("status"), is_expired_by_bounds)
        if resolved != "active" and resolved != "converted":
            continue
        if started_at_ms > best_started_at:
            best = inst
            best_started_at = started_at_ms
    return best


def find_latest_started_trial_instance(
    instances: Sequence[Mapping[str, Any]],
    now_iso: str,
) -> Mapping[str, Any] | None:
    """Latest-started row (already started by ``now_iso``) whose status is
    ``active`` / ``expired`` / ``converted`` — KEEPS expired + converted
    rows so ``trial_ended`` / ``trial_converted`` placements can fire,
    unlike :func:`find_active_trial_instance`. ``not_started`` /
    ``cancelled`` and future-dated rows are dropped. Source:
    trial-status.ts findLatestStartedTrialInstance.
    """
    now_ms = _date_parse_ms(now_iso)
    if math.isnan(now_ms):
        return None

    best: Mapping[str, Any] | None = None
    best_started_at = float("-inf")
    for inst in instances:
        status = inst.get("status")
        if status != "active" and status != "expired" and status != "converted":
            continue
        started_at_ms = _date_parse_ms(inst.get("started_at"))
        if math.isnan(started_at_ms):
            continue
        if now_ms < started_at_ms:
            continue
        if started_at_ms > best_started_at:
            best = inst
            best_started_at = started_at_ms
    return best


def derive_reverse_trial_grants(
    instance: Mapping[str, Any],
    rule: Mapping[str, Any],
) -> dict[str, Any] | None:
    """Entitlement-grant inputs for an active reverse trial (plan 43
    TASK-2). ``None`` unless the instance is a reverse trial referencing
    ``rule`` whose ``entitlements_during_trial`` is non-empty. Source:
    trial-status.ts deriveReverseTrialGrants.
    """
    if instance.get("rule_type") != "reverse_trial":
        return None
    if instance.get("rule_id") != rule.get("id"):
        return None
    handles = rule.get("entitlements_during_trial")
    if not handles:
        return None
    return {
        "trial_granted_entitlement_handles": set(handles),
        "effective_plan_handle": rule.get("premium_plan_id"),
    }


def _find_rule_by_id(
    rules: Sequence[Mapping[str, Any]] | None, rule_id: Any
) -> Mapping[str, Any] | None:
    for rule in rules or []:
        if rule.get("id") == rule_id:
            return rule
    return None


def evaluate_trial_status(
    *,
    instances: Sequence[Mapping[str, Any]],
    now_iso: str,
    free_trial_rules: Sequence[Mapping[str, Any]] | None = None,
    reverse_trial_rules: Sequence[Mapping[str, Any]] | None = None,
    usage_balances: Mapping[str, float] | None = None,
    base_plan_handle: str | None = None,
) -> dict[str, Any]:
    """Evaluate a Playbook's ``free_trial_rules`` / ``reverse_trial_rules``
    against a customer's trial instances → the runtime ``UserTrialStatus``.

    The config-driven counterpart of
    :func:`derive_local_trial_status_from_instance`: it resolves the
    matching rule *from the config arrays* (by ``instance.rule_id`` +
    ``instance.rule_type``) instead of requiring the caller to supply it.
    Composes :func:`find_latest_started_trial_instance` →
    :func:`derive_local_trial_status_from_instance` →
    (reverse) :func:`derive_reverse_trial_grants`.

    Returns ``{"trial": None, "reverse_grants": None}`` when no active
    trial instance applies. Source: trial-status.ts evaluateTrialStatus.
    """
    instance = find_latest_started_trial_instance(instances, now_iso)
    if instance is None:
        return {"trial": None, "reverse_grants": None}

    if instance.get("rule_type") == "reverse_trial":
        rule = _find_rule_by_id(reverse_trial_rules, instance.get("rule_id"))
        trial = derive_local_trial_status_from_instance(
            instance=instance,
            rule=rule,
            now_iso=now_iso,
            base_plan_handle=base_plan_handle,
            usage_balances=usage_balances,
        )
        reverse_grants = derive_reverse_trial_grants(instance, rule) if rule is not None else None
        return {"trial": trial, "reverse_grants": reverse_grants}

    # free_trial (the only other rule_type)
    rule = _find_rule_by_id(free_trial_rules, instance.get("rule_id"))
    trial = derive_local_trial_status_from_instance(
        instance=instance,
        rule=rule,
        now_iso=now_iso,
        base_plan_handle=base_plan_handle,
        usage_balances=usage_balances,
    )
    return {"trial": trial, "reverse_grants": None}
