"""Effective entitlements — Python port of
@revt-eng/entitlements/controllers/effective-entitlement.ts — the ONE answer
every SDK runtime uses (D-61, Kent 2026-10-06).

The shared evaluator (:func:`derive_local_entitlement_from_configured_rules`)
decides each entitlement from the Playbook + user context. An app may then
enrich that answer with its own data ("Entitlement Mirroring"): grants on
``UserContext.entitlements`` and/or an app-registered entitlement provider.
The two are merged with a configurable precedence — provider level
(``precedence``, default ``'app'``) with optional per-field overrides.

Browser and server SDKs run this same function on the same inputs: the
browser result shapes interaction, the server result verifies it.

An entitlement handle neither the Playbook nor the app knows is DENIED
(``entitlement_not_in_playbook``) and flagged ``unknown_handle``, so the
runtime can warn and report it.

Key-presence stands in for TS ``undefined`` throughout: an absent key is
``undefined``, a present ``None`` is ``null`` (which ``??`` still skips).

Source: revturbine-scaffold/src/entitlements/controllers/effective-entitlement.ts
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from collections.abc import Set as AbstractSet
from typing import Any, Literal, TypedDict, cast

from revturbine.core.decisions.types import EntitlementCheckResult
from revturbine.core.entitlements.entitlement_check import (
    derive_local_entitlement_from_configured_rules,
)
from revturbine.core.helpers import is_record

__all__ = [
    "AppEntitlementInputs",
    "EffectiveEntitlement",
    "EffectiveEntitlementBase",
    "EntitlementMergeField",
    "EntitlementMergeOptions",
    "EntitlementSource",
    "MirroredEntitlement",
    "ReverseTrialGrants",
    "ReverseTrialView",
    "app_entitlement",
    "derive_effective_entitlement",
    "derive_effective_entitlements",
    "merge_entitlement_results",
    "reverse_trial_grants",
]

Playbook = dict[str, Any]

#: Which side wins a merge: the app's own data, or the Playbook evaluation.
EntitlementSource = Literal["app", "playbook"]

#: Fields that can be given their own precedence. ``status`` carries
#: ``allowed`` and ``reason`` with it.
EntitlementMergeField = Literal["status", "limit", "used", "remaining"]


class EntitlementMergeOptions(TypedDict, total=False):
    """How app-supplied data merges with the Playbook evaluation."""

    #: Provider-level precedence. Default ``'app'``: app-supplied data wins.
    precedence: EntitlementSource
    #: Per-field overrides of ``precedence``.
    fields: dict[EntitlementMergeField, EntitlementSource]


#: A mirrored grant on ``UserContext.entitlements``: a boolean, or a
#: grant-shaped record (``status`` / ``allowed`` / ``limit`` / ``used`` /
#: ``remaining`` / ``reason``).
MirroredEntitlement = bool | Mapping[str, Any]


class AppEntitlementInputs(TypedDict, total=False):
    """The app's data for one entitlement handle."""

    #: ``UserContext.entitlements[handle]``.
    user_context: MirroredEntitlement
    #: The entry an app-registered entitlement provider supplied for the handle.
    provider: Mapping[str, Any]


class ReverseTrialView(TypedDict, total=False):
    """The trial facts reverse-trial grants depend on (``UserTrialStatus``
    subset)."""

    in_trial: bool
    trial_type: str
    #: The user's BASE plan while on a reverse trial.
    plan_handle: str


class ReverseTrialGrants(TypedDict, total=False):
    """The evaluator inputs :func:`reverse_trial_grants` derives."""

    trial_granted_entitlement_handles: AbstractSet[str]
    effective_plan_handle: str | None


class _EffectiveEntitlementBaseRequired(TypedDict):
    current_plan_handle: str
    segment_ids: AbstractSet[str]
    usage_balances: dict[str, float]


class EffectiveEntitlementBase(_EffectiveEntitlementBaseRequired, total=False):
    """Every :func:`derive_effective_entitlement` input except ``handle`` and
    ``app`` — what a runtime builds once and reuses per handle.

    Source: ``Omit<EffectiveEntitlementInput, 'handle' | 'app'>``
    """

    playbook: Playbook | None
    context: dict[str, Any] | None
    user_usage: dict[str, Any] | None
    trial_granted_entitlement_handles: AbstractSet[str] | None
    effective_plan_handle: str | None
    merge: EntitlementMergeOptions | None


class EffectiveEntitlement(TypedDict):
    """One handle's effective answer."""

    result: EntitlementCheckResult
    #: Neither the Playbook nor the app knows this handle (denied; warn + report).
    unknown_handle: bool


_STATUSES = frozenset({"allowed", "limited", "denied"})
_NUMERIC_FIELDS: tuple[EntitlementMergeField, ...] = ("limit", "used", "remaining")
_MISSING: Any = object()


