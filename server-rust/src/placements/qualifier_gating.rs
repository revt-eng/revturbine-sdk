//! Qualifier eligibility.
//!
//! Qualifiers are **category-specific**: one used outside its category never
//! matches. The map below is ported verbatim from scaffold's
//! `QUALIFIERS_BY_CATEGORY` — the non-TS ports have no access to the Zod
//! schema that defines it.
//!
//! Source: revturbine-scaffold/src/placements/controllers/qualifier-gating.ts

use serde_json::Value;

/// Category → the qualifiers it offers. Verbatim from scaffold's
/// `placements/models/schema.ts`.
pub const QUALIFIERS_BY_CATEGORY: &[(&str, &[&str])] = &[
    (
        "other_conversion",
        &["none_always_on", "overage_vs_upgrade", "time_bound"],
    ),
    ("retention", &["payment_failed", "payment_at_risk"]),
];

/// A qualifier trigger.
#[derive(Debug, Clone, PartialEq)]
pub struct QualifierTrigger {
    /// The qualifier to evaluate.
    pub qualifier: String,
}

/// Qualifiers offered for a category — empty when it carries none.
#[must_use]
pub fn qualifiers_for_category(category: &str) -> &'static [&'static str] {
    QUALIFIERS_BY_CATEGORY
        .iter()
        .find(|(c, _)| *c == category)
        .map_or(&[], |(_, qs)| *qs)
}

/// Whether a qualifier may be used on a placement of this category.
#[must_use]
pub fn is_qualifier_valid_for_category(qualifier: &str, category: &str) -> bool {
    qualifiers_for_category(category).contains(&qualifier)
}

/// Whether a qualifier-triggered placement is eligible.
///
/// Non-qualifier triggers pass through. A **cross-category** qualifier never
/// matches. Within its category:
///
/// - `none_always_on` — always passes.
/// - `payment_failed` / `payment_at_risk` — fire only on an explicit `true`,
///   so they **fail closed** on absent billing state. Showing a
///   payment-recovery prompt to someone whose billing state is simply unknown
///   is worse than not showing it.
/// - `overage_vs_upgrade` / `time_bound` — not yet evaluable, so they **pass
///   through** rather than fail closed. These gate ordinary conversion
///   surfaces, where the cost of an unnecessary prompt is low and failing
///   closed would silently disable every placement using them.
///
/// Source: qualifier-gating.ts matchesQualifierTrigger
#[must_use]
pub fn matches_qualifier_trigger(
    trigger: Option<&QualifierTrigger>,
    category: &str,
    plan: Option<&Value>,
) -> bool {
    let Some(trigger) = trigger else {
        return true;
    };
    if !is_qualifier_valid_for_category(&trigger.qualifier, category) {
        return false;
    }

    let flag = |key: &str| {
        plan.and_then(|p| p.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };

    match trigger.qualifier.as_str() {
        "none_always_on" => true,
        "payment_failed" => flag("payment_failed"),
        "payment_at_risk" => flag("payment_at_risk"),
        // overage_vs_upgrade / time_bound — not yet determinable.
        _ => true,
    }
}
