//! `RevTurbineCustomerSdk` — the public headless server SDK.
//!
//! A stateless, in-memory wrapper over the parity-locked decision substrate.
//! Constructed from exactly a **user context** plus a **Playbook** — both
//! supplied by the caller, because the server holds them and this SDK fetches
//! and persists nothing — it exposes the two server-side decision
//! capabilities:
//!
//! - [`RevTurbineCustomerSdk::check_entitlement`]
//! - [`RevTurbineCustomerSdk::get_placement_decision`] /
//!   [`get_placement_decisions`](RevTurbineCustomerSdk::get_placement_decisions)
//!
//! It composes [`create_static_providers`] → [`LocalRuntime`] and adds **zero**
//! decision logic of its own. Every method is a pure delegation, so its output
//! is byte-identical to `LocalRuntime`'s and the cross-language parity gate
//! stays green by construction.
//!
//! Out of scope, and intentionally absent (plan 33 REQ-14, inherited by plan
//! 185 REQ-2): `identify`, dismiss/snooze/convert, treatment-interaction
//! tracking, `capture`, `bootstrap_placement_decisions`, decision-cache and
//! interaction-state hydration, HTTP-backed dual-mode dispatch, and
//! segment/personalization-token derivation from raw traits.
//!
//! Source: `server-python/src/revturbine/sdk.py`

use serde_json::{json, Map, Value};

use crate::adapters::{create_static_providers, StaticProviderOptions};
use crate::config::parse_playbook_or_throw;
use crate::decisions::EntitlementCheckResult;
use crate::runtime::{LocalRuntime, PlacementDecisionInput};

/// The server-supplied user context.
///
/// Plan and usage are supplied at construction and never fetched — that is the
/// headless model. Segment-targeted rules are matched against **pre-resolved**
/// segment ids inside the evaluator; this SDK does not derive segments from
/// raw traits (a REQ-14 non-goal).
#[derive(Debug, Clone, Default)]
pub struct UserContext {
    /// Required. The tenant this decision belongs to.
    pub tenant_id: String,
    /// Required. The acting user.
    pub user_id: String,
    /// The user's current plan handle.
    pub plan_handle: Option<String>,
    /// Display name; defaults to the handle.
    pub plan_name: Option<String>,
    /// Per-entitlement `{used, limit}` overrides.
    pub usage: Option<Value>,
    /// Already-derived trial state (the runtime `UserTrialStatus` shape).
    /// Overlaid onto the plan provider so trial-trigger placements evaluate.
    pub trial_status: Option<Value>,
    /// Billing-recovery signal for the retention qualifiers.
    pub payment_failed: Option<bool>,
    /// Billing-recovery signal for the retention qualifiers.
    pub payment_at_risk: Option<bool>,
    /// Current tier per `capability_tier` entitlement, for the tier gate.
    pub tiers: Option<Value>,
}

/// The public, stateless, in-memory headless server SDK.
///
/// Construct one per `(user_context, playbook)` — it carries no cross-user
/// state, so a fresh instance per user context is the intended usage.
pub struct RevTurbineCustomerSdk {
    runtime: LocalRuntime,
}

/// Map a `UserTrialStatus` onto the `trial_*` plan-provider fields the trial
/// gates read. Without this every `trial_*` gate reads "no trial" and declines.
fn overlay_trial(plan: &mut Map<String, Value>, trial: &Map<String, Value>) {
    for (from, to) in [
        ("in_trial", "trial_active"),
        ("state", "trial_state"),
        ("trial_limit_type", "trial_limit_type"),
        ("progress_percent", "trial_progress_percent"),
        ("days_remaining", "trial_days_remaining"),
        ("day_number", "trial_day_number"),
        ("usage_limit", "trial_usage_limit"),
        ("usage_consumed", "trial_usage_consumed"),
    ] {
        if let Some(v) = trial.get(from).filter(|v| !v.is_null()) {
            plan.insert(to.to_string(), v.clone());
        }
    }
}

impl RevTurbineCustomerSdk {
    /// Construct from a user context and a Playbook.
    ///
    /// The Playbook goes through the dual-read boundary, so a canonical or a
    /// known-legacy artifact both work. A malformed one is an **error, not a
    /// degraded decision** — a partially-understood Playbook can silently
    /// over-grant.
    pub fn new(user_context: &UserContext, playbook: &Value) -> Result<Self, String> {
        let config = parse_playbook_or_throw(Some(playbook), "playbook", None)?
            .ok_or_else(|| "Invalid playbook: expected an artifact, got null".to_string())?;

        let opts = StaticProviderOptions {
            plan_handle: user_context.plan_handle.clone(),
            plan_name: user_context.plan_name.clone(),
            usage: user_context.usage.clone(),
            payment_failed: user_context.payment_failed,
            payment_at_risk: user_context.payment_at_risk,
            tiers: user_context.tiers.clone(),
            ..Default::default()
        };
        let mut providers = create_static_providers(&config, &opts);

        if let Some(trial) = user_context
            .trial_status
            .as_ref()
            .and_then(Value::as_object)
        {
            let plan = providers
                .as_object_mut()
                .expect("provider context is an object")
                .entry("plan")
                .or_insert_with(|| json!({}));
            if let Some(p) = plan.as_object_mut() {
                overlay_trial(p, trial);
            }
        }

        Ok(Self {
            runtime: LocalRuntime::new(
                config,
                providers,
                &user_context.tenant_id,
                &user_context.user_id,
            ),
        })
    }

    /// Is a feature or limit allowed for this user?
    #[must_use]
    pub fn check_entitlement(
        &self,
        handle: &str,
        context: Option<&Value>,
    ) -> EntitlementCheckResult {
        self.runtime.check_entitlement(handle, context)
    }

    /// Which placement payload, if any, should this user see?
    pub fn get_placement_decision(&mut self, input: &PlacementDecisionInput) -> Value {
        self.runtime.get_placement_decision(input)
    }

    /// The batch form. Order is preserved — it is decision-semantic.
    pub fn get_placement_decisions(&mut self, inputs: &[PlacementDecisionInput]) -> Vec<Value> {
        self.runtime.get_placement_decisions(inputs)
    }

    /// Resolve the winning placement for a surface slot.
    pub fn get_placement(&mut self, config: &Value) -> Option<Value> {
        self.runtime.get_placement(config)
    }

    /// Escape hatch to the underlying runtime, for callers that need a
    /// capability this façade does not re-export.
    #[must_use]
    pub fn runtime(&mut self) -> &mut LocalRuntime {
        &mut self.runtime
    }
}
