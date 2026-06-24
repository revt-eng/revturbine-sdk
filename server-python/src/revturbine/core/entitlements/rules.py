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

from revturbine.core.entitlements.segment_matching import matches_rule_segments
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
    current_plan_variation_id: str
    addon_ids: list[str]
    addon_variation_ids: list[str]
    billing_period: str
    segment_dimensions: dict[str, str]


def _target_matches(t: dict[str, Any], ctx: RuleEvaluationContext) -> bool:
    """Does one kind-discriminated target match the user context?

    Source: rules.ts:44-60 (targetMatches)
    """
    kind = t.get("kind")
    if kind == "plan":
        return ctx.get("current_plan_id") is not None and t.get("id") == ctx.get("current_plan_id")
    if kind == "plan_variation":
        return ctx.get("current_plan_variation_id") is not None and t.get("id") == ctx.get(
            "current_plan_variation_id"
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
            cpid = context.get("current_plan_id")
            matches_plan = cpid is not None and cpid in rule["plan_ids"]

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

    def num(v: Any) -> float | None:
        if v == "unlimited":
            return math.inf
        if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
            return float(v)
        return None

    kind = rule["kind"]
    if kind == "usage_limit":
        n = num(f.get("limit_value"))
        return n if n is not None else 0
    if kind == "credits":
        n = num(f.get("allowance_value"))
        if n is None:
            n = num(f.get("allowance"))
        return n if n is not None else 0
    if kind == "seat":
        n = num(f.get("included_count"))
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
    evaluations = evaluate_entitlement_rules(rules, context)
    return _select_most_permissive([e for e in evaluations if e["matched"]])
