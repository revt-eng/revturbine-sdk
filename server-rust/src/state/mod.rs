//! Stateful machinery: pluggable storage and presentation-cap enforcement.
//!
//! Ported from `server-python/src/revturbine/core/state/`, itself a port of
//! `revturbine-scaffold/src/core/state/`. Trial status and the placement
//! resolver follow in the remaining slices of plan 185 TASK-7.

pub mod cap_enforcer;
pub mod impression_history;
pub mod impression_history_stores;
pub mod impression_history_types;
pub mod interaction;
pub mod interaction_tracker;
pub mod storage;

pub use cap_enforcer::{
    CapEnforcementResult, CapEnforcer, PlacementCapPolicy, PresentationCapState,
};
pub use impression_history::ImpressionHistory;
pub use impression_history_stores::InMemoryImpressionStore;
pub use impression_history_types::{
    ImpressionHistoryStore, ImpressionQuery, ImpressionRecord, DEFAULT_SUPPRESSION_MS,
    TERMINAL_OUTCOMES,
};
pub use interaction::{
    interaction_state_key, suppression_for_state, InteractionState, SuppressionResult,
};
pub use interaction_tracker::{
    InteractionTracker, TreatmentInteractionInput, CTA_SUPPRESSION_MS, DEFAULT_DISMISS_COOLDOWN_MS,
    DEFAULT_REMIND_LATER_MS,
};
pub use storage::{InMemoryStorage, RevTurbineStorage};
