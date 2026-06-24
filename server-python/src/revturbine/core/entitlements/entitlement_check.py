"""Entitlement check lifecycle — Python port of
@revt-eng/entitlements/controllers/entitlement-check.ts
(plan-32/34-reconciled).

``derive_local_entitlement_from_configured_rules`` is the
ExportedConfig-rule fallback wired into
``LocalRuntime._derive_entitlement_from_config`` (plan 33 TASK-6 leaf,
faithful to TS local-runtime.ts:355-369). It does its **own** inline
rule filtering and takes the **first** matching rule — distinct from
``rules.py``'s provider-snapshot most-permissive selector; both shapes
are ported because plan 33 TASK-13 names both.

Sync per Q-5. ExportedConfig / rule items stay loosely typed
(``dict[str, Any]``) per the port convention; the parity suite is the
drift backstop.

Source: revturbine-scaffold/src/entitlements/controllers/entitlement-check.ts
"""

from __future__ import annotations

import math
from typing import Any

from revturbine.core.decisions.types import EntitlementCheckResult
from revturbine.core.entitlements.rules import (
    pick_most_permissive,
    rule_permissiveness,
)
from revturbine.core.entitlements.segment_matching import matches_rule_segments
from revturbine.core.helpers import is_record

__all__ = ["derive_local_entitlement_from_configured_rules"]

ExportedConfig = dict[str, Any]


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
    if enforcement == "soft_block":
        return {
            "status": "denied",
            "allowed": False,
            "reason": f"{base_reason}_soft_block",
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
    exported_config: ExportedConfig,
) -> EntitlementCheckResult | None:
    """Derive an entitlement result locally from ExportedConfig rules.

    Returns ``None`` when no config is available; an explicit result
    otherwise (including ``no_matching_entitlement_rule`` ⇒ denied,
    fail closed).

    Source: entitlement-check.ts:77-211
    (deriveLocalEntitlementFromConfiguredRules)
    """
    entitlements: list[dict[str, Any]] = exported_config.get("entitlements") or []
    entitlement: dict[str, Any] | None = None
    for item in entitlements:
        if (isinstance(item.get("unique_handle"), str) and item["unique_handle"] == handle) or (
            isinstance(item.get("id"), str) and item["id"] == handle
        ):
            entitlement = item
            break

    entitlement_id = (
        entitlement["id"]
        if entitlement is not None and isinstance(entitlement.get("id"), str)
        else handle
    )
    normalized_plan_handle = str(current_plan_handle or "").lower()

    plans: list[dict[str, Any]] = exported_config.get("plans") or []
    matched_plan: dict[str, Any] | None = None
    for plan in plans:
        if (
            isinstance(plan.get("unique_handle"), str)
            and plan["unique_handle"].lower() == normalized_plan_handle
        ) or (
            isinstance(plan.get("id"), str) and str(plan["id"]).lower() == normalized_plan_handle
        ):
            matched_plan = plan
            break

    current_plan_id: str | None = (
        matched_plan["id"]
        if matched_plan is not None and isinstance(matched_plan.get("id"), str)
        else (normalized_plan_handle or None)
    )

    rules: list[dict[str, Any]] = exported_config.get("entitlement_rules") or []

    # Plan #39 REQ-28: build the segment_id → dimension_id lookup once per
    # call so the dimensional matcher can group rule segments. Segments
    # missing a dimension fall into `__no_dim__` inside the helper,
    # preserving flat-OR back-compat for pre-PR-B exports.
    segment_dimensions: dict[str, str] = {}
    for seg in exported_config.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        sid = seg.get("id")
        dim = seg.get("dimension_id")
        if isinstance(sid, str) and isinstance(dim, str):
            segment_dimensions[sid] = dim

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

        if current_plan_id and current_plan_id not in plan_ids:
            return False

        # Plan #39 REQ-8: dimensional matching — intra-dimension OR +
        # cross-dimension AND, with `__no_dim__` flat-OR fallback for
        # segments that haven't been categorised yet.
        rule_segment_ids = rule.get("segment_ids")
        if not isinstance(rule_segment_ids, list):
            rule_segment_ids = rule.get("segmentIds")
        return matches_rule_segments(
            rule_segment_ids if isinstance(rule_segment_ids, list) else None,
            segment_ids,
            segment_dimensions,
        )

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

    def _type_fields_of(r: dict[str, Any]) -> dict[str, Any]:
        tf = r.get("type_fields")
        if is_record(tf):
            return tf
        tf_camel = r.get("typeFields")
        if is_record(tf_camel):
            return tf_camel
        return {}

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
    type_fields = _type_fields_of(selected_rule)
    kind = type_fields["kind"] if isinstance(type_fields.get("kind"), str) else None

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

    if kind == "feature":
        enabled = type_fields.get("enabled") is not False
        if enabled:
            return {"status": "allowed", "allowed": True}
        return {
            "status": "denied",
            "allowed": False,
            "reason": "feature_not_enabled_for_plan",
        }

    if kind == "usage_limit":
        ul_limit = _js_number(type_fields.get("limit_value"))
        if math.isfinite(ul_limit) and ul_limit >= 0:
            return _apply_usage_enforcement(
                used >= ul_limit, type_fields.get("enforcement"), "usage_limit_reached"
            )
        return {"status": "allowed", "allowed": True}

    if kind == "credits":
        allowance = _js_number(type_fields.get("allowance"))
        initial_grant = _js_number(type_fields.get("initial_grant"))
        cr_limit: float | None
        if math.isfinite(allowance) and allowance >= 0:
            cr_limit = allowance
        elif math.isfinite(initial_grant) and initial_grant >= 0:
            cr_limit = initial_grant
        else:
            cr_limit = None
        if cr_limit is not None:
            return _apply_usage_enforcement(
                used >= cr_limit,
                type_fields.get("enforcement"),
                "credit_balance_exhausted",
            )
        return {"status": "allowed", "allowed": True}

    if kind == "capability_tier":
        tier_name = (
            type_fields["tier_name"] if isinstance(type_fields.get("tier_name"), str) else None
        )
        result: EntitlementCheckResult = {"status": "allowed", "allowed": True}
        if tier_name:
            result["current_tier"] = tier_name
        return result

    return {"status": "allowed", "allowed": True}
