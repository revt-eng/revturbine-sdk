"""revturbine.core.segments — Python port of ``@revt-eng/core`` segment evaluation.

Port of ``segments/controllers/segments.ts``. Segments are composed of
predicates over user traits; a segment matches when ALL of its predicates are
satisfied (AND logic).

Previously ``LocalRuntime.evaluate_segments`` raised ``NotImplementedError`` as
a plan-33 REQ-14 non-goal, which left segment membership a browser-only concept.
Plan 233 made segment targeting a decision input in every runtime, so evaluation
has to agree too: a headless SDK that cannot derive membership cannot make the
same selection the browser SDK does.

Parity is asserted byte-for-byte by ``tests/parity``, which is why the JS
coercion semantics below are reproduced deliberately rather than approximated.

Source: segments/controllers/segments.ts, user/controllers/activity-level.ts
"""

from __future__ import annotations

import math
from typing import Any

__all__ = [
    "ACTIVE_ACTIVITY_LEVELS",
    "ACTIVITY_LEVEL_TRAIT",
    "activity_level_satisfies",
    "evaluate_predicate",
    "evaluate_segments",
    "experiment_by_segment_handle",
]

#: The trait key carrying the retrieval-derived activity level (plan 180 D5).
ACTIVITY_LEVEL_TRAIT = "activity_level"

#: The levels an authored ``active`` target matches (plan 180 D1).
ACTIVE_ACTIVITY_LEVELS: tuple[str, ...] = ("high", "medium", "low")


def activity_level_satisfies(target: str, level: str) -> bool:
    """Whether a derived level satisfies a targeting value.

    ``active`` matches the union high|medium|low; every other value matches
    exactly. A non-canonical level string only ever exact-matches (fail closed).

    Source: activity-level.ts:activityLevelSatisfies
    """
    if target == "active":
        return level in ACTIVE_ACTIVITY_LEVELS
    return target == level


def _js_string(value: Any) -> str:
    """JavaScript ``String(value)`` coercion.

    Python's ``str`` diverges on exactly the values traits carry: ``str(True)``
    is ``"True"`` where JS gives ``"true"``, and ``str(1.0)`` is ``"1.0"`` where
    JS gives ``"1"``. Both would break byte-identical parity on a plain
    equality predicate.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float) and value.is_integer() and math.isfinite(value):
        return str(int(value))
    return str(value)


def _js_number(text: str) -> float:
    """JavaScript ``Number(text)`` for the numeric comparison operators.

    Reproduces the coercions that change an outcome: whitespace is trimmed,
    an empty string is ``0``, hex/octal/binary literals parse per JS, and
    anything unparseable is ``NaN`` — which makes every comparison false,
    exactly as it does in JS.
    """
    s = text.strip()
    if s == "":
        return 0.0
    try:
        lowered = s.lower()
        # JS Number() accepts these literal forms; float() does not.
        if lowered.startswith(("0x", "-0x", "+0x")):
            return float(int(s, 16))
        if lowered.startswith(("0o", "-0o", "+0o")):
            return float(int(s, 8))
        if lowered.startswith(("0b", "-0b", "+0b")):
            return float(int(s, 2))
        if lowered in ("infinity", "+infinity"):
            return math.inf
        if lowered == "-infinity":
            return -math.inf
        # Python accepts "nan"/"inf" and underscore separators; JS does not.
        if "_" in s or lowered in ("nan", "inf", "-inf", "+inf"):
            return math.nan
        return float(s)
    except ValueError:
        return math.nan


def evaluate_predicate(predicate: dict[str, Any], traits: dict[str, Any]) -> bool:
    """Whether one predicate is satisfied by the user's traits.

    A trait the user does not carry fails closed.

    Source: segments/controllers/segments.ts:evaluatePredicate
    """
    field = predicate.get("field")
    raw_value = traits.get(field) if field is not None else None
    if raw_value is None:
        return False

    trait_str = _js_string(raw_value)
    target_str = predicate.get("value")
    target_str = "" if target_str is None else str(target_str)

    is_activity_level = field == ACTIVITY_LEVEL_TRAIT
    operator = predicate.get("operator")

    if operator == "eq":
        if is_activity_level:
            return activity_level_satisfies(target_str, trait_str)
        return trait_str == target_str
    if operator == "neq":
        if is_activity_level:
            return not activity_level_satisfies(target_str, trait_str)
        return trait_str != target_str
    if operator == "gt":
        return _js_number(trait_str) > _js_number(target_str)
    if operator == "lt":
        return _js_number(trait_str) < _js_number(target_str)
    if operator == "gte":
        return _js_number(trait_str) >= _js_number(target_str)
    if operator == "lte":
        return _js_number(trait_str) <= _js_number(target_str)
    if operator == "contains":
        return target_str in trait_str
    if operator == "in":
        accepted = [s.strip() for s in target_str.split(",")]
        if is_activity_level:
            return any(activity_level_satisfies(a, trait_str) for a in accepted)
        return trait_str in accepted
    return False


def evaluate_segments(
    segments: list[dict[str, Any]],
    traits: dict[str, Any],
    assignments: dict[str, str] | None = None,
) -> list[str]:
    """Segment **handles** whose predicates all match.

    Returns handles, not minted ids — segment identity is the handle (plan 120),
    and payload ``segment_chips`` are matched against these.

    Experiment enrollment (plan 183) is fail-closed: a segment naming an
    experiment matches only a user the ExperimentProvider assigned to it, and an
    unassigned user is NOT enrolled — deliberately distinct from being assigned
    to a control arm. Enrollment alone is a complete rule, so an experiment
    segment needs no predicates; a trait-based one with no predicates is skipped
    because it would otherwise match everybody.

    Source: segments/controllers/segments.ts:evaluateSegments
    """
    resolved = assignments or {}
    matched: list[str] = []

    for segment in segments:
        handle = str(segment.get("handle") or "")
        predicates = segment.get("predicates") or []
        has_predicates = len(predicates) > 0

        experiment_handle = segment.get("experiment_handle")
        if experiment_handle:
            if experiment_handle not in resolved:
                continue
            if not has_predicates:
                matched.append(handle)
                continue
        elif not has_predicates:
            continue

        if all(evaluate_predicate(p, traits) for p in predicates):
            matched.append(handle)

    return matched


def experiment_by_segment_handle(segments: list[dict[str, Any]]) -> dict[str, str]:
    """``{segment_handle: experiment_handle}`` for segments naming an experiment.

    Source: segments/controllers/segments.ts:experimentBySegmentHandle
    """
    out: dict[str, str] = {}
    for segment in segments:
        experiment_handle = segment.get("experiment_handle")
        if experiment_handle:
            out[str(segment.get("handle") or "")] = str(experiment_handle)
    return out
