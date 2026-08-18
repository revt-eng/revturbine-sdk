//! Pure rule predicates ported from `@revt-eng/core/rules/kinds/`.
//!
//! Only the predicates are ported — the `RuleModule` wrappers and the
//! rule-kind registry are not, matching the Python port's scope.

pub mod plan_eligibility;

pub use plan_eligibility::{
    evaluate_plan_eligibility, PlanEligibilityContext, PlanEligibilityOutcome,
    PlanEligibilityReason, PlanEligibilityRule,
};