def _finite(value: Any) -> float | int | None:
    """``typeof value === 'number' && Number.isFinite(value)`` — ``bool`` is
    not a JSON number, so it never counts."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def _from_mirrored(value: Any) -> dict[str, Any] | None:
    """Source: effective-entitlement.ts (fromMirrored)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return {"status": "allowed" if value else "denied", "allowed": value}
    if not is_record(value):
        return None
    raw_status = value.get("status")
    status = raw_status if isinstance(raw_status, str) and raw_status in _STATUSES else None
    out: dict[str, Any] = {}
    if status:
        out["status"] = status
        allowed = value.get("allowed")
        out["allowed"] = allowed if isinstance(allowed, bool) else status != "denied"
    limit = _finite(value.get("limit"))
    used = _finite(value.get("used"))
    remaining = _finite(value.get("remaining"))
    if remaining is None and limit is not None and used is not None:
        remaining = max(0, limit - used)
    if limit is not None:
        out["limit"] = limit
    if used is not None:
        out["used"] = used
    if remaining is not None:
        out["remaining"] = remaining
    reason = value.get("reason")
    if isinstance(reason, str):
        out["reason"] = reason
    return out if out else None


def app_entitlement(inputs: AppEntitlementInputs | None) -> dict[str, Any] | None:
    """The app's view of one entitlement. A provider entry is the app's live
    system, so its fields override a ``UserContext`` grant field by field.

    Source: effective-entitlement.ts (appEntitlement)
    """
    if inputs is None:
        return None
    from_user = _from_mirrored(inputs.get("user_context"))
    provider = inputs.get("provider")
    from_provider = _from_mirrored(provider) if provider else None
    if not from_user and not from_provider:
        return None
    return {**(from_user or {}), **(from_provider or {})}


def merge_entitlement_results(
    playbook: EntitlementCheckResult | None,
    app: Mapping[str, Any] | None,
    options: EntitlementMergeOptions | None = None,
) -> EntitlementCheckResult | None:
    """Merge the Playbook evaluation with the app's data. Each field comes
    from its configured winner when that side has it, else from the other
    side. ``status`` moves with ``allowed`` and ``reason``; an app-sourced
    status with no reason reports ``entitlement_mirrored``.

    Source: effective-entitlement.ts (mergeEntitlementResults)
    """
    if app is None:
        return playbook
    opts: EntitlementMergeOptions = options if options is not None else {}
    precedence_opt = opts.get("precedence")
    precedence: EntitlementSource = precedence_opt if precedence_opt is not None else "app"
    field_overrides = opts.get("fields")

    def winner(field: EntitlementMergeField) -> EntitlementSource:
        override = field_overrides.get(field) if field_overrides is not None else None
        return override if override is not None else precedence

    playbook_view: Mapping[str, Any] = playbook if playbook is not None else {}

    def source(field: EntitlementMergeField) -> EntitlementSource | None:
        """The first side, in the field's precedence order, that has it."""
        order: tuple[EntitlementSource, EntitlementSource] = (
            ("app", "playbook") if winner(field) == "app" else ("playbook", "app")
        )
        for side in order:
            if field in (app if side == "app" else playbook_view):
                return side
        return None

    def pick(field: EntitlementMergeField) -> Any:
        side = source(field)
        if side is None:
            return _MISSING
        return (app if side == "app" else playbook_view)[field]

    status_from_app = "status" in app and (winner("status") == "app" or playbook is None)
    base: dict[str, Any]
    if status_from_app:
        app_allowed = app.get("allowed")
        app_reason = app.get("reason")
        base = {
            "status": app["status"],
            "allowed": app_allowed if app_allowed is not None else app["status"] != "denied",
            "reason": app_reason if app_reason is not None else "entitlement_mirrored",
        }
    elif playbook is not None:
        base = dict(playbook)
    else:
        base = {"status": "denied", "allowed": False, "reason": "entitlement_not_in_playbook"}

    limit = pick("limit")
    used = pick("used")
    # Keep the numbers coherent: when `remaining` would come from a different
    # source than `limit` or `used`, derive it from the merged pair instead.
    remaining_source = source("remaining")
    mixed = remaining_source is not None and (
        (used is not _MISSING and source("used") != remaining_source)
        or (limit is not _MISSING and source("limit") != remaining_source)
    )
    remaining = (
        max(0, limit - used)
        if mixed and limit is not _MISSING and used is not _MISSING
        else pick("remaining")
    )

    out = dict(base)
    for field, value in zip(_NUMERIC_FIELDS, (limit, used, remaining), strict=True):
        if value is _MISSING:
            out.pop(field, None)
        else:
            out[field] = value
    if not status_from_app and playbook is not None and "rule_handle" in playbook:
        out["rule_handle"] = playbook["rule_handle"]
    return cast(EntitlementCheckResult, out)


def _js_truthy(value: Any) -> bool:
    """JS truthiness for the JSON value shapes a trial view carries — unlike
    Python, an empty array/object is truthy."""
    if isinstance(value, (list, dict)):
        return True
    if isinstance(value, float) and math.isnan(value):
        return False
    return bool(value)


