//! Segment targeting for placement payloads (plan 233 TASK-7).
//!
//! Port of `core/rules/kinds/segment-eligibility.ts`. A payload's
//! `target.segment_chips` names the segments it is for.
//!
//! The browser SDK evaluated this only inside its diagnostic probe and nowhere
//! in the decision path, so a payload chipped to a segment the user is not in
//! rendered anyway. This port exists so the headless SDKs make the same
//! selection the browser SDK does — behaviour parity across languages is
//! required, not optional.

/// A payload's segment targeting, as authored.
///
/// `target_segment_chips` holds segment **handles**, not minted ids.
#[derive(Debug, Clone, Default)]
pub struct SegmentEligibilityRule {
    /// Segment handles the payload targets. Empty means "no segment filter".
    pub target_segment_chips: Vec<String>,
}

/// The user's resolved segment membership, as handles.
#[derive(Debug, Clone, Default)]
pub struct SegmentEligibilityContext {
    /// Segment handles the user currently belongs to.
    pub segment_ids: Vec<String>,
}

/// Outcome of [`evaluate_segment_eligibility`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentEligibilityOutcome {
    /// Whether the payload may be shown to this user.
    pub eligible: bool,
    /// Why not, when `eligible` is false. `Some("segment_mismatch")`.
    pub reason: Option<&'static str>,
}

/// Whether this payload's segment targeting admits this user.
///
/// - No chips → no filter; eligible for everyone.
/// - Chips present → the user must match **at least one** (OR-within).
/// - A chip naming a segment that does not exist matches nobody. That is
///   deliberate: silently ignoring an unknown chip is how a payload targeted at
///   a paying segment ends up shown to everyone.
///
/// The caller ANDs this with plan eligibility.
pub fn evaluate_segment_eligibility(
    cfg: &SegmentEligibilityRule,
    ctx: &SegmentEligibilityContext,
) -> SegmentEligibilityOutcome {
    if cfg.target_segment_chips.is_empty() {
        return SegmentEligibilityOutcome {
            eligible: true,
            reason: None,
        };
    }

    let matched = cfg
        .target_segment_chips
        .iter()
        .any(|chip| ctx.segment_ids.iter().any(|held| held == chip));

    if matched {
        SegmentEligibilityOutcome {
            eligible: true,
            reason: None,
        }
    } else {
        SegmentEligibilityOutcome {
            eligible: false,
            reason: Some("segment_mismatch"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(chips: &[&str]) -> SegmentEligibilityRule {
        SegmentEligibilityRule {
            target_segment_chips: chips.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    fn ctx(held: &[&str]) -> SegmentEligibilityContext {
        SegmentEligibilityContext {
            segment_ids: held.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    #[test]
    fn no_chips_admits_everyone() {
        assert!(evaluate_segment_eligibility(&rule(&[]), &ctx(&[])).eligible);
    }

    #[test]
    fn or_within() {
        assert!(evaluate_segment_eligibility(&rule(&["a", "b"]), &ctx(&["b"])).eligible);
    }

    #[test]
    fn mismatch_reports_reason() {
        let outcome = evaluate_segment_eligibility(&rule(&["a"]), &ctx(&["c"]));
        assert!(!outcome.eligible);
        assert_eq!(outcome.reason, Some("segment_mismatch"));
    }

    #[test]
    fn unknown_chip_matches_nobody() {
        assert!(!evaluate_segment_eligibility(&rule(&["typo"]), &ctx(&["a", "b"])).eligible);
    }

    #[test]
    fn exact_on_handles() {
        assert!(
            !evaluate_segment_eligibility(&rule(&["Power_Users"]), &ctx(&["power_users"])).eligible
        );
    }
}
