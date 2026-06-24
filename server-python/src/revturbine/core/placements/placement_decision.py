"""Placement decision lifecycle — Python port of
@revt-eng/core/placements/controllers/placement-decision.ts.

Pure functions for candidate resolution, scoring, milestone
supersession, category-conflict suppression, cap computation, and
decision-cache-key derivation. No I/O, no async, no state.

Source: revturbine-scaffold/src/placements/controllers/placement-decision.ts
"""

from __future__ import annotations

import math
from functools import cmp_to_key
from typing import Any, Literal, TypedDict

from revturbine.core.crypto import fallback_hash_base64url
from revturbine.core.helpers import (
    PlacementOutput,
    category_bucket,
    is_record,
    milestone_version,
    normalized_route,
    parse_cap_rule,
    parse_numberish,
    period_window_start,
    placement_priority,
    placement_score,
    proximity_score,
    server_order,
    stable_stringify,
    superseded_versions,
)
from revturbine.core.normalization import normalize_placement_output
from revturbine.core.state.types import (
    PlacementCapPolicy,
    PlacementCapRule,
    PresentationCapState,
    SurfaceTypeCapRule,
)

__all__ = [
    "CandidateResolutionOptions",
    "CapCheckResult",
    "DecisionCacheKeyInput",
    "FilteredSlotDecision",
    "PlacementRequestConfig",
    "SlotDecision",
    "SupersessionRecord",
    "SupersessionResult",
    "apply_category_conflict_suppression",
    "apply_milestone_supersession",
    "apply_milestone_supersession_with_metadata",
    "check_placement_caps",
    "check_system_presentation_caps",
    "decision_cache_key",
    "extract_placement_cap_policies",
    "filter_one_discretionary",
    "local_placement_lookup_key",
    "normalize_decision_from_response",
    "normalize_placement_output",  # re-exported from normalization (TS parity)
    "resolve_local_placement_from_candidates",
]


_MS_PER_DAY = 24 * 60 * 60 * 1000


# ── Types ───────────────────────────────────────────────────────────────────


class PlacementRequestConfig(TypedDict, total=False):
    """Source: placement-decision.ts:33-39"""

    slot_id: str
    surface_type: str
    entitlement_handle: str
    plan_handle: str
    placement_handle: str


class _DecisionCacheKeyRequired(TypedDict):
    tenant_id: str
    placement_id: str
    user_id: str
    route: str


class DecisionCacheKeyInput(_DecisionCacheKeyRequired, total=False):
    """Source: placement-decision.ts:41-50"""

    context_mode: str
    overrides: dict[str, Any]
    traits: dict[str, Any]
    runtime_context_fingerprint: str


class CandidateResolutionOptions(TypedDict, total=False):
    """Source: placement-decision.ts:170-173"""

    fixed_only: bool


class _CapCheckResultRequired(TypedDict):
    allowed: bool


class CapCheckResult(_CapCheckResultRequired, total=False):
    """Source: placement-decision.ts:308-312"""

    reason: str
    updated_state: PresentationCapState


class SupersessionRecord(TypedDict):
    """Source: placement-decision.ts:446-450"""

    superseded_output_id: str
    superseded_by: str
    reason: Literal["milestone_version", "milestone_order"]


class SupersessionResult(TypedDict):
    """Source: placement-decision.ts:452-455"""

    survivors: list[PlacementOutput]
    superseded: list[SupersessionRecord]


class _SlotDecisionRequired(TypedDict):
    output: PlacementOutput
    slot_id: str


class SlotDecision(_SlotDecisionRequired, total=False):
    """Source: placement-decision.ts:532-535"""


class FilteredSlotDecision(_SlotDecisionRequired, total=False):
    """Source: placement-decision.ts:537-540"""

    suppressed: bool
    suppression_reason: str


# ── Lookup key ──────────────────────────────────────────────────────────────


def local_placement_lookup_key(config: PlacementRequestConfig) -> str:
    """Source: placement-decision.ts:57-65"""
    return "::".join(
        [
            config.get("slot_id") or "",
            config.get("surface_type") or "",
            config.get("entitlement_handle") or "",
            config.get("plan_handle") or "",
            config.get("placement_handle") or "",
        ]
    )


# ── Cache key ───────────────────────────────────────────────────────────────


