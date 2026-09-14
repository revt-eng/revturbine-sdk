"""Segment targeting for placement payloads (plan 233 TASK-7).

Port of ``core/rules/kinds/segment-eligibility.ts``. A payload's
``target.segment_chips`` names the segments it is for.

The browser SDK evaluated this only inside its diagnostic probe and nowhere in
the decision path, so a payload chipped to a segment the user is not in rendered
anyway. This port exists so the headless SDKs make the same selection the
browser SDK does — behaviour parity across languages is required, not optional.

Source: core/rules/kinds/segment-eligibility.ts
"""

from __future__ import annotations

from typing import Literal, TypedDict


class SegmentEligibilityRule(TypedDict):
    """A payload's segment targeting, as authored.

    ``target_segment_chips`` holds segment **handles**, not minted ids.
    """

    target_segment_chips: list[str]


class SegmentEligibilityContext(TypedDict):
    """The user's resolved segment membership, as handles."""

    segment_ids: list[str]


class SegmentEligibilityOutcome(TypedDict, total=False):
    eligible: bool
    reason: Literal["segment_mismatch"]


def evaluate_segment_eligibility(
    cfg: SegmentEligibilityRule,
    ctx: SegmentEligibilityContext,
) -> SegmentEligibilityOutcome:
    """Whether this payload's segment targeting admits this user.

    - No chips -> no filter; eligible for everyone.
    - Chips present -> the user must match **at least one** (OR-within).
    - A chip naming a segment that does not exist matches nobody. That is
      deliberate: silently ignoring an unknown chip is how a payload targeted at
      a paying segment ends up shown to everyone.

    The caller ANDs this with plan eligibility.

    Source: segment-eligibility.ts:evaluateSegmentEligibility
    """
    if not cfg["target_segment_chips"]:
        return {"eligible": True}

    member = set(ctx["segment_ids"])
    matched = any(chip in member for chip in cfg["target_segment_chips"])

    if matched:
        return {"eligible": True}
    return {"eligible": False, "reason": "segment_mismatch"}
