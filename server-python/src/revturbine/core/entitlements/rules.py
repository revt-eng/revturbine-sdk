"""Entitlement rule evaluation — Python port of
@revt-eng/entitlements/controllers/rules.ts (plan-34-reconciled).

Matches ``EntitlementRuleSnapshot`` rules against a plan/segment
context and picks the **most permissive** matched rule (plan 34 REQ-1 /
§2.6.5 — "where entitlement rules overlap, the most permissive rule
prevails"; ties resolve to earliest source order, deterministic and
cross-language-parity-stable).

Sync per Q-5. ``EntitlementRuleTargetSnapshot`` / ``PlanRuleSnapshot``
stay loosely typed (``dict[str, Any]``) per the port convention.

Source: revturbine-scaffold/src/entitlements/controllers/rules.ts
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from typing import Any, TypedDict, TypeVar

from revturbine.core.entitlements.purchased_allowance import (
    aggregate_purchased_allowance,
    validate_purchased_addons,
)
from revturbine.core.entitlements.segment_matching import matches_rule_segments
from revturbine.core.entitlements.unlimited import resolve_limit_value
from revturbine.core.providers.types import (
    EntitlementRuleSnapshot,
    RuleProviderState,
)

_T = TypeVar("_T")

__all__ = [
    "EntitlementRuleEvaluation",
    "RuleEvaluationContext",
    "evaluate_entitlement_rules",
    "evaluate_plan_rules",
    "find_matching_entitlement_rule",
    "pick_most_permissive",
    "rule_permissiveness",
]


class _RuleEvaluationContextRequired(TypedDict):
    segment_ids: list[str]


class RuleEvaluationContext(_RuleEvaluationContextRequired, total=False):
    """User targeting context. ``segment_ids`` is required; the rest are
    optional forward context for kind-discriminated targets.

    ``segment_dimensions`` (plan #39 REQ-28) carries the
    ``segment_id -> dimension_id`` lookup the dimensional matcher uses.
    Optional — when absent, the matcher falls back to flat-OR via the
    ``__no_dim__`` bucket, preserving pre-PR-B back-compat.

    Source: rules.ts:14-35 (RuleEvaluationContext)
    """

    current_plan_id: str
    current_plan_handle: str
    current_plan_variation_id: str
    addon_ids: list[str]
    addon_variation_ids: list[str]
    billing_period: str
    segment_dimensions: dict[str, str]
    addons: list[dict[str, Any]]
    matched_plan_variation_ids: list[str]


def _target_matches(t: dict[str, Any], ctx: RuleEvaluationContext) -> bool:
    """Does one kind-discriminated target match the user context?

    Source: rules.ts:44-60 (targetMatches)
    """
    kind = t.get("kind")
    if kind == "plan":
        # Plan 120 TASK-3.5: match the plan target by id OR handle.
        return (
            ctx.get("current_plan_id") is not None and t.get("id") == ctx.get("current_plan_id")
        ) or (
            ctx.get("current_plan_handle") is not None
            and t.get("id") == ctx.get("current_plan_handle")
        )
    if kind == "plan_variation":
        explicit = ctx.get("current_plan_variation_id")
        return (
            t.get("id") == explicit
            if explicit is not None
            else t.get("id") in (ctx.get("matched_plan_variation_ids") or [])
        )
    if kind == "addon":
        return t.get("id") in (ctx.get("addon_ids") or [])
    if kind == "addon_variation":
        return t.get("id") in (ctx.get("addon_variation_ids") or [])
    return False


class EntitlementRuleEvaluation(TypedDict):
    """Source: rules.ts:62-67 (EntitlementRuleEvaluation)"""

    rule: EntitlementRuleSnapshot
    matches_plan: bool
    matches_segment: bool
    matched: bool


def evaluate_entitlement_rules(
    rules: list[EntitlementRuleSnapshot],
    context: RuleEvaluationContext,
) -> list[EntitlementRuleEvaluation]:
    """Evaluate rules against plan + segment context.

    A rule matches when: kind-discriminated ``targets`` (any match) when
    present, else the legacy ``plan_ids`` path — match only when
    ``current_plan_id`` is explicitly listed (empty matches NOTHING; the
    implicit "empty ⇒ all plans" was removed, plan 34 REQ-9 / TASK-11);
    AND ``segment_ids`` is empty (matches all) or contains at least one
    of the user's segments (plan #39 REQ-8 — flat-OR back-compat path
    when no dimension data is available).

    Source: rules.ts:83-104 (evaluateEntitlementRules)
    """
    out: list[EntitlementRuleEvaluation] = []
    for rule in rules:
        targets = rule.get("targets")
        if targets is not None and len(targets) > 0:
            matches_plan = any(_target_matches(t, context) for t in targets)
        else:
            # Legacy `plan_ids` path — plan 120 TASK-3.5: match by id OR handle.
            cpid = context.get("current_plan_id")
            cph = context.get("current_plan_handle")
            matches_plan = (cpid is not None and cpid in rule["plan_ids"]) or (
                cph is not None and cph in rule["plan_ids"]
            )

        rule_segment_ids = rule.get("segment_ids")
        matches_segment = matches_rule_segments(
            rule_segment_ids if isinstance(rule_segment_ids, list) else None,
            context["segment_ids"],
            context.get("segment_dimensions"),
        )

        out.append(
            EntitlementRuleEvaluation(
                rule=rule,
                matches_plan=matches_plan,
                matches_segment=matches_segment,
                matched=matches_plan and matches_segment,
            )
        )
    return out


def evaluate_plan_rules(
    rules: list[dict[str, Any]],
    context: RuleEvaluationContext,
) -> list[dict[str, Any]]:
    """Active plan rules matching the segment context.

    Source: rules.ts:111-120 (evaluatePlanRules)
    """
    result: list[dict[str, Any]] = []
    for rule in rules:
        if rule.get("status") != "active":
            continue
        # Plan rules retain the singular `segment_id` scalar — this is a
        # different table (plan_variations) and is REQ-21 out of scope.
        seg = rule.get("segment_id")
        if seg is None or seg in context["segment_ids"]:
            result.append(rule)
    return result


def rule_permissiveness(rule: Mapping[str, Any]) -> float:
    """Permissiveness score — higher grants more access. ``'unlimited'``
    → +inf; finite numeric as-is; non-orderable kinds → neutral 0 (the
    deterministic source-order tie-break then applies).

    Structural param (``{kind, fields}``) so the ExportedConfig fallback
    (``entitlement_check.derive_local_entitlement_from_configured_rules``)
    reuses this single source — mirrors the exported TS
    ``rulePermissiveness``; the §2.6.5 scoring is never implemented twice.

    Source: rules.ts:138-158 (rulePermissiveness)
    """
    f: dict[str, Any] = rule.get("fields") or {}

    # `resolve_limit_value` maps unlimited (None/'unlimited'/999999/absent)
    # → +inf and a finite number to itself (plan 72 — single-sourced in
    # ./unlimited, mirroring rules.ts which delegates to resolveLimitValue).
    kind = rule["kind"]
    if kind == "usage_limit":
        n = resolve_limit_value(f.get("limit_value"))
        return n if n is not None else 0
    if kind == "credits":
        # prefer `allowance_value`, fall back to the legacy `allowance` key;
        # pick the source field by presence BEFORE resolving (an absent value
        # resolves to +inf, which would otherwise swallow the fallback).
        n = resolve_limit_value(
            f["allowance_value"] if "allowance_value" in f else f.get("allowance")
        )
        return n if n is not None else 0
    if kind == "seat":
        n = resolve_limit_value(f.get("included_count"))
        return n if n is not None else 0
    if kind == "feature":
        return 1 if f.get("enabled") is True else 0
    return 0


def pick_most_permissive(
    items: Sequence[_T],
    score: Callable[[_T], float],
) -> _T | None:
    """THE most-permissive selection + tie-break rule, single-sourced
    (plan 34 REQ-1 / §2.6.5): highest ``score``, ties resolve to the
    earliest in source order (strict ``>`` keeps the first seen).
    Deterministic and cross-language-parity-stable. Reused by both the
    provider-snapshot path (``_select_most_permissive``) and the
    ExportedConfig fallback
    (``derive_local_entitlement_from_configured_rules``) so the §2.6.5
    rule is never implemented twice.

    Mirrors the exported TS ``pickMostPermissive`` byte-for-byte.

    Source: rules.ts:165-185 (pickMostPermissive)
    """
    best: _T | None = None
    best_score = -math.inf
    for item in items:
        s = score(item)
        if best is None or s > best_score:
            best = item
            best_score = s
    return best


def _select_most_permissive(
    matched: list[EntitlementRuleEvaluation],
) -> EntitlementRuleSnapshot | None:
    """Pick the most-permissive rule among matched evaluations.

    Source: rules.ts:188-194 (selectMostPermissive)
    """
    best = pick_most_permissive(matched, lambda e: rule_permissiveness(e["rule"]))
    return best["rule"] if best is not None else None


def find_matching_entitlement_rule(
    rule_state: RuleProviderState,
    entitlement_id: str,
    context: RuleEvaluationContext,
) -> EntitlementRuleSnapshot | None:
    """Governing rule for an entitlement — most-permissive among
    matched (NOT array order). ``None`` if no rule matches.

    Source: rules.ts:187-197 (findMatchingEntitlementRule)
    """
    rules = rule_state["entitlement_rules"].get(entitlement_id)
    if not rules:
        return None
    # TS passes ruleState.segmentDimensions as the third argument; the
    # Python evaluator reads it from the context, so thread the state's
    # lookup through when the caller didn't supply one (plan 133).
    state_dims = rule_state.get("segment_dimensions")
    if state_dims is not None and context.get("segment_dimensions") is None:
        context = context.copy()
        context["segment_dimensions"] = state_dims
    declared = validate_purchased_addons(context.get("addons"))
    baseline_context = context.copy()
    baseline_context["matched_plan_variation_ids"] = [
        handle
        for handle, variation in (rule_state.get("plan_variations") or {}).items()
        if variation.get("plan_handle")
        == context.get("current_plan_handle", context.get("current_plan_id"))
        and variation.get("billing_period") == context.get("billing_period")
        and (
            not variation.get("segment_handle")
            or variation["segment_handle"] in context["segment_ids"]
        )
    ]
    baseline_context["addon_ids"] = [
        handle
        for handle in context.get("addon_ids", [])
        if not any(h["addon_handle"] == handle for h in declared)
    ]
    baseline_context["addon_variation_ids"] = [
        handle
        for handle in context.get("addon_variation_ids", [])
        if not any(h.get("addon_variation_handle") == handle for h in declared)
    ]
    evaluations = evaluate_entitlement_rules(rules, baseline_context)
    purchases = []

    def as_allowance(rule: EntitlementRuleSnapshot) -> dict[str, Any]:
        return {
            "ruleId": rule["rule_id"],
            "kind": rule["kind"],
            "fields": rule["fields"],
            "source": rule,
        }

    for holding in declared:
        if holding["quantity"] == 0:
            continue
        variation_handle = holding.get("addon_variation_handle")
        variation = (
            (rule_state.get("addon_variations") or {}).get(variation_handle)
            if variation_handle
            else None
        )
        # Unknown or mismatched variations contribute nothing (fail closed),
        # matching scaffold rules.ts and the exported-Playbook path.
        if variation_handle and (
            variation is None or variation.get("addon_handle") != holding["addon_handle"]
        ):
            continue
        purchase_context: RuleEvaluationContext = {
            "segment_ids": context["segment_ids"],
            "addon_ids": [holding["addon_handle"]],
            "addon_variation_ids": [variation_handle] if variation_handle else [],
            "segment_dimensions": context.get("segment_dimensions", {}),
        }
        matches = evaluate_entitlement_rules(rules, purchase_context)
        rule = _select_most_permissive(
            [
                e
                for e in matches
                if e["matched"]
                and (e["rule"]["kind"] != "credits" or "reset_period" in e["rule"]["fields"])
            ]
        )
        if rule is not None:
            purchases.append(
                {
                    "rule": as_allowance(rule),
                    "quantity": holding["quantity"],
                    "billingPeriod": variation.get("billing_period") if variation else None,
                }
            )
    baseline = _select_most_permissive(
        [
            e
            for e in evaluations
            if e["matched"]
            and (
                not purchases
                or e["rule"]["kind"] != "credits"
                or "reset_period" in e["rule"]["fields"]
            )
        ]
    )
    anchor = baseline or (purchases[0]["rule"]["source"] if purchases else None)
    if anchor and anchor["kind"] not in ("seat", "credits", "usage_limit", "limit"):
        return pick_most_permissive(
            ([baseline] if baseline else []) + [p["rule"]["source"] for p in purchases],
            rule_permissiveness,
        )
    aggregate = aggregate_purchased_allowance(
        as_allowance(baseline) if baseline else None, purchases, context.get("billing_period")
    )
    if aggregate is None:
        return None
    result: EntitlementRuleSnapshot = aggregate["rule"]["source"].copy()
    if "effectiveAllowance" in aggregate:
        result["effective_allowance"] = aggregate["effectiveAllowance"]
    if "contributingRuleHandles" in aggregate:
        result["contributing_rule_handles"] = aggregate["contributingRuleHandles"]
    return result
