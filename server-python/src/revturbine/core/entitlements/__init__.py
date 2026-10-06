"""revturbine.core.entitlements — Python port of
`@revt-eng/entitlements/controllers/`.

Faithful 1:1 translations of the plan-32/34-reconciled TS evaluators
(no behavior change — parity = Python ≡ TS):

- ``rules`` — ``find_matching_entitlement_rule`` (most-permissive
  selection over the Rules provider snapshot; §2.6.5) +
  ``evaluate_entitlement_rules`` / ``evaluate_plan_rules``.
- ``entitlement_check`` — ``derive_local_entitlement_from_configured_rules``
  (the shared Playbook + user-context evaluator) + enforcement-mode mapping.
- ``effective_entitlement`` — the ONE effective answer every runtime uses
  (D-61): the shared evaluator merged with app-mirrored data
  (``derive_effective_entitlement`` / ``derive_effective_entitlements``),
  plus the shared ``reverse_trial_grants`` helper.
"""

from revturbine.core.entitlements.effective_entitlement import (
    AppEntitlementInputs,
    EffectiveEntitlement,
    EffectiveEntitlementBase,
    EntitlementMergeField,
    EntitlementMergeOptions,
    EntitlementSource,
    MirroredEntitlement,
    ReverseTrialGrants,
    ReverseTrialView,
    app_entitlement,
    derive_effective_entitlement,
    derive_effective_entitlements,
    merge_entitlement_results,
    reverse_trial_grants,
)
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
    "AppEntitlementInputs",
    "EffectiveEntitlement",
    "EffectiveEntitlementBase",
    "EntitlementMergeField",
    "EntitlementMergeOptions",
    "EntitlementRuleEvaluation",
    "EntitlementSource",
    "MirroredEntitlement",
    "ReverseTrialGrants",
    "ReverseTrialView",
    "RuleEvaluationContext",
    "app_entitlement",
    "derive_effective_entitlement",
    "derive_effective_entitlements",
    "derive_local_entitlement_from_configured_rules",
    "evaluate_entitlement_rules",
    "evaluate_plan_rules",
    "find_matching_entitlement_rule",
    "merge_entitlement_results",
    "reverse_trial_grants",
]
