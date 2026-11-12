"""Entitlement check lifecycle — Python port of
@revt-eng/entitlements/controllers/entitlement-check.ts
(plan-32/34-reconciled).

``derive_local_entitlement_from_configured_rules`` is the
Playbook-rule fallback wired into
``LocalRuntime._derive_entitlement_from_config`` (plan 33 TASK-6 leaf,
faithful to TS local-runtime.ts:355-369). It does its **own** inline
rule filtering, takes the maximum ordinary grant, and adds the maximum
grant per purchased holding. The provider-snapshot selector follows the
same policy; both shapes are ported because plan 33 TASK-13 names both.

Sync per Q-5. Playbook / rule items stay loosely typed
(``dict[str, Any]``) per the port convention; the parity suite is the
drift backstop.

Source: revturbine-scaffold/src/entitlements/controllers/entitlement-check.ts
"""

from __future__ import annotations

import logging
import math
import sys
import warnings
from collections.abc import Callable, Mapping
from collections.abc import Set as AbstractSet
from typing import Any

from revturbine.core.decisions.types import EntitlementCheckResult, EntitlementDiagnostic
from revturbine.core.entitlements.purchased_allowance import (
    aggregate_purchased_allowance,
    validate_purchased_addons,
)
from revturbine.core.entitlements.rules import (
    pick_most_permissive,
    rule_permissiveness,
)
from revturbine.core.entitlements.segment_matching import matches_rule_segments
from revturbine.core.entitlements.unlimited import resolve_limit_value
from revturbine.core.helpers import is_record
from revturbine.core.segments.segment_mode import segment_dimension_keys

__all__ = ["derive_local_entitlement_from_configured_rules"]

Playbook = dict[str, Any]


def _js_number(v: Any) -> float:
    """Mirror JS ``Number(v)`` for the value shapes ``type_fields`` carry
    (number / numeric string / bool / absent). Absent field reaches here
    as ``None`` (Python) standing in for TS ``undefined`` →
    ``Number(undefined)`` is ``NaN``, so ``None -> nan`` keeps the
    "missing limit ⇒ not finite ⇒ unlimited" branch parity-correct.
    ``""`` → 0 (JS), unparseable → NaN.

    Source: the ``Number(...)`` coercions in entitlement-check.ts:178-191.
    """
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if v is None:
        return math.nan
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return 0.0
        try:
            return float(s)
        except ValueError:
            return math.nan
    return math.nan


def _apply_usage_enforcement(
    over: bool,
    enforcement: Any,
    base_reason: str,
) -> EntitlementCheckResult:
    """Apply a rule's ``enforcement`` mode when a usage / credit limit is
    reached (plan 34 REQ-3). Under the limit always allowed.

    Source: entitlement-check.ts:50-68 (applyUsageEnforcement)
    """
    if not over:
        return {"status": "allowed", "allowed": True}
    if enforcement == "hard_block":
        return {"status": "denied", "allowed": False, "reason": base_reason}
    # `soft_block` is the pre-v15 spelling of `block_with_upsell` (plan 194
    # TASK-8). Accepting it keeps a v13/v14 payload denying rather than falling
    # to the unset-enforcement default; both spellings report the new reason.
    if enforcement in ("block_with_upsell", "soft_block"):
        return {
            "status": "denied",
            "allowed": False,
            "reason": f"{base_reason}_block_with_upsell",
        }
    if enforcement == "degrade":
        return {
            "status": "limited",
            "allowed": True,
            "reason": f"{base_reason}_degraded",
        }
    if enforcement == "allow_overage":
        return {
            "status": "allowed",
            "allowed": True,
            "reason": f"{base_reason}_overage",
        }
    return {"status": "limited", "allowed": False, "reason": base_reason}


