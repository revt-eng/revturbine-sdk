"""Python port of scaffold's ``trial-gating.ts`` shared evaluation.

Byte-faithful port of ``revturbine-scaffold/src/placements/controllers/
trial-gating.ts``. The TS file is the executable spec — every conditional
mirrors a TS branch so cross-language parity stays a true equivalence
check rather than a re-derivation. Keep the function bodies aligned
with the TS when either side changes.

Used by ``local_resolver.py`` to gate trial-trigger placements + apply
milestone supersession when multiple ``trial_progress`` candidates
share a template bucket. Plan 43 TASK-12.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict, TypeVar

# ── TrialTriggerShape — discriminated union (kind-keyed) ────────────────────


class TrialStartedTrigger(TypedDict):
    kind: Literal["trial_started"]


class TrialProgressTrigger(TypedDict):
    kind: Literal["trial_progress"]
    progress_percent: float


class TrialEndingTrigger(TypedDict):
    kind: Literal["trial_ending"]
    days_before_end: float


class TrialEndedTrigger(TypedDict):
    kind: Literal["trial_ended"]


class TrialConvertedTrigger(TypedDict):
    kind: Literal["trial_converted"]


TrialTriggerShape = (
    TrialStartedTrigger
    | TrialProgressTrigger
    | TrialEndingTrigger
    | TrialEndedTrigger
    | TrialConvertedTrigger
)


# ── TrialCandidate<TOutput> — minimal candidate record used by supersession ─

T = TypeVar("T")


class TrialCandidate(TypedDict):
    """Minimal candidate shape — placement id + normalized trigger.

    Source: trial-gating.ts:36-45
    """

    rule_id: str | None
    entry_order: int
    trial_trigger: TrialTriggerShape | None
    output: Any


# ── Pure helpers ────────────────────────────────────────────────────────────


def compute_user_elapsed_percent(plan: Any) -> float | None:
    """Universal elapsed-percent (0..100) read from PlanProvider state.

    Returns ``None`` when no trial is active, the trial is expired, or
    no progress data is available. Reads the universal
    ``trial_progress_percent`` first (set by
    ``derive_local_trial_status_from_instance`` for both modes); falls
    back to time-based math and usage-based math so pre-progress-percent
    payloads also work.

    Source: trial-gating.ts:58-76
    """
    if not isinstance(plan, dict):
        return None
    if plan.get("trial_active") is not True:
        return None
    if plan.get("trial_state") == "expired":
        return None

    pct = plan.get("trial_progress_percent")
    if isinstance(pct, (int, float)) and pct >= 0:
        return min(100.0, float(pct))

    total = plan.get("trial_days_total")
    remaining = plan.get("trial_days_remaining")
    if isinstance(total, (int, float)) and isinstance(remaining, (int, float)) and total > 0:
        elapsed = max(0.0, float(total) - float(remaining))
        return (elapsed / float(total)) * 100.0

    limit = plan.get("trial_usage_limit")
    consumed = plan.get("trial_usage_consumed")
    if isinstance(limit, (int, float)) and isinstance(consumed, (int, float)) and limit > 0:
        return min(100.0, max(0.0, (float(consumed) / float(limit)) * 100.0))

    return None


def matches_trial_trigger(trigger: Any, plan: Any) -> bool:
    """Decide whether a placement carrying a trial-specific trigger
    should be eligible right now, given the PlanProvider trial state.

    Non-trial triggers (passed as ``None``) always pass through.

    Source: trial-gating.ts:98-130
    """
    if trigger is None:
        return True
    if not isinstance(plan, dict):
        return False

    kind = trigger.get("kind")

    if kind == "trial_started":
        if plan.get("trial_active") is not True:
            return False
        pct = compute_user_elapsed_percent(plan)
        if pct is None:
            return False
        return pct <= 5

    if kind == "trial_progress":
        return (
            plan.get("trial_active") is True
            and plan.get("trial_state") != "expired"
            and plan.get("trial_state") != "converted"
        )

    if kind == "trial_ending":
        if plan.get("trial_active") is not True:
            return False
        if plan.get("trial_limit_type") == "usage":
            return False
        remaining = plan.get("trial_days_remaining")
        if not isinstance(remaining, (int, float)):
            return False
        return float(remaining) <= float(trigger.get("days_before_end", 0))

    if kind == "trial_ended":
        return plan.get("trial_state") == "expired"

    if kind == "trial_converted":
        return plan.get("trial_state") == "converted"

    return False


def apply_milestone_supersession(
    candidates: list[TrialCandidate],
    user_elapsed_percent: float,
) -> dict[str, Any] | None:
    """Among same-template candidates whose trigger is
    ``trial_progress``, picks the highest threshold the user has
    crossed and returns the lower-threshold siblings as
    ``superseded_ids`` for analytics.

    Returns ``None`` when the user has no usable elapsed-percent data
    or the candidate set contains zero crossed ``trial_progress``
    candidates. Pure function — does NOT mutate ImpressionHistory.

    Source: trial-gating.ts:146-175
    """

    def _progress_pct(c: TrialCandidate) -> float | None:
        trig = c.get("trial_trigger")
        if not isinstance(trig, dict) or trig.get("kind") != "trial_progress":
            return None
        val = trig.get("progress_percent")
        return float(val) if isinstance(val, (int, float)) else None

    progress_candidates = [c for c in candidates if _progress_pct(c) is not None]
    if not progress_candidates:
        return None

    crossed = [c for c in progress_candidates if user_elapsed_percent >= (_progress_pct(c) or 0.0)]
    if not crossed:
        return None

    def _pct(c: TrialCandidate) -> float:
        val = _progress_pct(c)
        return val if val is not None else -1.0

    winner = crossed[0]
    for c in crossed[1:]:
        c_pct = _pct(c)
        w_pct = _pct(winner)
        if c_pct > w_pct or (c_pct == w_pct and c["entry_order"] < winner["entry_order"]):
            winner = c

    superseded_ids = [
        c["rule_id"]
        for c in crossed
        if c is not winner and isinstance(c.get("rule_id"), str) and c["rule_id"]
    ]

    return {"winner": winner, "superseded_ids": superseded_ids}


def normalize_json_trigger(trigger: Any) -> TrialTriggerShape | None:
    """Normalize ExportedConfig's ``placement.trigger`` (``type``-keyed)
    into a ``TrialTriggerShape``. Non-trial trigger kinds return
    ``None`` — they pass through trial-gating untouched.

    Source: trial-gating.ts:215-241
    """
    if not isinstance(trigger, dict):
        return None
    ttype = trigger.get("type")
    if not isinstance(ttype, str):
        return None

    if ttype == "trial_started":
        return {"kind": "trial_started"}
    if ttype == "trial_progress":
        pct = trigger.get("progress_percent")
        if isinstance(pct, (int, float)):
            return {"kind": "trial_progress", "progress_percent": float(pct)}
        return None
    if ttype == "trial_ending":
        days = trigger.get("days_before_end")
        if isinstance(days, (int, float)):
            return {"kind": "trial_ending", "days_before_end": float(days)}
        return None
    if ttype == "trial_ended":
        return {"kind": "trial_ended"}
    if ttype == "trial_converted":
        return {"kind": "trial_converted"}
    return None


__all__ = [
    "TrialTriggerShape",
    "TrialCandidate",
    "compute_user_elapsed_percent",
    "matches_trial_trigger",
    "apply_milestone_supersession",
    "normalize_json_trigger",
]
