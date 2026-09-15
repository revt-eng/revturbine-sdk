"""Python port of scaffold's ``core/placements/cap-rules.ts`` evaluator.

``evaluate_caps`` is THE cap/cooldown primitive: TypeScript consolidated
every caller onto it in plan 233 TASK-15 (scaffold #351) so the windowing
and cooldown arithmetic live in exactly one place per language. Until plan
234 TASK-14 this port did not exist and ``placement_decision.py`` carried
its own copy of the maths — a second implementation waiting to drift,
which is the condition plan 167 spent a plan trying to eliminate.

Three layers, fixed order (spec placement-studio-ui.md:316,
most-restrictive-wins); an earlier suppression short-circuits the rest.
Every layer is optional — supply only the inputs relevant to the caller.

Source: cap-rules.ts (evaluateCaps, capCounterKey).
"""

from __future__ import annotations

import math
from typing import Any, TypedDict

from revturbine.core.helpers import PlacementCapRule, period_window_start
from revturbine.core.state.types import PlacementCapPolicy


class CapEvaluationResult(TypedDict, total=False):
    allowed: bool
    reason: str
    matched_rule_id: str


def cap_counter_key(rule_id: str, period: str) -> str:
    """Canonical counter-map key — evaluator and counter-builders must agree.

    Source: cap-rules.ts capCounterKey.
    """
    return f"{rule_id}:{period}"


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def evaluate_caps(
    *,
    now: float,
    session_cooldown_minutes: float | None = None,
    last_session_presentation_at: float | None = None,
    rules: list[dict[str, Any]] | None = None,
    candidate: dict[str, Any] | None = None,
    counters: dict[str, float] | None = None,
    per_payload: dict[str, Any] | None = None,
) -> CapEvaluationResult:
    """Evaluate whether a candidate may be presented under the cap rules.

    Mirrors ``evaluateCaps`` branch for branch:

    1. Session cooldown — ``session_cooldown`` when the cooldown has not
       elapsed since the most recent session presentation.
    2. Presentation cap rules — first matching rule (by template/slot
       group) whose counter has met its cap answers ``cap_hit``; the
       caller orders the rules.
    3. Per-payload gate — an active post-dismiss cooldown answers
       ``suppressed_by_payload_cooldown``; then each ``max_per_period``
       rule over its rolling window answers
       ``suppressed_by_payload_cap_<period>``.

    Source: cap-rules.ts:207-259.
    """
    # 1. Session cooldown.
    if (
        session_cooldown_minutes is not None
        and session_cooldown_minutes > 0
        and last_session_presentation_at is not None
        and now - last_session_presentation_at < session_cooldown_minutes * 60_000
    ):
        return CapEvaluationResult(allowed=False, reason="session_cooldown")

    # 2. Presentation cap rules.
    if rules and candidate is not None:
        counter_map = counters or {}
        for rule in rules:
            group = rule.get("group") or []
            matches = any(
                (g.get("kind") == "template" and g.get("id") == candidate.get("template_id"))
                or (g.get("kind") == "slot" and g.get("id") == candidate.get("slot_id"))
                for g in group
                if isinstance(g, dict)
            )
            if not matches:
                continue
            cap = rule.get("cap") or {}
            key = cap_counter_key(str(rule.get("id")), str(cap.get("period")))
            current = counter_map.get(key, 0)
            if current >= cap.get("count", 0):
                return CapEvaluationResult(
                    allowed=False, reason="cap_hit", matched_rule_id=str(rule.get("id"))
                )

    # 3. Per-payload gate.
    if per_payload is not None:
        policies: list[PlacementCapPolicy] = per_payload.get("policies") or []
        seen_at: list[float] = per_payload.get("seen_at") or []
        cooldown_until = per_payload.get("cooldown_until")

        if (
            cooldown_until is not None
            and _is_finite_number(cooldown_until)
            and cooldown_until > now
        ):
            return CapEvaluationResult(allowed=False, reason="suppressed_by_payload_cooldown")

        for policy in policies:
            rule_list: list[PlacementCapRule] = policy.get("rules") or []
            for cap_rule in rule_list:
                window_start = period_window_start(cap_rule["period"], now)
                within = [ts for ts in seen_at if window_start <= ts <= now]
                if len(within) >= cap_rule["count"]:
                    return CapEvaluationResult(
                        allowed=False,
                        reason=f"suppressed_by_payload_cap_{cap_rule['period']}",
                    )

    return CapEvaluationResult(allowed=True)