def derive_local_entitlement_from_configured_rules(
    *,
    handle: str,
    context: dict[str, Any] | None = None,
    current_plan_handle: str,
    segment_ids: set[str],
    usage_balances: dict[str, float],
    user_usage: dict[str, Any] | None = None,
    playbook: Playbook | None = None,
    trial_granted_entitlement_handles: AbstractSet[str] | None = None,
    effective_plan_handle: str | None = None,
    addons: list[dict[str, Any]] | None = None,
    billing_period: str | None = None,
    diagnostics: bool = False,
    app_numbers: Mapping[str, Any] | None = None,
    cost_trace: dict[str, bool] | None = None,
) -> EntitlementCheckResult | None:
    """Derive an entitlement result locally from Playbook rules.

    ``app_numbers`` (ST-1741, ``limit`` / ``used`` / ``remaining`` and
    ``remaining_derived``) are the numbers the app reported on its mirrored
    entitlement that the cost rule may compare against, already filtered to the
    fields that follow the app; ``cost_trace`` is an out-parameter the
    evaluation fills (``applied`` / ``over`` / ``app_numbers``) when a cost > 0
    comparison ran. Both are set by the effective-entitlement merge.

    ``diagnostics`` attaches the developer ``diagnostic`` (ST-1696 cost rule)
    to the result. It is set by the single-handle check paths (``can()`` /
    ``check_entitlement()``) and left unset when every entitlement is
    evaluated at once, so a bulk evaluation never reports a missing cost for
    calls nobody made. The cost RULE applies either way.

    ``trial_granted_entitlement_handles`` / ``effective_plan_handle`` are the
    reverse-trial inputs (plan 43 TASK-2): a handle the user holds through an
    active reverse trial is matched against the GRANTED plan's rules, or —
    when no effective plan is supplied — short-circuits to
    ``granted_by_reverse_trial``. Absent or empty, the pre-trial behaviour
    applies. Build them with
    :func:`revturbine.core.entitlements.effective_entitlement.reverse_trial_grants`.

    Returns ``None`` when no config is available; an explicit result
    otherwise (including ``no_matching_entitlement_rule`` ⇒ denied,
    fail closed).

    Source: entitlement-check.ts:77-211
    (deriveLocalEntitlementFromConfiguredRules)
    """
    if playbook is None:
        return None
    holdings = [
        holding
        for holding in validate_purchased_addons(addons)
        if holding["quantity"] > 0
        and any(
            a.get("unique_handle") == holding["addon_handle"] for a in playbook.get("addons") or []
        )
        and (
            "addon_variation_handle" not in holding
            or any(
                v.get("handle") == holding["addon_variation_handle"]
                and v.get("addon_handle") == holding["addon_handle"]
                for v in playbook.get("addon_variations") or []
            )
        )
    ]
    entitlements: list[dict[str, Any]] = playbook.get("entitlements") or []
    # Plan 120 TASK-4 / plan 191 REQ-1: the config carries only the handle, so
    # entitlements resolve by handle alone. The `id` fallback this port used to
    # carry was a pre-plan-120 mirror that TS dropped; because the ids in the
    # corpus (`ent_core_credits`) differ from the handles the rules reference
    # (`core_credits`), it made every rule miss and every check deny.
    entitlement: dict[str, Any] | None = None
    for item in entitlements:
        if isinstance(item.get("unique_handle"), str) and item["unique_handle"] == handle:
            entitlement = item
            break

    entitlement_id = (
        entitlement["unique_handle"]
        if entitlement is not None and isinstance(entitlement.get("unique_handle"), str)
        else handle
    )

    # Reverse-trial grant resolution (plan 43 TASK-2 + gap-1 follow-up). A
    # handle in ``trial_granted_entitlement_handles`` is held mid-trial: with
    # an ``effective_plan_handle`` the GRANTED plan's rules apply (so its
    # limits enforce); without one the v1 backstop grants outright.
    # Mirrors entitlement-check.ts.
    unique_handle = (
        entitlement["unique_handle"]
        if entitlement is not None and isinstance(entitlement.get("unique_handle"), str)
        else None
    )
    handle_is_trial_granted = bool(
        trial_granted_entitlement_handles
        and len(trial_granted_entitlement_handles) > 0
        and (
            handle in trial_granted_entitlement_handles
            or entitlement_id in trial_granted_entitlement_handles
            or (unique_handle is not None and unique_handle in trial_granted_entitlement_handles)
        )
    )
    if handle_is_trial_granted and (effective_plan_handle is None or effective_plan_handle == ""):
        return {"status": "allowed", "allowed": True, "reason": "granted_by_reverse_trial"}

    # Plan-matching key: trial-granted entitlements use the GRANTED plan
    # (limits apply); everything else uses the user's base plan.
    plan_handle_for_matching = (
        effective_plan_handle
        if handle_is_trial_granted and effective_plan_handle
        else current_plan_handle
    )
    # Trimmed, so a whitespace-only handle collapses to "no identity" rather
    # than becoming an identity that matches no plan. Both fail closed, but
    # only the collapsed form reports the actual cause (plan 194 REQ-1).
    normalized_plan_handle = str(plan_handle_for_matching or "").strip().lower()

    plans: list[dict[str, Any]] = playbook.get("plans") or []
    # Plan 191 REQ-1: plan identity IS the handle. `plans[].id` is DB-internal
    # and never participates in matching — a context whose only plan signal is
    # that id must miss every plan-targeted rule.
    matched_plan: dict[str, Any] | None = None
    for plan in plans:
        if (
            isinstance(plan.get("unique_handle"), str)
            and plan["unique_handle"].lower() == normalized_plan_handle
        ):
            matched_plan = plan
            break

    # The handle the user's current plan is known by — plan targets are
    # handle-valued, so this is what a `kind:'plan'` target matches against.
    current_plan_handle_ref: str | None = (
        matched_plan["unique_handle"]
        if matched_plan is not None and isinstance(matched_plan.get("unique_handle"), str)
        else (normalized_plan_handle or None)
    )

    # Plan 194 REQ-1. Without a plan identity there is nothing to match plan
    # targets against, and the rule filter below used to SKIP the plan check
    # rather than fail it — so every plan-targeted rule matched and a
    # plan-gated entitlement came back ``allowed`` for a user with no plan.
    # Entitlement-rule targeting has been explicit since plan 34 REQ-9 (an
    # empty ``targets`` matches nothing), so "no identity" can only ever mean
    # "matches nothing", never "matches everything". The reason is distinct
    # from ``no_matching_entitlement_rule`` on purpose: "we could not identify
    # the user's plan" is a broken integration, "their plan lacks this" is a
    # correctly-gated user, and telemetry has to tell them apart.
    if current_plan_handle_ref is None and not holdings:
        return {
            "status": "denied",
            "allowed": False,
            "reason": "no_plan_identity",
        }

    rules: list[dict[str, Any]] = playbook.get("entitlement_rules") or []
    baseline_rules: list[dict[str, Any]] = []
    purchased_rules: list[list[dict[str, Any]]] = [[] for _ in holdings]

    # Plan #39 REQ-28: build the segment_id → dimension_id lookup once per
    # call so the dimensional matcher can group rule segments. Segments
    # missing a dimension fall into `__no_dim__` inside the helper,
    # preserving flat-OR back-compat for pre-PR-B exports.
    # Plan 234 TASK-2: keyed by HANDLE, matching the TS canonical. Rule
    # `segment_ids` are handle-valued (plan 120 TASK-4); keying this map by
    # `id` made every lookup miss on any export whose ids differ from its
    # handles, collapsing all rule segments into `__no_dim__` and degrading
    # cross-dimension AND to flat OR (a grant where TS denies).
    # ST-1391: the dimension is DERIVED from the segment's predicates
    # (classify_segment); a stored `dimension_id` only applies to multi-field
    # and advanced segments, so the BUG-1389 upload placeholder cannot decide.
    segment_dimensions: dict[str, str] = segment_dimension_keys(playbook.get("segments"))

    def _matches(rule: dict[str, Any]) -> bool:
        rule_ent_id = (
            rule["entitlement_id"]
            if isinstance(rule.get("entitlement_id"), str)
            else rule["entitlementId"]
            if isinstance(rule.get("entitlementId"), str)
            else ""
        )
        if rule_ent_id != entitlement_id:
            return False

        # Plan targeting derives from kind:'plan' targets; legacy
        # plan_ids/planIds tolerated. Empty ⇒ matches NOTHING (plan 34
        # REQ-9; targeting is always explicit).
        targets = rule.get("targets")
        if isinstance(targets, list):
            plan_ids = [
                t["id"]
                for t in targets
                if is_record(t) and t.get("kind") == "plan" and isinstance(t.get("id"), str)
            ]
        elif isinstance(rule.get("plan_ids"), list):
            plan_ids = [pid for pid in rule["plan_ids"] if isinstance(pid, str)]
        elif isinstance(rule.get("planIds"), list):
            plan_ids = [pid for pid in rule["planIds"] if isinstance(pid, str)]
        else:
            plan_ids = []

        # Plan 120 TASK-4: plan targets are handle-valued — match the user's
        # current plan HANDLE against the rule's listed plan handles. The
        # ``None`` identity case returned above (plan 194 REQ-1), so this is an
        # unconditional match now rather than a skippable one.
        matches_baseline = current_plan_handle_ref is not None and (
            current_plan_handle_ref in plan_ids
            or any(
                t.get("kind") == "plan_variation"
                and any(
                    v.get("handle") == t.get("id")
                    and v.get("plan_handle") == current_plan_handle_ref
                    and v.get("billing_period") == billing_period
                    and (not v.get("segment_handle") or v["segment_handle"] in segment_ids)
                    for v in playbook.get("plan_variations") or []
                )
                for t in (targets if isinstance(targets, list) else [])
            )
        )
        purchased_indexes = [
            index
            for index, holding in enumerate(holdings)
            if any(
                (t.get("kind") == "addon" and t.get("id") == holding["addon_handle"])
                or (
                    t.get("kind") == "addon_variation"
                    and t.get("id") == holding.get("addon_variation_handle")
                )
                for t in (targets if isinstance(targets, list) else [])
            )
        ]
        if not matches_baseline and not purchased_indexes:
            return False

        # Plan #39 REQ-8: dimensional matching — intra-dimension OR +
        # cross-dimension AND, with `__no_dim__` flat-OR fallback for
        # segments that haven't been categorised yet.
        rule_segment_ids = rule.get("segment_ids")
        if not isinstance(rule_segment_ids, list):
            rule_segment_ids = rule.get("segmentIds")
        if not matches_rule_segments(
            rule_segment_ids if isinstance(rule_segment_ids, list) else None,
            segment_ids,
            segment_dimensions,
        ):
            return False
        if matches_baseline:
            baseline_rules.append(rule)
        for index in purchased_indexes:
            purchased_rules[index].append(rule)
        return True

    matching_rules = [r for r in rules if _matches(r)]

    # No rule grants this entitlement to the user's plan. Plan #39 made plan
    # targeting explicit (an empty plan_ids no longer implies "all plans"), so
    # the absence of a matching rule means the entitlement is NOT granted —
    # deny (fail closed). Mirrors entitlement-check.ts.
    if len(matching_rules) == 0:
        return {
            "status": "denied",
            "allowed": False,
            "reason": "no_matching_entitlement_rule",
        }

    # Plan 147 (OQ-6): the wire is flat — the rule IS the type-fields bag, and
    # `kind` is derived from the parent entitlement's type (the deleted
    # `type_fields.kind` no longer carries it). A legacy nested `type_fields` /
    # camel `typeFields` bag is tolerated for the migration window, merged under
    # the flat fields (flat wins). Mirrors entitlement-check.ts.
    _entitlement_type_by_handle: dict[str, str] = {}
    for _e in entitlements:
        if (
            is_record(_e)
            and isinstance(_e.get("unique_handle"), str)
            and isinstance(_e.get("type"), str)
        ):
            _entitlement_type_by_handle[_e["unique_handle"]] = _e["type"]

    def _type_fields_of(r: dict[str, Any]) -> dict[str, Any]:
        flat = r if is_record(r) else {}
        nested = flat.get("type_fields")
        if not is_record(nested):
            nested = flat.get("typeFields")
        if not is_record(nested):
            nested = {}
        merged: dict[str, Any] = {**nested, **flat}
        if not isinstance(merged.get("kind"), str):
            ent_id = flat.get("entitlement_id")
            derived = _entitlement_type_by_handle.get(ent_id) if isinstance(ent_id, str) else None
            if derived:
                merged["kind"] = derived
        return merged

    # §2.6.5 (plan 34 REQ-1): when multiple rules match, the MOST
    # PERMISSIVE wins — NOT array order. Reuses the single-sourced
    # scorer + tie-break from rules.py, so this is identical to
    # find_matching_entitlement_rule and the §2.6.5 rule is never
    # implemented twice (mirrors the TS deriveLocalEntitlement edit).
    # matching_rules is non-empty here (early return above).
    def _score(r: dict[str, Any]) -> float:
        tf = _type_fields_of(r)
        return rule_permissiveness(
            {
                "kind": tf["kind"] if isinstance(tf.get("kind"), str) else "",
                "fields": tf,
            }
        )

    chosen = pick_most_permissive(matching_rules, _score)
    selected_rule = chosen if chosen is not None else matching_rules[0]
    effective_allowance = None
    contributing_handles = None
    if holdings and _type_fields_of(selected_rule).get("kind") in (
        "seat",
        "credits",
        "usage_limit",
        "limit",
    ):

        def as_allowance(rule: dict[str, Any]) -> dict[str, Any]:
            fields = _type_fields_of(rule)
            return {
                "ruleId": rule.get("id"),
                "kind": fields.get("kind", ""),
                "fields": fields,
                "source": rule,
            }

        purchases = []
        for index, holding in enumerate(holdings):
            eligible = [
                r
                for r in purchased_rules[index]
                if _type_fields_of(r).get("kind") != "credits"
                or "reset_period" in _type_fields_of(r)
            ]
            rule = pick_most_permissive(eligible, _score)
            variation = next(
                (
                    v
                    for v in playbook.get("addon_variations") or []
                    if v.get("handle") == holding.get("addon_variation_handle")
                ),
                None,
            )
            if rule is not None:
                purchases.append(
                    {
                        "rule": as_allowance(rule),
                        "quantity": holding["quantity"],
                        "billingPeriod": variation.get("billing_period") if variation else None,
                    }
                )
        baseline = pick_most_permissive(
            [
                r
                for r in baseline_rules
                if not purchases
                or _type_fields_of(r).get("kind") != "credits"
                or "reset_period" in _type_fields_of(r)
            ],
            _score,
        )
        aggregate = aggregate_purchased_allowance(
            as_allowance(baseline) if baseline else None, purchases, billing_period
        )
        if aggregate is None:
            return {"status": "denied", "allowed": False, "reason": "no_matching_entitlement_rule"}
        selected_rule = aggregate["rule"]["source"]
        effective_allowance = aggregate.get("effectiveAllowance")
        contributing_handles = aggregate.get("contributingRuleHandles")
    type_fields = _type_fields_of(selected_rule)

    # BL-0062 (gap G3): the selection above is the whole point of §2.6.5, and
    # its winner used to be dropped here — ``selected_rule`` was read for its
    # type fields and never for its identity. Rule refs are handle-valued
    # (plan 120 TASK-4), so the rule's ``id`` IS its ``unique_handle``.
    # Mirrors entitlement-check.ts ``selectedRuleHandle``.
    selected_rule_id = selected_rule.get("id")
    selected_rule_handle = (
        selected_rule_id if isinstance(selected_rule_id, str) and selected_rule_id != "" else None
    )

    def _usage_amount_for(key: str) -> float | None:
        entry = (user_usage or {}).get(key)
        if (
            is_record(entry)
            and isinstance(entry.get("amount"), (int, float))
            and not isinstance(entry.get("amount"), bool)
        ):
            return float(entry["amount"])
        return None

    def _finite_balance(key: str) -> float | None:
        v = usage_balances.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
            return float(v)
        return None

    # JS `??` chain: nullish-coalescing — 0 passes through, only
    # None/absent falls to the next source (so explicit ``is not None``,
    # never ``or`` which would skip a legitimate 0).
    used: float
    ctx_used = context.get("used") if context is not None else None
    if ctx_used is not None:
        used = float(ctx_used)
    else:
        fb_h = _finite_balance(handle)
        fb_e = _finite_balance(entitlement_id)
        ua_h = _usage_amount_for(handle)
        ua_e = _usage_amount_for(entitlement_id)
        if fb_h is not None:
            used = fb_h
        elif fb_e is not None:
            used = fb_e
        elif ua_h is not None:
            used = ua_h
        elif ua_e is not None:
            used = ua_e
        else:
            used = 0.0

    return with_rule_handle(
        derive_result_from_rule_type_fields(
            type_fields,
            used,
            effective_allowance,
            context_balance(context),
            None if context is None else context.get("cost"),
            handle if diagnostics else None,
            used_given=ctx_used is not None,
            app=app_numbers,
            trace=cost_trace,
        ),
        selected_rule_handle,
        contributing_handles,
    )