def decision_cache_key(input_data: DecisionCacheKeyInput) -> str:
    """Deterministic cache key. Feeds ``fallback_hash_base64url`` so the
    key is cross-language stable with the TS frontend.

    Source: placement-decision.ts:69-80
    """
    fingerprint_obj: dict[str, Any] = {
        "placementId": input_data["placement_id"],
        "userId": input_data["user_id"],
        "contextMode": input_data.get("context_mode", "auto"),
        "overrides": input_data.get("overrides", {}),
        "traits": input_data.get("traits", {}),
        "route": normalized_route(input_data["route"]),
    }
    rcf = input_data.get("runtime_context_fingerprint")
    if rcf:
        fingerprint_obj["runtimeContextFingerprint"] = rcf
    fingerprint = stable_stringify(fingerprint_obj)
    return (
        f"{input_data['tenant_id']}:{input_data['placement_id']}:"
        f"{input_data['user_id']}:{fallback_hash_base64url(fingerprint)}"
    )


# ── Milestone supersession ──────────────────────────────────────────────────


def _surface_template(output: PlacementOutput) -> str | None:
    surface = output.get("surface")
    if not is_record(surface):
        return None
    template = surface.get("template")
    return template if isinstance(template, str) and template else None


def apply_milestone_supersession(outputs: list[PlacementOutput]) -> list[PlacementOutput]:
    """Drop outputs superseded by an explicit ``supersedes_template_version``
    match, then by ``milestone_order`` within a shared surface template.

    Source: placement-decision.ts:84-138
    """
    if len(outputs) <= 1:
        return outputs

    suppressed: set[str] = set()

    for contender in outputs:
        template = _surface_template(contender)
        if not template:
            continue
        supersedes = superseded_versions(contender)
        if not supersedes:
            continue
        for candidate in outputs:
            if candidate["output_id"] == contender["output_id"]:
                continue
            if _surface_template(candidate) != template:
                continue
            version = milestone_version(candidate)
            if not version:
                continue
            if version in supersedes:
                suppressed.add(candidate["output_id"])

    by_template: dict[str, list[PlacementOutput]] = {}
    for output in outputs:
        template = _surface_template(output)
        if not template:
            continue
        by_template.setdefault(template, []).append(output)

    for group in by_template.values():
        if len(group) <= 1:
            continue
        contenders = []
        for output in group:
            content_raw = output.get("content")
            content: dict[str, Any] = content_raw if is_record(content_raw) else {}
            order = parse_numberish(content.get("milestone_order"))
            contenders.append((output, order if order is not None else -math.inf))
        contenders = [c for c in contenders if math.isfinite(c[1])]
        if len(contenders) <= 1:
            continue
        # JS reduce keeps the FIRST max on ties (strict `>` comparison).
        winner = contenders[0]
        for entry in contenders[1:]:
            if entry[1] > winner[1]:
                winner = entry
        for output, _order in contenders:
            if output["output_id"] != winner[0]["output_id"]:
                suppressed.add(output["output_id"])

    return [o for o in outputs if o["output_id"] not in suppressed]


# ── Category conflict suppression ───────────────────────────────────────────


def apply_category_conflict_suppression(
    outputs: list[PlacementOutput],
) -> list[PlacementOutput]:
    """When two outputs share a surface type, the lower category bucket
    (higher priority) wins; the other is suppressed.

    Source: placement-decision.ts:142-166
    """
    if len(outputs) <= 1:
        return outputs

    suppressed: set[str] = set()
    for i in range(len(outputs)):
        for j in range(i + 1, len(outputs)):
            left = outputs[i]
            right = outputs[j]
            if left["surface"].get("type") != right["surface"].get("type"):
                continue
            left_bucket = category_bucket(left["category"])
            right_bucket = category_bucket(right["category"])
            if left_bucket == right_bucket:
                continue
            if left_bucket < right_bucket:
                suppressed.add(right["output_id"])
            else:
                suppressed.add(left["output_id"])

    return [o for o in outputs if o["output_id"] not in suppressed]


# ── Candidate scoring + selection ───────────────────────────────────────────


