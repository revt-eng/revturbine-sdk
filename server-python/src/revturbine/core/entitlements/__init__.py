"""revturbine.core.entitlements — Python port of
`@revt-eng/entitlements/controllers/`.

Faithful 1:1 translations of the plan-32/34-reconciled TS evaluators
(no behavior change — parity = Python ≡ TS):

- ``rules`` — ``find_matching_entitlement_rule`` (most-permissive
  selection over the Rules provider snapshot; §2.6.5) +
  ``evaluate_entitlement_rules`` / ``evaluate_plan_rules``.
- ``entitlement_check`` — ``derive_local_entitlement_from_configured_rules``
  (first-match over raw ExportedConfig; the LocalRuntime fallback
  wired by plan 33 TASK-6's leaf) + enforcement-mode mapping.
"""

from revturbine.core.entitlements.entitlement_check import (
    derive_local_entitlement_from_configured_rules,
)
from revturbine.core.entitlements.rules import (
    EntitlementRuleEvaluation,
    RuleEvaluationContext,
    evaluate_entitlement_rules,
    evaluate_plan_rules,
    find_matching_entitlement_rule,
)

__all__ = [
    "EntitlementRuleEvaluation",
    "RuleEvaluationContext",
    "derive_local_entitlement_from_configured_rules",
    "evaluate_entitlement_rules",
    "evaluate_plan_rules",
    "find_matching_entitlement_rule",
]