def context_balance(context: dict[str, Any] | None) -> float | None:
    """The caller's ``{ balance }`` as a finite number, else ``None``.

    Source: entitlement-check.ts (``context?.balance``). Only a real number
    counts; a bool, a string or a non-finite value is ignored.
    """
    if context is None:
        return None
    raw = context.get("balance")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        try:
            value = float(raw)
        except OverflowError:  # an int beyond double range: not a finite number
            return None
        return value if math.isfinite(value) else None
    return None


def with_rule_handle(
    result: EntitlementCheckResult,
    rule_handle: str | None,
    contributing_rule_handles: list[str] | None = None,
) -> EntitlementCheckResult:
    """Stamp the winning rule's handle onto a shaped result (BL-0062).

    Kept out of ``derive_result_from_rule_type_fields`` deliberately: that
    shaper reads ``type_fields``, and a rule's IDENTITY is not one of its type
    fields. Both evaluators own the selection, so both stamp. ``None`` leaves
    the key ABSENT rather than writing a null — absence and null are different
    bytes in a canonical-JSON parity snapshot.

    Source: entitlement-check.ts (withRuleHandle)
    """
    if rule_handle is not None:
        result = {**result, "rule_handle": rule_handle}
    if contributing_rule_handles is not None:
        result = {**result, "contributing_rule_handles": contributing_rule_handles}
    return result