def reverse_trial_grants(
    playbook: Playbook,
    trial: Mapping[str, Any] | None,
) -> ReverseTrialGrants:
    """Reverse-trial grants (plan 43): a user mid-reverse-trial holds the
    matching rule's ``entitlements_during_trial[]``, evaluated against the
    premium plan. Shared by every runtime so a server verifies exactly what
    the browser granted.

    Source: effective-entitlement.ts (reverseTrialGrants)
    """
    if (
        trial is None
        or not _js_truthy(trial.get("in_trial"))
        or trial.get("trial_type") != "reverse"
        or not _js_truthy(trial.get("plan_handle"))
    ):
        return {}
    plan_handle = trial.get("plan_handle")
    rule: dict[str, Any] | None = None
    for candidate in playbook.get("reverse_trial_rules") or []:
        if (
            is_record(candidate)
            and "fallback_plan_id" in candidate
            and candidate["fallback_plan_id"] == plan_handle
            and candidate.get("is_active") is not False
        ):
            rule = candidate
            break
    if rule is None:
        return {}
    during = rule.get("entitlements_during_trial")
    if not isinstance(during, list) or len(during) == 0:
        return {}
    premium = rule.get("premium_plan_id")
    return {
        "trial_granted_entitlement_handles": frozenset(h for h in during if isinstance(h, str)),
        "effective_plan_handle": premium if isinstance(premium, str) else None,
    }


def _playbook_knows(playbook: Playbook, handle: str) -> bool:
    return any(
        is_record(e) and e.get("unique_handle") == handle
        for e in playbook.get("entitlements") or []
    )


def _not_in_playbook() -> EntitlementCheckResult:
    return {"status": "denied", "allowed": False, "reason": "entitlement_not_in_playbook"}


def derive_effective_entitlement(
    *,
    handle: str,
    current_plan_handle: str,
    segment_ids: AbstractSet[str],
    usage_balances: dict[str, float],
    playbook: Playbook | None = None,
    context: dict[str, Any] | None = None,
    user_usage: dict[str, Any] | None = None,
    trial_granted_entitlement_handles: AbstractSet[str] | None = None,
    effective_plan_handle: str | None = None,
    app: AppEntitlementInputs | None = None,
    merge: EntitlementMergeOptions | None = None,
) -> EffectiveEntitlement:
    """The effective entitlement for one handle.

    Source: effective-entitlement.ts (deriveEffectiveEntitlement)
    """
    app_view = app_entitlement(app)
    known = _playbook_knows(playbook, handle) if playbook is not None else False
    if not known and app_view is None:
        return {"result": _not_in_playbook(), "unknown_handle": True}
    # App-mirrored usage is an INPUT to the Playbook evaluation (when `used`
    # follows the app), so the evaluated status reflects it — not a number
    # pasted on afterwards.
    merge_opts: EntitlementMergeOptions = merge if merge is not None else {}
    used_override = (merge_opts.get("fields") or {}).get("used")
    used_precedence = merge_opts.get("precedence")
    used_winner = (
        used_override
        if used_override is not None
        else used_precedence
        if used_precedence is not None
        else "app"
    )
    evaluation_balances = (
        {**usage_balances, handle: app_view["used"]}
        if app_view is not None and "used" in app_view and used_winner == "app"
        else usage_balances
    )
    evaluated = (
        derive_local_entitlement_from_configured_rules(
            handle=handle,
            context=context,
            current_plan_handle=current_plan_handle,
            segment_ids=set(segment_ids),
            usage_balances=evaluation_balances,
            user_usage=user_usage,
            playbook=playbook,
            trial_granted_entitlement_handles=trial_granted_entitlement_handles,
            effective_plan_handle=effective_plan_handle,
        )
        if known
        else None
    )
    merged = merge_entitlement_results(evaluated, app_view, merge)
    return {
        "result": merged if merged is not None else _not_in_playbook(),
        "unknown_handle": False,
    }


def derive_effective_entitlements(
    base: EffectiveEntitlementBase,
    app_by_handle: Mapping[str, AppEntitlementInputs],
) -> dict[str, EntitlementCheckResult]:
    """Effective entitlements for every handle the Playbook or the app knows —
    the map a runtime publishes to the placement resolver so gates read the
    same answer ``check_entitlement`` returns.

    Source: effective-entitlement.ts (deriveEffectiveEntitlements)
    """
    playbook = base.get("playbook")
    handles: dict[str, None] = {}
    for e in (playbook.get("entitlements") or []) if playbook is not None else []:
        unique_handle = e.get("unique_handle") if is_record(e) else None
        if isinstance(unique_handle, str):
            handles[unique_handle] = None
    for key in app_by_handle:
        handles[key] = None
    return {
        handle: derive_effective_entitlement(**base, handle=handle, app=app_by_handle.get(handle))[
            "result"
        ]
        for handle in handles
    }
