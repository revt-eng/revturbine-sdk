"""Segment mode and dimension inference (ST-1391, fixes BUG-1389).

Python port of ``@revt-eng/core``'s ``segment-mode.ts``. A segment's dimension
and its basic/advanced mode are read from its predicates, so a stored
``dimension_id`` can no longer decide how a rule's ``segment_ids`` combine (an
upload that rewrote every id to one placeholder turned AND-across-dimensions
into a flat OR).

::

    fields  = distinct predicate.field, in order of first appearance
    mode    = segment.mode ?? (every operator in {eq, in} ? 'basic' : 'advanced')
    dim_key = mode == 'basic' and len(fields) == 1
                ? ('rt_<key>' -> 'rt.<key>', else the field itself)
                : segment.dimension_id or None        # None -> __no_dim__

Parity with the TS helper is asserted by ``tests/parity`` (segment evaluation
and dimension-key fixtures); keep the two in step.

Source: segments/controllers/segment-mode.ts
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

__all__ = [
    "BASIC_SEGMENT_OPERATORS",
    "SEGMENT_MODES",
    "SegmentClassification",
    "basic_mode_violations",
    "canonicalize_segment_predicates",
    "classify_segment",
    "dimension_key_for_field",
    "infer_segment_mode",
    "is_basic_segment_operator",
    "segment_dimension_keys",
]

#: The two segment modes. Optional on the Playbook today; required later.
SEGMENT_MODES: tuple[str, ...] = ("basic", "advanced")

#: The operators a basic segment may use.
BASIC_SEGMENT_OPERATORS: tuple[str, ...] = ("eq", "in")

_BUILTIN_TRAIT_PREFIX = "rt_"
_BUILTIN_DIMENSION_PREFIX = "rt."


@dataclass(frozen=True)
class SegmentClassification:
    """Result of :func:`classify_segment` (mirrors ``SegmentClassification``)."""

    mode: str
    mode_inferred: bool
    dimension_key: str | None
    dimension_derived: bool
    fields: list[str]
    declared_dimension_id: str | None
    dimension_mismatch: bool


def is_basic_segment_operator(operator: Any) -> bool:
    """True for an operator a basic segment may carry.

    Source: segment-mode.ts:isBasicSegmentOperator
    """
    return bool(operator == "eq" or operator == "in")


def dimension_key_for_field(field: str) -> str:
    """The dimension key a single predicate field implies: ``rt_<key>`` -> ``rt.<key>``.

    Source: segment-mode.ts:dimensionKeyForField
    """
    if field.startswith(_BUILTIN_TRAIT_PREFIX) and len(field) > len(_BUILTIN_TRAIT_PREFIX):
        return _BUILTIN_DIMENSION_PREFIX + field[len(_BUILTIN_TRAIT_PREFIX) :]
    return field


def _predicates_of(segment: dict[str, Any]) -> list[dict[str, Any]]:
    raw = segment.get("predicates")
    if not isinstance(raw, list):
        return []
    return [p for p in raw if isinstance(p, dict)]


def infer_segment_mode(segment: dict[str, Any]) -> str:
    """Infer a mode from predicates alone (ignores ``mode``). Empty -> basic.

    Source: segment-mode.ts:inferSegmentMode
    """
    ok = all(is_basic_segment_operator(p.get("operator")) for p in _predicates_of(segment))
    return "basic" if ok else "advanced"


def classify_segment(segment: dict[str, Any]) -> SegmentClassification:
    """Classify one segment: its mode, rule-matcher dimension key and mismatch.

    Source: segment-mode.ts:classifySegment
    """
    fields: list[str] = []
    for p in _predicates_of(segment):
        field = p.get("field")
        if isinstance(field, str) and field not in fields:
            fields.append(field)

    raw_mode = segment.get("mode")
    explicit = raw_mode if raw_mode in SEGMENT_MODES else None
    mode = explicit if explicit is not None else infer_segment_mode(segment)

    raw_dim = segment.get("dimension_id")
    declared = raw_dim if isinstance(raw_dim, str) and len(raw_dim) > 0 else None

    derived = mode == "basic" and len(fields) == 1
    dimension_key = dimension_key_for_field(fields[0]) if derived else declared

    return SegmentClassification(
        mode=mode,
        mode_inferred=explicit is None,
        dimension_key=dimension_key,
        dimension_derived=derived,
        fields=fields,
        declared_dimension_id=declared,
        dimension_mismatch=derived and declared is not None and declared != dimension_key,
    )


def segment_dimension_keys(segments: list[Any] | None) -> dict[str, str]:
    """``{segment_handle: dimension_key}`` for every segment with a key.

    Segments without a key are omitted (they share the no-dimension bucket).

    Source: segment-mode.ts:segmentDimensionKeys
    """
    out: dict[str, str] = {}
    for segment in segments or []:
        if not isinstance(segment, dict):
            continue
        handle = segment.get("handle")
        if not isinstance(handle, str):
            continue
        key = classify_segment(segment).dimension_key
        if key is not None:
            out[handle] = key
    return out


def basic_mode_violations(segment: dict[str, Any]) -> list[dict[str, Any]]:
    """Predicates that make an explicit ``mode: 'basic'`` invalid.

    Source: segment-mode.ts:basicModeViolations
    """
    if segment.get("mode") != "basic":
        return []
    raw = segment.get("predicates")
    predicates = raw if isinstance(raw, list) else []
    out: list[dict[str, Any]] = []
    for index, p in enumerate(predicates):
        operator = p.get("operator") if isinstance(p, dict) else None
        if not is_basic_segment_operator(operator):
            out.append({"index": index, "operator": str(operator)})
    return out


def canonicalize_segment_predicates(segment: dict[str, Any]) -> dict[str, Any]:
    """Merge same-field basic ``eq``/``in`` predicates into one ``in`` predicate.

    Returns ``{"ok": True, "segment": ...}`` or ``{"ok": False, "reason": ...}``
    (a comma, or surrounding whitespace, in an ``eq`` value cannot be merged
    losslessly). Advanced segments and segments with no repeated field pass
    through unchanged (same object).

    Source: segment-mode.ts:canonicalizeSegmentPredicates
    """
    if classify_segment(segment).mode != "basic":
        return {"ok": True, "segment": segment}
    raw = segment.get("predicates")
    predicates: list[Any] = raw if isinstance(raw, list) else []

    count_by_field: dict[str, int] = {}
    for p in predicates:
        field = p.get("field") if isinstance(p, dict) else None
        if isinstance(field, str):
            count_by_field[field] = count_by_field.get(field, 0) + 1
    if not any(n > 1 for n in count_by_field.values()):
        return {"ok": True, "segment": segment}

    values_by_field: dict[str, list[str]] = {}
    for p in predicates:
        field = p.get("field") if isinstance(p, dict) else None
        if not isinstance(field, str) or count_by_field.get(field, 0) < 2:
            continue
        value = p.get("value")
        if not isinstance(value, str):
            return {"ok": False, "reason": f'predicate on field "{field}" has a non-string value'}
        values = values_by_field.setdefault(field, [])
        if p.get("operator") == "in":
            for item in (s.strip() for s in value.split(",")):
                if item not in values:
                    values.append(item)
        else:
            if "," in value:
                return {
                    "ok": False,
                    "reason": (
                        f'basic segment repeats field "{field}" and its value "{value}" '
                        'contains a comma, so the predicates cannot be merged into one "in" list'
                    ),
                }
            if value != value.strip():
                return {
                    "ok": False,
                    "reason": (
                        f'basic segment repeats field "{field}" and its value "{value}" '
                        'has surrounding whitespace, which an "in" list would trim'
                    ),
                }
            if value not in values:
                values.append(value)

    emitted: set[str] = set()
    merged: list[Any] = []
    for p in predicates:
        field = p.get("field") if isinstance(p, dict) else None
        if not isinstance(field, str) or count_by_field.get(field, 0) < 2:
            merged.append(p)
            continue
        if field in emitted:
            continue
        emitted.add(field)
        merged.append(
            {"field": field, "operator": "in", "value": ",".join(values_by_field.get(field, []))}
        )
    return {"ok": True, "segment": {**segment, "predicates": merged}}
