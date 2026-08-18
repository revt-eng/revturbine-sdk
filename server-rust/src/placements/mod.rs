//! Placement gating and resolution.
//!
//! Ports the four **gating** predicates — the questions asked of a
//! candidate placement before it is eligible to be shown. The resolver that
//! consumes them (`payload_resolution`, `local_resolver`, `placement_decision`)
//! follows in the next slice of plan 185 TASK-7.
//!
//! Every gate takes `None` for its trigger to mean "not my kind of trigger,
//! pass through" — that is what lets a caller run all four over any placement
//! without first classifying it.

pub mod entitlement_gate_gating;
pub mod local_resolver;
pub mod payload_resolution;
pub mod qualifier_gating;
pub mod static_resolver;
pub mod threshold_gating;
pub mod trial_gating;

pub use entitlement_gate_gating::{matches_entitlement_gate_trigger, EntitlementGateTrigger};
pub use local_resolver::{
    decision_content, header_str, is_finite_number, normalize_cta_path,
    read_entitlement_handle_from_trigger, read_json_entitlement_gate_trigger,
    read_json_qualifier_trigger, read_json_threshold_trigger, read_slot_id_from_trigger,
};
pub use payload_resolution::{
    apply_value_maps, js_string, resolve_content, resolve_payload_for_user, resolve_tokens,
    ResolvedPayload,
};
pub use qualifier_gating::{
    is_qualifier_valid_for_category, matches_qualifier_trigger, qualifiers_for_category,
    QualifierTrigger, QUALIFIERS_BY_CATEGORY,
};
pub use static_resolver::{
    interpolate_content_tokens, interpolate_string_tokens, StaticPlacementResolver,
};
pub use threshold_gating::{compute_consumed_percent, matches_threshold_trigger, ThresholdTrigger};
pub use trial_gating::{
    apply_milestone_supersession, compute_user_elapsed_percent, matches_trial_trigger,
    normalize_json_trigger, MilestoneOutcome, TrialCandidate, TrialTrigger,
};