def resolve_local_placement_from_candidates(
    candidates: list[PlacementOutput],
    enable_category_pipeline: bool = False,  # noqa: ARG001 — parity w/ TS signature
    options: CandidateResolutionOptions | None = None,
) -> PlacementOutput | None:
    """Select the single winning candidate after milestone supersession,
    category-conflict suppression, and the multi-key ordering.

    ``enable_category_pipeline`` is accepted for TS signature parity but
    is unused by the TS body too (the pipeline is gated upstream).

    Source: placement-decision.ts:175-232
    """
    pool = candidates
    if options and options.get("fixed_only"):
        pool = [o for o in pool if category_bucket(o["category"]) == 1]
    if not pool:
        return None

    milestones_applied = apply_milestone_supersession(pool)
    if not milestones_applied:
        return None

    has_explicit_server_order = any(server_order(o) is not None for o in milestones_applied)
    conflicts_applied = (
        milestones_applied
        if has_explicit_server_order
        else apply_category_conflict_suppression(milestones_applied)
    )
    if not conflicts_applied:
        return None

    def _cmp(left: PlacementOutput, right: PlacementOutput) -> int:
        if has_explicit_server_order:
            lo = server_order(left)
            ro = server_order(right)
            if lo is not None and ro is not None and lo != ro:
                return -1 if lo < ro else 1
            if lo is not None and ro is None:
                return -1
            if lo is None and ro is not None:
                return 1

        left_bucket = category_bucket(left["category"])
        right_bucket = category_bucket(right["category"])
        if left_bucket != right_bucket:
            return left_bucket - right_bucket

        if 2 <= left_bucket <= 3:
            prox = proximity_score(right) - proximity_score(left)
            if prox != 0:
                return -1 if prox < 0 else 1

        score = placement_score(right) - placement_score(left)
        if score != 0:
            return -1 if score < 0 else 1

        prio = placement_priority(right) - placement_priority(left)
        if prio != 0:
            return -1 if prio < 0 else 1

        # JS String.prototype.localeCompare on ASCII output_id slugs.
        lid = left["output_id"]
        rid = right["output_id"]
        return int(lid > rid) - int(lid < rid)

    ordered = sorted(conflicts_applied, key=cmp_to_key(_cmp))
    return ordered[0] if ordered else None


# ── Response normalization ──────────────────────────────────────────────────


def _decision_content(header: str, body: str, cta_label: str) -> dict[str, str]:
    return {
        "header": header,
        "body": body,
        "cta_label": cta_label,
        "title": header,
        "cta": cta_label,
    }


def normalize_decision_from_response(
    placement_id: str,
    request_id: str,
    placement_name: str,
    payload: Any,
) -> dict[str, Any]:
    """Normalize a remote decision-API response into the decision shape.

    Source: placement-decision.ts:240-274
    """
    root = payload if is_record(payload) else {}
    decision = root["decision"] if is_record(root.get("decision")) else {}
    if is_record(root.get("content")):
        content = root["content"]
    elif is_record(decision.get("content")):
        content = decision["content"]
    else:
        content = {}

    if isinstance(decision.get("visible"), bool):
        visible = decision["visible"]
    elif isinstance(root.get("visible"), bool):
        visible = root["visible"]
    else:
        visible = True

    reason_codes_raw = root.get("reason_codes")
    reason_codes = (
        [r for r in reason_codes_raw if isinstance(r, str)]
        if isinstance(reason_codes_raw, list)
        else []
    )

    return {
        "placement_id": placement_id,
        "request_id": (
            root["request_id"] if isinstance(root.get("request_id"), str) else request_id
        ),
        "visible": visible,
        "decision_source": "remote",
        "reason_codes": reason_codes,
        "content": _decision_content(
            content["title"]
            if isinstance(content.get("title"), str)
            else f"{placement_name} recommendation",
            content["body"]
            if isinstance(content.get("body"), str)
            else "Treatment selected by RevTurbine decisioning.",
            content["cta"] if isinstance(content.get("cta"), str) else "Continue",
        ),
    }


# ── Cap enforcement (pure computation) ──────────────────────────────────────


