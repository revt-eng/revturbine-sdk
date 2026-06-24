"""revturbine.core.rules — Python port of @revt-eng/core/rules/.

TASK-5 batch 2c ports only the pure ``plan-eligibility`` predicate
(``evaluate_plan_eligibility``) and its value types — the closure the
static placement resolver depends on. The ``RuleModule`` registry
abstraction (``planEligibilityRuleModule`` and the kind registry) is
deliberately out of scope here; it lands with the rules-registry port
in a later task.
"""

from revturbine.core.rules.plan_eligibility import (
    PlanEligibilityContext,
    PlanEligibilityOutcome,
    PlanEligibilityRule,
    evaluate_plan_eligibility,
)

__all__ = [
    "PlanEligibilityContext",
    "PlanEligibilityOutcome",
    "PlanEligibilityRule",
    "evaluate_plan_eligibility",
]