def is_rule_shaped_kind(kind: Any) -> bool:
    """Rule kinds ``derive_result_from_rule_type_fields`` gives dedicated
    semantics. The DecisionEngine uses this to decide whether a matched rule
    fully shapes the result; a matched rule of a recognised but unshaped kind
    (see :func:`is_provider_deferred_kind`) proves the plan assignment exists
    and falls through to the provider entry/usage logic. Every other kind is
    decided by :func:`unrecognised_kind_result` (BL-0514).

    Source: entitlement-check.ts (isRuleShapedKind)
    """
    return kind in ("feature", "usage_limit", "limit", "credits", "capability_tier", "seat")


def is_provider_deferred_kind(kind: Any) -> bool:
    """Recognised kinds the shaper does not model and that stay decided exactly
    as before BL-0514: the IR spellings of the seat kind (``seats``) and of
    the tier kind (``tiered``). The schema spellings ``seat`` and
    ``capability_tier`` are shaped. The Playbook path allows; the
    DecisionEngine falls through to the provider entry/usage logic.

    Source: entitlement-check.ts (isProviderDeferredKind)
    """
    return kind in ("seats", "tiered")


#: Entitlement types the schema declares that are not access decisions
#: (BL-0514). Source: entitlement-check.ts (NON_ACCESS_ENTITLEMENT_KINDS)
_NON_ACCESS_ENTITLEMENT_KINDS = frozenset({"rate_limit", "price_per_unit"})