def _js_number_positive_finite(value: Any) -> float | None:
    """Mirror TS ``const x = Number(v); Number.isFinite(x) && x > 0``.

    Kept consistent with the same predicate in
    ``revturbine.core.state.cap_enforcer`` — cap configs carry numeric
    ``cooldown_days``; numeric-string coercion (JS ``Number("3")``) is
    not modeled here and the parity suite would flag it if it ever
    occurred in practice.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def extract_placement_cap_policies(output: PlacementOutput) -> list[PlacementCapPolicy]:
    """Collect cap policies from output / content / content.{payload,
    placement,surface}.

    Source: placement-decision.ts:278-306
    """
    policies: list[PlacementCapPolicy] = []
    content = output.get("content")
    roots: list[Any] = [output, content]
    if is_record(content):
        roots.append(content.get("payload"))
        roots.append(content.get("placement"))
        roots.append(content.get("surface"))

    for root in roots:
        if not is_record(root):
            continue
        caps = root.get("caps")
        if not is_record(caps):
            continue
        rules: list[PlacementCapRule] = []
        rule = parse_cap_rule(caps.get("max_per_period"))
        if rule is not None:
            rules.append(rule)
        cooldown_days = _js_number_positive_finite(caps.get("cooldown_days"))
        policy: PlacementCapPolicy = PlacementCapPolicy(rules=rules)
        if cooldown_days is not None:
            policy["cooldown_ms"] = int(cooldown_days * _MS_PER_DAY)
        policies.append(policy)

    return policies


def check_placement_caps(
    output: PlacementOutput,
    cap_key: str,  # noqa: ARG001 — parity w/ TS signature (caller keys state)
    existing_state: PresentationCapState | None,
    now_ms: int,
    interaction_type: Literal["impression", "dismiss"] = "impression",
) -> CapCheckResult:
    """Pure cap check returning the allow/deny verdict + the cap state to
    persist. Cooldown is applied only on ``interaction_type='dismiss'``
    (spec: cooldown is "after dismiss").

    Source: placement-decision.ts:323-371
    """
    policies = extract_placement_cap_policies(output)
    if not policies:
        return CapCheckResult(allowed=True)

    prev = existing_state if existing_state is not None else PresentationCapState(seen_at=[])
    seen_at = [
        ts
        for ts in prev.get("seen_at", [])
        if isinstance(ts, (int, float))
        and not isinstance(ts, bool)
        and math.isfinite(ts)
        and ts > 0
    ]
    state: PresentationCapState = PresentationCapState(seen_at=seen_at)
    if "cooldown_until" in prev:
        state["cooldown_until"] = prev["cooldown_until"]

    cooldown_until = state.get("cooldown_until")
    if cooldown_until is not None and math.isfinite(cooldown_until) and cooldown_until > now_ms:
        return CapCheckResult(
            allowed=False,
            reason="suppressed_by_payload_cooldown",
            updated_state=state,
        )

    for policy in policies:
        for rule in policy["rules"]:
            window_start = period_window_start(rule["period"], now_ms)
            within = [ts for ts in state["seen_at"] if window_start <= ts <= now_ms]
            if len(within) >= rule["count"]:
                trimmed: PresentationCapState = PresentationCapState(seen_at=within)
                if "cooldown_until" in state:
                    trimmed["cooldown_until"] = state["cooldown_until"]
                return CapCheckResult(
                    allowed=False,
                    reason=f"suppressed_by_payload_cap_{rule['period']}",
                    updated_state=trimmed,
                )

    updated_seen_at = [*state["seen_at"], now_ms]
    cooldowns: list[float] = []
    if interaction_type == "dismiss":
        cooldowns = [
            policy["cooldown_ms"]
            for policy in policies
            if "cooldown_ms" in policy
            and isinstance(policy["cooldown_ms"], (int, float))
            and not isinstance(policy["cooldown_ms"], bool)
            and math.isfinite(policy["cooldown_ms"])
            and policy["cooldown_ms"] > 0
        ]
    new_state: PresentationCapState = PresentationCapState(seen_at=updated_seen_at)
    if cooldowns:
        new_state["cooldown_until"] = now_ms + int(max(cooldowns))
    return CapCheckResult(allowed=True, updated_state=new_state)


def check_system_presentation_caps(
    output: PlacementOutput,
    surface_type: str,
    surface_cap_rules: list[SurfaceTypeCapRule] | None = None,
    session_cooldown_ms: int | None = None,
    presentation_history: PresentationCapState | None = None,
    now_ms: int | None = None,
) -> CapCheckResult:
    """System-level (per-surface-type) caps. Deterministic/priority
    categories (bucket ≤ 3) are exempt; only discretionary categories
    (bucket ≥ 4) are capped.

    Source: placement-decision.ts:382-442
    """
    import time

    if now_ms is None:
        now_ms = int(time.time() * 1000)

    if not surface_cap_rules:
        return CapCheckResult(allowed=True)

    if category_bucket(output["category"]) <= 3:
        return CapCheckResult(allowed=True)

    rule = next(
        (r for r in surface_cap_rules if r["surface_type"].lower() == surface_type.lower()),
        None,
    )
    if rule is None:
        return CapCheckResult(allowed=True)

    state = (
        presentation_history
        if presentation_history is not None
        else PresentationCapState(seen_at=[])
    )

    if session_cooldown_ms and session_cooldown_ms > 0 and state["seen_at"]:
        last_seen = max(state["seen_at"])
        if now_ms - last_seen < session_cooldown_ms:
            return CapCheckResult(allowed=False, reason="suppressed_by_system_cooldown")

    for cap_rule in rule["rules"]:
        window_start = period_window_start(cap_rule["period"], now_ms)
        within = [ts for ts in state["seen_at"] if window_start <= ts <= now_ms]
        if len(within) >= cap_rule["count"]:
            return CapCheckResult(
                allowed=False,
                reason=f"suppressed_by_system_cap_{cap_rule['period']}",
            )

    rule_cooldown = rule.get("cooldown_ms")
    if rule_cooldown and rule_cooldown > 0 and state["seen_at"]:
        last_seen = max(state["seen_at"])
        if now_ms - last_seen < rule_cooldown:
            return CapCheckResult(allowed=False, reason="suppressed_by_system_cooldown")

    return CapCheckResult(allowed=True)


# ── Milestone supersession with analytics metadata ──────────────────────────


def apply_milestone_supersession_with_metadata(
    outputs: list[PlacementOutput],
) -> SupersessionResult:
    """Same logic as ``apply_milestone_supersession`` but also reports
    which outputs were superseded and why.

    Source: placement-decision.ts:461-528
    """
    if len(outputs) <= 1:
        return SupersessionResult(survivors=outputs, superseded=[])

    suppressed: dict[str, SupersessionRecord] = {}

    for contender in outputs:
        template = _surface_template(contender)
        if not template:
            continue
        supersedes = superseded_versions(contender)
        if not supersedes:
            continue
        for candidate in outputs:
            if candidate["output_id"] == contender["output_id"]:
                continue
            if _surface_template(candidate) != template:
                continue
            version = milestone_version(candidate)
            if not version:
                continue
            if version in supersedes:
                suppressed[candidate["output_id"]] = SupersessionRecord(
                    superseded_output_id=candidate["output_id"],
                    superseded_by=contender["output_id"],
                    reason="milestone_version",
                )

    by_template: dict[str, list[PlacementOutput]] = {}
    for output in outputs:
        template = _surface_template(output)
        if not template:
            continue
        by_template.setdefault(template, []).append(output)

    for group in by_template.values():
        if len(group) <= 1:
            continue
        contenders = []
        for output in group:
            content_raw = output.get("content")
            content: dict[str, Any] = content_raw if is_record(content_raw) else {}
            order = parse_numberish(content.get("milestone_order"))
            contenders.append((output, order if order is not None else -math.inf))
        contenders = [c for c in contenders if math.isfinite(c[1])]
        if len(contenders) <= 1:
            continue
        winner = contenders[0]
        for entry in contenders[1:]:
            if entry[1] > winner[1]:
                winner = entry
        for output, _order in contenders:
            if output["output_id"] != winner[0]["output_id"]:
                suppressed[output["output_id"]] = SupersessionRecord(
                    superseded_output_id=output["output_id"],
                    superseded_by=winner[0]["output_id"],
                    reason="milestone_order",
                )

    return SupersessionResult(
        survivors=[o for o in outputs if o["output_id"] not in suppressed],
        superseded=list(suppressed.values()),
    )


# ── One-discretionary-per-cycle filter ──────────────────────────────────────


def filter_one_discretionary(
    decisions: list[SlotDecision],
    already_fired_discretionary: bool = False,
) -> list[FilteredSlotDecision]:
    """Deterministic/priority categories (bucket < 4) always pass.
    Discretionary categories (bucket ≥ 4) are suppressed once one has
    already fired in the cycle.

    Source: placement-decision.ts:549-573
    """
    discretionary_fired = already_fired_discretionary
    result: list[FilteredSlotDecision] = []
    for decision in decisions:
        bucket = category_bucket(decision["output"]["category"])
        if bucket < 4:
            result.append(
                FilteredSlotDecision(output=decision["output"], slot_id=decision["slot_id"])
            )
            continue
        if discretionary_fired:
            result.append(
                FilteredSlotDecision(
                    output=decision["output"],
                    slot_id=decision["slot_id"],
                    suppressed=True,
                    suppression_reason="one_discretionary_per_cycle",
                )
            )
            continue
        discretionary_fired = True
        result.append(FilteredSlotDecision(output=decision["output"], slot_id=decision["slot_id"]))
    return result
