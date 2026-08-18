//! Plan-eligibility rule — the pure predicate.
//!
//! Only the predicate and its value types are ported. The `RuleModule` wrapper
//! and the rule-kind registry are not — this stays a self-contained predicate
//! the static placement resolver calls, exactly as in the Python port.
//!
//! Behaviour preserved verbatim from the TypeScript:
//!  1. Target plan list — if non-empty and the user's plan is set but not in
//!     it → ineligible (`plan_mismatch`).
//!  2. Target billing-period list — same shape → `billing_period_mismatch`.
//!  3. `upsell` / `trial_conversion` categories are suppressed for the
//!     `enterprise` plan handle → `enterprise_upsell_suppressed`.
//!
//! The TS `PlanEligibilityRuleSchema` gives `target_plan_ids` /
//! `target_billing_periods` a Zod `.default([])`. That default is folded into
//! the predicate here: an absent or empty array is treated as "applies to
//! all", so callers may pass a partially-populated config and get the same
//! result a schema-parsed TS input would.
//!
//! Source: revturbine-scaffold/src/core/rules/kinds/plan-eligibility.ts

/// Per-payload eligibility config.
///
/// Every field is optional — a missing array reads as "applies to all",
/// exactly like the Zod `.default([])`.
///
/// Source: plan-eligibility.ts:26-42
#[derive(Debug, Clone, Default)]
pub struct PlanEligibilityRule {
    /// Plans this payload applies to. Empty = all plans.
    pub target_plan_ids: Vec<String>,
    /// Billing periods this payload applies to. Empty = all periods.
    pub target_billing_periods: Vec<String>,
    /// Payload category; `upsell` / `trial_conversion` are suppressed for
    /// enterprise.
    pub category: Option<String>,
}

/// User context evaluated against a [`PlanEligibilityRule`].
///
/// Source: plan-eligibility.ts:44-48
#[derive(Debug, Clone, Default)]
pub struct PlanEligibilityContext {
    /// The user's plan id. Unset passes any target list.
    pub current_plan_id: Option<String>,
    /// The user's plan handle, used for the enterprise suppression check.
    pub plan_handle: Option<String>,
    /// The user's billing period. Unset passes any target list.
    pub billing_period: Option<String>,
}

/// Why a payload was ruled ineligible.
///
/// Source: plan-eligibility.ts:50-53
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanEligibilityReason {
    /// The user's plan is not in the payload's target list.
    PlanMismatch,
    /// The user's billing period is not in the payload's target list.
    BillingPeriodMismatch,
    /// An upsell payload suppressed for the `enterprise` plan.
    EnterpriseUpsellSuppressed,
}

impl PlanEligibilityReason {
    /// The wire spelling, matching the TS string-literal union.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PlanMismatch => "plan_mismatch",
            Self::BillingPeriodMismatch => "billing_period_mismatch",
            Self::EnterpriseUpsellSuppressed => "enterprise_upsell_suppressed",
        }
    }
}

/// Predicate result. `reason` is present only when ineligible.
///
/// Source: plan-eligibility.ts:50-53
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanEligibilityOutcome {
    /// Whether the payload may be shown.
    pub eligible: bool,
    /// Why not, when ineligible.
    pub reason: Option<PlanEligibilityReason>,
}