def unrecognised_kind_result(kind: Any) -> EntitlementCheckResult | None:
    """The fail-closed outcome for a matched rule whose kind is neither shaped
    nor provider-deferred, or ``None`` when it is one of those (BL-0514).

    - ``rate_limit`` / ``price_per_unit`` → denied,
      ``not_access_entitlement_kind``. The single-handle checks warn about it
      (:func:`warn_on_non_access_check`).
    - anything else, including an absent kind → denied,
      ``unknown_entitlement_kind``.

    Source: entitlement-check.ts (unrecognisedKindResult)
    """
    if is_rule_shaped_kind(kind) or is_provider_deferred_kind(kind):
        return None
    if isinstance(kind, str) and kind in _NON_ACCESS_ENTITLEMENT_KINDS:
        return {"status": "denied", "allowed": False, "reason": "not_access_entitlement_kind"}
    return {"status": "denied", "allowed": False, "reason": "unknown_entitlement_kind"}


_warned_non_access_handles: set[str] = set()


def warn_on_non_access_check(handle: str, result: EntitlementCheckResult | None) -> None:
    """Warn once per process per handle when an access check (``can()`` /
    ``check_entitlement()``) answered ``not_access_entitlement_kind``
    (BL-0514), through the same ``warnings`` channel the runtime uses for its
    other once-per-process diagnostics. Called from the single-handle check
    paths only, so evaluating every entitlement never warns on its own.

    Source: entitlement-check.ts (warnOnNonAccessCheck)
    """
    if result is None or result.get("reason") != "not_access_entitlement_kind":
        return
    if handle in _warned_non_access_handles:
        return
    _warned_non_access_handles.add(handle)
    warnings.warn(
        f'[revturbine] can() / check_entitlement("{handle}") was called on a rate_limit '
        "or price_per_unit entitlement, which is not an access entitlement; denying "
        "(not_access_entitlement_kind). Use the rate-limit / metering module for it instead.",
        RuntimeWarning,
        stacklevel=3,
    )


def _int_if_integral(value: float) -> float | int:
    """JSON-parity guard: JS serializes integral numbers without a decimal
    point (``100``), Python floats as ``100.0`` — emit ``int`` when whole."""
    return int(value) if isinstance(value, float) and value.is_integer() else value


def _with_limit_fields(
    base: EntitlementCheckResult, limit: float, used: float
) -> EntitlementCheckResult:
    """Enrich a limit-bearing outcome so the result carries the numbers
    (plan 133). Source: entitlement-check.ts (withLimitFields)."""
    enriched = dict(base)
    enriched["limit"] = _int_if_integral(limit)
    enriched["used"] = _int_if_integral(used)
    enriched["remaining"] = _int_if_integral(max(0.0, limit - used))
    return enriched  # type: ignore[return-value]


# ── Per-call cost (ST-1696, Kent's final rule 2026-11-11) ───────────────────

_COST_TOLERANCE_SCALE_CAP = float(2**48)


def _to_double(value: float) -> float:
    """``float(value)``, with an int beyond double range read as +/-infinity
    (what TS sees) instead of raising ``OverflowError``."""
    try:
        return float(value)
    except OverflowError:
        return math.inf if value > 0 else -math.inf


def _cost_exceeds_limit(used: float, cost: float, limit: float) -> bool:
    """The ONE comparison the cost > 0 rule uses (usage_limit, credits
    used-based). Copied from scaffold, not re-derived; IEEE-754 doubles, left
    to right::

        scale = min(max(1, |used|, |cost|, |limit|), 2**48)
        over  = ((used + cost) - limit) > 8 * EPSILON * scale

    ``EPSILON`` is ``sys.float_info.epsilon`` (2**-52). The missing-cost path
    (``used >= limit``) never uses this.

    Source: entitlement-check.ts (costExceedsLimit)
    """
    used, cost, limit = _to_double(used), _to_double(cost), _to_double(limit)
    scale = min(max(1.0, abs(used), abs(cost), abs(limit)), _COST_TOLERANCE_SCALE_CAP)
    return ((used + cost) - limit) > 8 * sys.float_info.epsilon * scale


