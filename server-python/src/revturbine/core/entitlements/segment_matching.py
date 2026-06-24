"""Plan #39 REQ-8 — intra-dimension OR + cross-dimension AND.

Mirror of revturbine-scaffold's `src/entitlements/controllers/
segment-matching.ts` helper, ported to keep the python port byte-
parity with scaffold's evaluator. Both callers
(``derive_local_entitlement_from_configured_rules`` in
``entitlement_check.py`` and ``evaluate_entitlement_rules`` in
``rules.py``) route through ``matches_rule_segments`` so the
algorithm exists once.

Algorithm
---------

1. Empty ``rule_segment_ids`` → match all users (return True).
2. Look up each segment ID's dimension; segments without a known
   dimension bucket into ``__no_dim__`` (flat-OR back-compat for
   pre-PR-B exports that lack ``segment.dimension_id``).
3. Group the rule's segment IDs by dimension.
4. The rule matches when **every** dimension bucket has at least one
   ID in the user's segment set (cross-AND of intra-OR groups).

Symbol parity with the TS helper is intentional so a future refactor
can extract a shared corpus.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

__all__ = ["matches_rule_segments"]

_NO_DIMENSION_BUCKET = "__no_dim__"


def matches_rule_segments(
    rule_segment_ids: Iterable[str] | None,
    user_segments: Iterable[str],
    segment_dimensions: Mapping[str, str] | None,
) -> bool:
    """Return True iff a rule's segment scope matches the user.

    Parameters
    ----------
    rule_segment_ids:
        The rule's ``segment_ids`` array (plan #39). Empty / None →
        the rule matches all users.
    user_segments:
        IDs of segments the user belongs to.
    segment_dimensions:
        Map of ``segment_id -> dimension_id``. Segments missing from
        the map fall into the ``__no_dim__`` bucket (flat-OR fallback
        for older exports without ``segment.dimension_id``).
    """
    if rule_segment_ids is None:
        return True
    rule_ids = [s for s in rule_segment_ids if isinstance(s, str)]
    if len(rule_ids) == 0:
        return True

    user_set = set(s for s in user_segments if isinstance(s, str))
    dims = segment_dimensions or {}

    buckets: dict[str, list[str]] = {}
    for seg_id in rule_ids:
        dim = dims.get(seg_id) if isinstance(dims.get(seg_id), str) else _NO_DIMENSION_BUCKET
        buckets.setdefault(dim or _NO_DIMENSION_BUCKET, []).append(seg_id)

    return all(any(seg_id in user_set for seg_id in bucket) for bucket in buckets.values())
