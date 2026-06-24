"""Plan-eligibility rule — Python port of the pure predicate from
@revt-eng/core/rules/kinds/plan-eligibility.ts.

Only ``evaluate_plan_eligibility`` (the pure predicate) and its three
value types are ported. The ``RuleModule`` wrapper
(``planEligibilityRuleModule``) and the rule-kind registry are NOT
ported here — server-python has no rules registry yet — so this module
stays a self-contained predicate the static placement resolver calls.

Behavior preserved verbatim from the TS source:
  1. Target plan list — if non-empty and the user's plan is set but not
     in it → ineligible (``plan_mismatch``).
  2. Target billing-period list — same shape → ``billing_period_mismatch``.
  3. ``upsell`` / ``trial_conversion`` categories are suppressed for the
     ``enterprise`` plan handle → ``enterprise_upsell_suppressed``.

The TS ``PlanEligibilityRuleSchema`` is a Zod object whose
``target_plan_ids`` / ``target_billing_periods`` carry ``.default([])``.
That default is folded into the predicate here: an absent or ``None``
array is treated as empty, so callers may pass a partially-populated
mapping and get the same result the schema-parsed TS input would.

Source: revturbine-scaffold/src/core/rules/kinds/plan-eligibility.ts
"""

from __future__ import annotations

from typing import Literal, TypedDict

__all__ = [
    "PlanEligibilityContext",
    "PlanEligibilityOutcome",
    "PlanEligibilityRule",
    "evaluate_plan_eligibility",
]


class PlanEligibilityRule(TypedDict, total=False):
    """Per-payload eligibility config. Mirrors the fields the legacy
    closure reads off ``PlacementOutput.content.__target_plan_ids`` /
    ``__target_billing_periods`` and ``PlacementOutput.category``.

    All keys are optional (``total=False``) — a missing array reads as
    "applies to all" exactly like the Zod ``.default([])``.

    Source: plan-eligibility.ts:26-42
    """

    target_plan_ids: list[str]
    target_billing_periods: list[str]
    # ``str | None`` mirrors the TS ``category?: string`` (``string |
    # undefined``) and lets callers pass an unset category as ``None``.
    category: str | None


class PlanEligibilityContext(TypedDict, total=False):
    """User context evaluated against a ``PlanEligibilityRule``. TS types
    each field as ``string | undefined``; the Python port makes them
    optional keys (``total=False``) whose value may also be ``None`` so
    a resolver can pass an unresolved field through verbatim.

    Source: plan-eligibility.ts:44-48
    """

    current_plan_id: str | None
    plan_handle: str | None
    billing_period: str | None


class _PlanEligibilityOutcomeRequired(TypedDict):
    eligible: bool


class PlanEligibilityOutcome(_PlanEligibilityOutcomeRequired, total=False):
    """Predicate result. ``reason`` is present only when ineligible.

    Source: plan-eligibility.ts:50-53
    """

    reason: Literal[
        "plan_mismatch",
        "billing_period_mismatch",
        "enterprise_upsell_suppressed",
    ]


def evaluate_plan_eligibility(
    cfg: PlanEligibilityRule,
    ctx: PlanEligibilityContext,
) -> PlanEligibilityOutcome:
    """Pure predicate. Mirrors ``isEligibleForPlan`` in
    placements/controllers/local-resolver.ts via the TS
    ``evaluatePlanEligibility``.

    Source: plan-eligibility.ts:60-86
    """
    target_plan_ids = cfg.get("target_plan_ids") or []
    current_plan_id = ctx.get("current_plan_id")
    if len(target_plan_ids) > 0 and current_plan_id and current_plan_id not in target_plan_ids:
        return {"eligible": False, "reason": "plan_mismatch"}

    target_billing_periods = cfg.get("target_billing_periods") or []
    billing_period = ctx.get("billing_period")
    if (
        len(target_billing_periods) > 0
        and billing_period
        and billing_period not in target_billing_periods
    ):
        return {"eligible": False, "reason": "billing_period_mismatch"}

    category = cfg.get("category")
    is_upsell = category == "upsell" or category == "trial_conversion"
    if is_upsell and ctx.get("plan_handle") == "enterprise":
        return {"eligible": False, "reason": "enterprise_upsell_suppressed"}

    return {"eligible": True}