def _cost_exceeds_balance(cost: float, balance: float) -> bool:
    """Balance form of :func:`_cost_exceeds_limit` (credits evaluated from a
    ``balance``)::

        scale = min(max(1, |cost|, |balance|), 2**48)
        over  = (cost - balance) > 8 * EPSILON * scale

    Source: entitlement-check.ts (costExceedsBalance)
    """
    cost, balance = _to_double(cost), _to_double(balance)
    scale = min(max(1.0, abs(cost), abs(balance)), _COST_TOLERANCE_SCALE_CAP)
    return (cost - balance) > 8 * sys.float_info.epsilon * scale


def _classify_cost(cost: Any) -> tuple[str, Any]:
    """``(kind, payload)``: ``positive`` (the cost), ``zero``, ``missing`` or
    ``invalid`` (the received KIND). A ``bool`` is not a number here, as in TS
    where ``typeof true !== 'number'``."""
    if cost is None:
        return ("missing", None)
    if isinstance(cost, bool) or not isinstance(cost, (int, float)):
        return ("invalid", "non_number")
    try:
        value = float(cost)
    except OverflowError:
        # An int beyond double range: TS reads it as Infinity. Never raises.
        return ("invalid", "infinite")
    if math.isnan(value):
        return ("invalid", "nan")
    if math.isinf(value):
        return ("invalid", "infinite")
    if value < 0:
        return ("invalid", "negative")
    return ("zero", None) if value == 0 else ("positive", value)


def _has_positive_cost(cost: Any) -> bool:
    """True for a finite cost above 0: the only cost the count-down / count-up
    comparison reads (ST-1741). Source: entitlement-check.ts (hasPositiveCost)."""
    return _classify_cost(cost)[0] == "positive"


def _note_trace(trace: dict[str, bool] | None, cost: Any, over: bool, app_numbers: bool) -> None:
    """Record what the cost > 0 comparison did, for the effective-entitlement
    merge: ``applied`` when a finite limit or balance was compared, ``over`` its
    verdict, ``app_numbers`` when the numbers compared were the app's or the
    call's. Source: entitlement-check.ts (noteTrace)."""
    if trace is not None and _classify_cost(cost)[0] == "positive":
        trace["applied"] = True
        trace["over"] = over
        trace["app_numbers"] = app_numbers


def evaluate_cost_limit(
    cost: Any,
    diagnose_handle: str | None,
    legacy_over: bool,
    over_with_cost: Callable[[float], bool],
) -> tuple[bool, EntitlementDiagnostic | None]:
    """Is a limit-enforcing call over its limit, and what should the developer
    be told? Truth table (finite limit only; callers skip this for unlimited):

    - cost > 0   : over = ``over_with_cost(cost)``, no diagnostic
    - cost == 0  : never over (free), ``entitlement_cost_zero`` warning
    - missing    : over = ``legacy_over`` (today's check), ``entitlement_cost_missing`` error
    - invalid    : over = ``legacy_over``, ``entitlement_cost_invalid`` error naming the kind

    ``diagnose_handle`` is set only by single-handle checks; without it the
    cost RULE still applies but no diagnostic is produced.

    Source: entitlement-check.ts (costVerdict / evaluateCostLimit)
    """
    kind, payload = _classify_cost(cost)
    if kind == "positive":
        return (over_with_cost(payload), None)
    if kind == "zero":
        zero: EntitlementDiagnostic | None = (
            None
            if diagnose_handle is None
            else {"level": "warning", "code": "entitlement_cost_zero", "handle": diagnose_handle}
        )
        return (False, zero)
    if kind == "missing":
        missing: EntitlementDiagnostic | None = (
            None
            if diagnose_handle is None
            else {"level": "error", "code": "entitlement_cost_missing", "handle": diagnose_handle}
        )
        return (legacy_over, missing)
    invalid: EntitlementDiagnostic | None = (
        None
        if diagnose_handle is None
        else {
            "level": "error",
            "code": "entitlement_cost_invalid",
            "handle": diagnose_handle,
            "received": payload,
        }
    )
    return (legacy_over, invalid)


def with_diagnostic(
    result: EntitlementCheckResult, diagnostic: EntitlementDiagnostic | None
) -> EntitlementCheckResult:
    """Attach a diagnostic to a result; a no-op without one."""
    if diagnostic is None:
        return result
    enriched = dict(result)
    enriched["diagnostic"] = diagnostic
    return enriched  # type: ignore[return-value]


_reported_diagnostics: set[tuple[str, str]] = set()
_LOGGER = logging.getLogger("revturbine")