/// Pure predicate.
///
/// Note the guard shape on each check: a non-empty target list only excludes
/// when the user's corresponding field is **set**. An unset plan or billing
/// period passes through rather than being ruled out — that asymmetry is
/// deliberate in the TS and is what lets an unresolved context stay eligible.
///
/// Source: plan-eligibility.ts:60-86 (evaluatePlanEligibility)
#[must_use]
pub fn evaluate_plan_eligibility(
    cfg: &PlanEligibilityRule,
    ctx: &PlanEligibilityContext,
) -> PlanEligibilityOutcome {
    if !cfg.target_plan_ids.is_empty() {
        if let Some(plan_id) = ctx.current_plan_id.as_ref().filter(|s| !s.is_empty()) {
            if !cfg.target_plan_ids.contains(plan_id) {
                return PlanEligibilityOutcome {
                    eligible: false,
                    reason: Some(PlanEligibilityReason::PlanMismatch),
                };
            }
        }
    }

    if !cfg.target_billing_periods.is_empty() {
        if let Some(period) = ctx.billing_period.as_ref().filter(|s| !s.is_empty()) {
            if !cfg.target_billing_periods.contains(period) {
                return PlanEligibilityOutcome {
                    eligible: false,
                    reason: Some(PlanEligibilityReason::BillingPeriodMismatch),
                };
            }
        }
    }

    let is_upsell = matches!(cfg.category.as_deref(), Some("upsell" | "trial_conversion"));
    if is_upsell && ctx.plan_handle.as_deref() == Some("enterprise") {
        return PlanEligibilityOutcome {
            eligible: false,
            reason: Some(PlanEligibilityReason::EnterpriseUpsellSuppressed),
        };
    }

    PlanEligibilityOutcome {
        eligible: true,
        reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn empty_targets_apply_to_all() {
        let out = evaluate_plan_eligibility(
            &PlanEligibilityRule::default(),
            &PlanEligibilityContext {
                current_plan_id: Some("anything".into()),
                ..Default::default()
            },
        );
        assert!(out.eligible);
        assert_eq!(out.reason, None);
    }

    #[test]
    fn plan_mismatch_excludes() {
        let cfg = PlanEligibilityRule {
            target_plan_ids: v(&["pro"]),
            ..Default::default()
        };
        let out = evaluate_plan_eligibility(
            &cfg,
            &PlanEligibilityContext {
                current_plan_id: Some("starter".into()),
                ..Default::default()
            },
        );
        assert!(!out.eligible);
        assert_eq!(out.reason, Some(PlanEligibilityReason::PlanMismatch));
    }

    #[test]
    fn plan_match_is_eligible() {
        let cfg = PlanEligibilityRule {
            target_plan_ids: v(&["pro", "enterprise"]),
            ..Default::default()
        };
        assert!(
            evaluate_plan_eligibility(
                &cfg,
                &PlanEligibilityContext {
                    current_plan_id: Some("pro".into()),
                    ..Default::default()
                }
            )
            .eligible
        );
    }

    #[test]
    fn unset_plan_passes_a_non_empty_target_list() {
        // The deliberate asymmetry: targeting only EXCLUDES when the user's
        // field is set. An unresolved plan stays eligible.
        let cfg = PlanEligibilityRule {
            target_plan_ids: v(&["pro"]),
            ..Default::default()
        };
        assert!(evaluate_plan_eligibility(&cfg, &PlanEligibilityContext::default()).eligible);
    }

    #[test]
    fn billing_period_mismatch_excludes() {
        let cfg = PlanEligibilityRule {
            target_billing_periods: v(&["annual"]),
            ..Default::default()
        };
        let out = evaluate_plan_eligibility(
            &cfg,
            &PlanEligibilityContext {
                billing_period: Some("monthly".into()),
                ..Default::default()
            },
        );
        assert!(!out.eligible);
        assert_eq!(
            out.reason,
            Some(PlanEligibilityReason::BillingPeriodMismatch)
        );
    }

    #[test]
    fn enterprise_suppresses_upsell_categories() {
        for category in ["upsell", "trial_conversion"] {
            let cfg = PlanEligibilityRule {
                category: Some(category.into()),
                ..Default::default()
            };
            let out = evaluate_plan_eligibility(
                &cfg,
                &PlanEligibilityContext {
                    plan_handle: Some("enterprise".into()),
                    ..Default::default()
                },
            );
            assert!(!out.eligible, "{category} should be suppressed");
            assert_eq!(
                out.reason,
                Some(PlanEligibilityReason::EnterpriseUpsellSuppressed)
            );
        }
    }

    #[test]
    fn enterprise_does_not_suppress_other_categories() {
        let cfg = PlanEligibilityRule {
            category: Some("announcement".into()),
            ..Default::default()
        };
        assert!(
            evaluate_plan_eligibility(
                &cfg,
                &PlanEligibilityContext {
                    plan_handle: Some("enterprise".into()),
                    ..Default::default()
                }
            )
            .eligible
        );
    }

    #[test]
    fn upsell_is_fine_for_non_enterprise_plans() {
        let cfg = PlanEligibilityRule {
            category: Some("upsell".into()),
            ..Default::default()
        };
        assert!(
            evaluate_plan_eligibility(
                &cfg,
                &PlanEligibilityContext {
                    plan_handle: Some("pro".into()),
                    ..Default::default()
                }
            )
            .eligible
        );
    }

    #[test]
    fn plan_check_precedes_billing_and_category() {
        // Order matters for the reported reason when several would fail.
        let cfg = PlanEligibilityRule {
            target_plan_ids: v(&["pro"]),
            target_billing_periods: v(&["annual"]),
            category: Some("upsell".into()),
        };
        let out = evaluate_plan_eligibility(
            &cfg,
            &PlanEligibilityContext {
                current_plan_id: Some("starter".into()),
                plan_handle: Some("enterprise".into()),
                billing_period: Some("monthly".into()),
            },
        );
        assert_eq!(out.reason, Some(PlanEligibilityReason::PlanMismatch));
    }

    #[test]
    fn reason_wire_spellings_match_the_typescript_union() {
        assert_eq!(
            PlanEligibilityReason::PlanMismatch.as_str(),
            "plan_mismatch"
        );
        assert_eq!(
            PlanEligibilityReason::BillingPeriodMismatch.as_str(),
            "billing_period_mismatch"
        );
        assert_eq!(
            PlanEligibilityReason::EnterpriseUpsellSuppressed.as_str(),
            "enterprise_upsell_suppressed"
        );
    }
}