def report_entitlement_diagnostic(result: EntitlementCheckResult | None) -> None:
    """Default Python routing for a result's developer diagnostic, once per
    handle + code per process (mirrors :func:`warn_on_non_access_check`).

    The warning (``entitlement_cost_zero``) goes through ``warnings.warn`` as a
    ``RuntimeWarning``. The two errors (``entitlement_cost_missing`` /
    ``entitlement_cost_invalid``) are made louder: they are logged at ERROR
    level on the ``revturbine`` logger AND raised as a ``RuntimeWarning``, so
    they surface both in a configured logging pipeline and under the default
    warnings filter. Never raises. Never changes the result.

    Source: entitlement-check.ts (reportEntitlementDiagnostic)
    """
    diagnostic = None if result is None else result.get("diagnostic")
    if not diagnostic:
        return
    key = (diagnostic["code"], diagnostic["handle"])
    if key in _reported_diagnostics:
        return
    _reported_diagnostics.add(key)
    where = f'[revturbine] can() / check_entitlement("{diagnostic["handle"]}")'
    if diagnostic["code"] == "entitlement_cost_zero":
        warnings.warn(
            f"{where} was called with cost 0: the action is treated as free and always "
            "allowed, even past the limit. Pass a positive cost if it should count "
            "against the limit.",
            RuntimeWarning,
            stacklevel=3,
        )
        return
    if diagnostic["code"] == "entitlement_cost_invalid":
        kinds = {
            "negative": "a negative number",
            "nan": "NaN",
            "infinite": "a non-finite number",
            "non_number": "a non-number value",
        }
        received: str = diagnostic.get("received") or "non_number"
        message = (
            f"{where} was called with an invalid cost ({kinds[received]}); "
            "falling back to the cost-less check (allowed while usage < limit). "
            "Pass cost as a finite number >= 0 (0 for free)."
        )
    else:
        message = (
            f"{where} was called without a cost on a usage-limited entitlement; "
            "falling back to the cost-less check (allowed while usage < limit). "
            "Pass a cost (0 for free)."
        )
    _LOGGER.error(message)
    warnings.warn(message, RuntimeWarning, stacklevel=3)


def derive_result_from_rule_type_fields(
    type_fields: dict[str, Any],
    used: float,
    effective_allowance: float | None = None,
    balance: float | None = None,
    cost: Any = None,
    diagnose_handle: str | None = None,
    *,
    used_given: bool = False,
    app: Mapping[str, Any] | None = None,
    trace: dict[str, bool] | None = None,
) -> EntitlementCheckResult:
    """Shape an EntitlementCheckResult from a matched rule's ``type_fields``
    (plan 133). Single-sourced for BOTH evaluators — the Playbook path
    above and the DecisionEngine's provider-snapshot path (decisions/engine.py)
    — so a matched rule yields identical results on every surface.
    Limit-bearing outcomes carry ``limit`` / ``used`` / ``remaining``.

    ST-1741 (Kent's D-7), cost above 0 only: ``used_given`` says the call passed
    its own ``used``; ``app`` is the numbers the app reported on its mirrored
    entitlement (``limit`` / ``used`` / ``remaining`` / ``remaining_derived``);
    ``trace`` is an out-parameter recording what the comparison did.

    Source: entitlement-check.ts (deriveResultFromRuleTypeFields)
    """
    kind = type_fields["kind"] if isinstance(type_fields.get("kind"), str) else None

    if kind == "feature":
        enabled = type_fields.get("enabled") is not False
        if enabled:
            return {"status": "allowed", "allowed": True}
        return {
            "status": "denied",
            "allowed": False,
            "reason": "feature_not_enabled_for_plan",
        }

    # `usage_limit` is the bundle-canonical kind; `limit` is the accepted
    # config-authoring shorthand (`type_fields` is an open record — the
    # schema does not discriminate the kind) — treat them identically.
    if kind in ("usage_limit", "limit"):
        # plan 72: unlimited (None/'unlimited'/999999/absent) → +inf → not
        # finite → allowed; a finite limit enforces. Mirrors the TS shaper's
        # resolveLimitValue exactly (a numeric STRING is junk → allowed, it
        # is never coerced and enforced).
        ul_limit = (
            effective_allowance
            if effective_allowance is not None
            else resolve_limit_value(type_fields.get("limit_value"))
        )
        used_now = used
        # ST-1741 (D-7): a usage limit always counts UP. With a cost above 0 the
        # comparison reads the call's own ``used`` (against the rule's limit),
        # else the used / limit the app mirrored, else held usage against the
        # rule's limit as before. An unlimited rule plus a finite mirrored limit
        # therefore enforces the mirrored limit when cost > 0. A mirrored
        # ``remaining`` alone, and a per-call ``balance``, are ignored here.
        ul_app_numbers = False
        if _classify_cost(cost)[0] == "positive":
            if used_given:
                ul_app_numbers = True
            elif app is not None and ("used" in app or "limit" in app):
                ul_app_numbers = True
                if "limit" in app:
                    ul_limit = app["limit"]
                if "used" in app:
                    used_now = app["used"]
        if ul_limit is not None and math.isfinite(ul_limit) and ul_limit >= 0:
            ul_over, ul_diag = evaluate_cost_limit(
                cost,
                diagnose_handle,
                used_now >= ul_limit,
                lambda c: _cost_exceeds_limit(used_now, c, ul_limit),
            )
            _note_trace(trace, cost, ul_over, ul_app_numbers)
            return with_diagnostic(
                _with_limit_fields(
                    _apply_usage_enforcement(
                        ul_over, type_fields.get("enforcement"), "usage_limit_reached"
                    ),
                    ul_limit,
                    used_now,
                ),
                ul_diag,
            )
        return {"status": "allowed", "allowed": True}

    if kind == "credits":
        allowance: float | None
        # An *explicit* allowance (incl. None/'unlimited'/999999 → +inf,
        # plan 72) wins; only a *truly absent* allowance falls through to
        # initial_grant. Source: entitlement-check.ts credits branch.
        # Plan 147 REQ-2: canonical `allowance_value`, legacy `allowance` tolerated.
        if effective_allowance is not None:
            allowance = effective_allowance
        elif "allowance_value" in type_fields:
            allowance = resolve_limit_value(type_fields.get("allowance_value"))
        elif "allowance" in type_fields:
            allowance = resolve_limit_value(type_fields.get("allowance"))
        else:
            allowance = None
        initial_grant = _js_number(type_fields.get("initial_grant"))
        cr_limit: float | None
        if allowance is not None and allowance >= 0:
            cr_limit = allowance
        elif math.isfinite(initial_grant) and initial_grant >= 0:
            cr_limit = initial_grant
        else:
            cr_limit = None
        # ST-1696 REQ-9: a caller-supplied ``{ balance }`` is the REMAINING
        # balance and wins over ``used`` and stored usage for this call.
        # Exhausted at ``balance <= 0``; ``used`` is allowance minus balance.
        # Ignored when not finite. Mirrors the TS credits branch exactly.
        # Cost rule: with a finite balance the balance IS the limit, whether or
        # not the rule has a finite allowance (then only ``remaining`` is
        # reported, no ``limit`` / ``used``).
        # ST-1741 (D-7): credits always count DOWN. The balance is the first
        # available of: (1) the per-call ``balance``; (2) the per-call ``used``
        # (balance = allowance - used); (3) the remaining the app mirrored
        # (``remaining``, or ``limit - used`` when both were sent), only with a
        # cost above 0; (4) held usage (allowance - used). (2) and (4) are
        # evaluated as ``used + cost > allowance`` with the 0.16.0 helper.
        positive = _classify_cost(cost)[0] == "positive"
        mirrored_remaining = app.get("remaining") if (positive and not used_given and app) else None
        has_call_balance = balance is not None and math.isfinite(balance)
        balance_now: float | None
        if has_call_balance:
            balance_now = balance
        elif mirrored_remaining is not None and math.isfinite(mirrored_remaining):
            balance_now = mirrored_remaining
        else:
            balance_now = None
        if balance_now is not None:
            from_mirror = not has_call_balance
            # The limit the result reports: the app's own limit when the balance
            # is the app's, else the rule's allowance.
            app_limit = app.get("limit") if app else None
            report_limit = app_limit if (from_mirror and app_limit is not None) else cr_limit
            # Comparison forms by source (copied from scaffold): a per-call
            # ``balance`` and an explicit mirrored ``remaining`` use the balance
            # form; a balance DERIVED from the app's ``limit - used`` uses the
            # used-plus-cost form on those two numbers, never the derived remaining.
            pair_used_raw = app.get("used") if app else None
            pair: tuple[float, float] | None = (
                (float(pair_used_raw), float(app_limit))
                if (
                    from_mirror
                    and bool(app and app.get("remaining_derived") is True)
                    and app_limit is not None
                    and math.isfinite(app_limit)
                    and pair_used_raw is not None
                    and math.isfinite(pair_used_raw)
                )
                else None
            )
            bal: float = balance_now
            bal_over, bal_diag = evaluate_cost_limit(
                cost,
                diagnose_handle,
                bal <= 0,
                (lambda c: _cost_exceeds_limit(pair[0], c, pair[1]))
                if pair is not None
                else (lambda c: _cost_exceeds_balance(c, bal)),
            )
            _note_trace(trace, cost, bal_over, True)
            base = with_diagnostic(
                _apply_usage_enforcement(
                    bal_over, type_fields.get("enforcement"), "credit_balance_exhausted"
                ),
                bal_diag,
            )
            enriched = dict(base)
            if report_limit is not None and math.isfinite(report_limit):
                rep: float = report_limit
                enriched["limit"] = _int_if_integral(rep)
                enriched["used"] = _int_if_integral(
                    max(0.0, min(pair[0], rep)) if pair is not None else max(0.0, rep - bal)
                )
            enriched["remaining"] = _int_if_integral(max(0.0, bal))
            return enriched  # type: ignore[return-value]
        if cr_limit is not None and math.isfinite(cr_limit):
            cr_over, cr_diag = evaluate_cost_limit(
                cost,
                diagnose_handle,
                used >= cr_limit,
                lambda c: _cost_exceeds_limit(used, c, cr_limit),
            )
            _note_trace(trace, cost, cr_over, used_given)
            return with_diagnostic(
                _with_limit_fields(
                    _apply_usage_enforcement(
                        cr_over,
                        type_fields.get("enforcement"),
                        "credit_balance_exhausted",
                    ),
                    cr_limit,
                    used,
                ),
                cr_diag,
            )
        return {"status": "allowed", "allowed": True}

    if kind == "seat":
        seat_limit = (
            effective_allowance
            if effective_allowance is not None
            else resolve_limit_value(type_fields.get("included_count"))
        )
        if seat_limit is not None and math.isfinite(seat_limit) and seat_limit >= 0:
            return _with_limit_fields({"status": "allowed", "allowed": True}, seat_limit, used)
        return {"status": "allowed", "allowed": True}

    if kind == "capability_tier":
        tier_name = (
            type_fields["tier_name"] if isinstance(type_fields.get("tier_name"), str) else None
        )
        result: EntitlementCheckResult = {"status": "allowed", "allowed": True}
        if tier_name:
            result["current_tier"] = tier_name
        return result

    # BL-0514: only the recognised-but-unshaped kinds (seats, the `tiered` IR
    # spelling) keep the plain allow. A non-access or unknown kind denies.
    refused = unrecognised_kind_result(kind)
    if refused is not None:
        return refused
    return {"status": "allowed", "allowed": True}
