//! `RevTurbineCustomerSdk` — the public headless server SDK.
//!
//! A stateless, in-memory wrapper over the parity-locked decision substrate.
//! Constructed from exactly a **user context** plus a **Playbook** — both
//! supplied by the caller, because the server holds them and this SDK fetches
//! and persists nothing — it exposes the server-side decision surfaces:
//!
//! - [`RevTurbineCustomerSdk::check_entitlement`] (alias
//!   [`can`](RevTurbineCustomerSdk::can))
//! - [`RevTurbineCustomerSdk::get_placement_decision`] /
//!   [`get_placement_decisions`](RevTurbineCustomerSdk::get_placement_decisions)
//! - [`RevTurbineCustomerSdk::get_eligible_plans`] /
//!   [`get_eligible_addons`](RevTurbineCustomerSdk::get_eligible_addons)
//! - [`RevTurbineCustomerSdk::evaluate_trial_status`]
//!
//! The minor-unit display formatter that renders catalog prices is a free
//! function, [`crate::format_currency_minor_units`], because the Python port
//! exposes it as a module function rather than a method.
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

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::adapters::{create_static_providers, StaticProviderOptions};
use crate::config::{parse_playbook_or_throw, LegacyConfigTargetDefaults};
use crate::decisions::EntitlementCheckResult;
use crate::plans::{get_eligible_addons, get_eligible_plans, EligibleAddon, EligiblePlan};
use crate::runtime::{LocalRuntime, PlacementDecisionInput};
use crate::trials::{evaluate_trial_status, TrialEvaluation};

const PRODUCTION_ENVIRONMENT_ID: &str = "production";

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
    /// Pre-resolved segment ids for catalog eligibility. Entitlement rules take
    /// their segment ids from the provider context; the catalog surfaces
    /// ([`RevTurbineCustomerSdk::get_eligible_plans`] /
    /// [`get_eligible_addons`](RevTurbineCustomerSdk::get_eligible_addons))
    /// read them from here, mirroring `UserContext["segment_ids"]` on the
    /// Python port.
    pub segment_ids: Option<Vec<String>>,
}

/// The public, stateless, in-memory headless server SDK.
///
/// Construct one per `(user_context, playbook)` — it carries no cross-user
/// state, so a fresh instance per user context is the intended usage.
pub struct RevTurbineCustomerSdk {
    runtime: LocalRuntime,
    /// The normalized Playbook, retained for the config-reading surfaces
    /// (catalog eligibility and trial-rule evaluation) that read arrays the
    /// runtime does not re-expose.
    playbook: Value,
    segment_ids: Vec<String>,
}

/// Overlay a runtime `UserTrialStatus` onto the `trial_*` fields of a resolved
/// PlanProviderState, in place.
///
/// This is the crate-side counterpart of Python's
/// `revturbine.sdk._overlay_trial_status_on_plan_provider` /
/// `_TrialOverlayPlanProvider.resolve`, itself a port of the TS canonical
/// `synthesizeProviderContext`'s `planTrialFields`
/// (`web-sdk/customer-side.ts`). The placement resolver's `trial_progress` /
/// `trial_ending` / `trial_ended` / `trial_converted` gates and milestone
/// supersession all read these fields (see
/// [`crate::placements::trial_gating`]); without the overlay every `trial_*`
/// gate reads "no trial" and silently declines.
///
/// **Upsert semantics.** Only fields the patch DEFINES are written: an absent
/// or explicitly `null` member leaves whatever the base state already carried
/// untouched, and is not materialized as a key. That is the same
/// non-clobbering rule the TS `mergeUserContext` and Python's
/// `_TrialOverlayPlanProvider` follow.
///
/// `trial_days_total` is DERIVED (`day_number + days_remaining`) and only when
/// both are present — the time-mode progress fallback in
/// [`crate::placements::trial_gating`] reads it, and there is no
/// `trial_day_number` field on the provider state for `day_number` to land on.
///
/// The shape differs from Python's by language idiom only: Python wraps the
/// plan `DomainProvider` and merges at `resolve()` time, while the Rust
/// provider context is already a plain JSON map, so this mutates the `plan`
/// entry directly. The field mapping is the parity-relevant part and is
/// identical.
///
/// Parity fixtures locking this: `tests/parity/fixtures/trial_ending_days_before_end.json`,
/// `trial_ended_post_expiry.json` and `trial_progress_milestone_supersession.json`.
///
/// Source: `server-python/src/revturbine/sdk.py` `_TrialOverlayPlanProvider`.
pub fn overlay_trial_status_on_plan_provider(
    plan: &mut Map<String, Value>,
    trial_status: &Map<String, Value>,
) {
    let defined = |key: &str| trial_status.get(key).filter(|v| !v.is_null());

    for (from, to) in [
        ("in_trial", "trial_active"),
        ("trial_limit_type", "trial_limit_type"),
        ("progress_percent", "trial_progress_percent"),
        ("days_remaining", "trial_days_remaining"),
        ("state", "trial_state"),
        ("usage_entitlement_handle", "trial_usage_entitlement_handle"),
        ("usage_consumed", "trial_usage_consumed"),
        ("usage_limit", "trial_usage_limit"),
    ] {
        if let Some(v) = defined(from) {
            plan.insert(to.to_string(), v.clone());
        }
    }

    // Time-mode only, and only when BOTH halves are present — mirroring the TS
    // `trial.day_number !== undefined && trial.days_remaining !== undefined`
    // guard rather than defaulting a missing half to zero.
    if let (Some(day_number), Some(days_remaining)) =
        (defined("day_number"), defined("days_remaining"))
    {
        if let (Some(d), Some(r)) = (day_number.as_f64(), days_remaining.as_f64()) {
            plan.insert("trial_days_total".to_string(), json!(d + r));
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
        // Identity is the one thing the caller MUST supply; an empty tenant or
        // user silently decides as "some other user" rather than failing.
        if user_context.tenant_id.is_empty() || user_context.user_id.is_empty() {
            return Err("user_context requires non-empty 'tenant_id' and 'user_id'".to_string());
        }

        // Legacy artifacts predate target stamping and carry no `tenant_id`.
        // The user context's tenant fills in — WITHOUT this the public
        // constructor rejects every legacy Playbook, including the parity
        // corpus's own `example-config.json`, while `LocalRuntime` accepts it.
        // The parity gate cannot see the difference: its runners drive
        // `LocalRuntime` directly and never cross this façade.
        //
        // Source: server-python/src/revturbine/sdk.py — same two defaults.
        let defaults = LegacyConfigTargetDefaults {
            tenant_id: user_context.tenant_id.clone(),
            environment_id: PRODUCTION_ENVIRONMENT_ID.to_string(),
        };
        let config = parse_playbook_or_throw(Some(playbook), "playbook", Some(&defaults))?
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
                overlay_trial_status_on_plan_provider(p, trial);
            }
        }

        Ok(Self {
            playbook: config.clone(),
            segment_ids: user_context.segment_ids.clone().unwrap_or_default(),
            runtime: LocalRuntime::new(
                config,
                providers,
                &user_context.tenant_id,
                &user_context.user_id,
            ),
        })
    }

    /// `segment handle -> dimension id`, as the catalog matcher wants it.
    ///
    /// Source: `server-python/src/revturbine/sdk.py` `_segment_dimensions`.
    fn segment_dimensions(&self) -> HashMap<String, String> {
        self.playbook
            .get("segments")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .filter_map(|segment| {
                let handle = segment.get("handle").and_then(Value::as_str)?;
                let dimension = segment.get("dimension_id").and_then(Value::as_str)?;
                Some((handle.to_string(), dimension.to_string()))
            })
            .collect()
    }

    fn playbook_array(&self, key: &str) -> Vec<Value> {
        self.playbook
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
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

    /// The advertised `can` alias of [`check_entitlement`](Self::check_entitlement).
    ///
    /// Mirrors the scaffold SDK function surface (canonical `checkEntitlement`,
    /// alias `can`) and the Python / Node ports, so the documented server
    /// re-check verb works verbatim on this port too. It forwards with no
    /// logic of its own — the two are the same decision, always.
    ///
    /// Source: `server-python/src/revturbine/sdk.py` `can`.
    /// Parity: every `checkEntitlement` fixture in `tests/parity/fixtures/`
    /// locks the delegate this alias forwards to.
    #[must_use]
    pub fn can(&self, handle: &str, context: Option<&Value>) -> EntitlementCheckResult {
        self.check_entitlement(handle, context)
    }

    /// The public plan variations this user is eligible for.
    ///
    /// Reads `plans` / `plan_variations` off the constructed Playbook and
    /// matches them against the user context's pre-resolved `segment_ids`.
    ///
    /// Source: `server-python/src/revturbine/sdk.py` `get_eligible_plans`.
    /// Parity: `tests/parity/fixtures/catalog_variation_eligibility.json`.
    #[must_use]
    pub fn get_eligible_plans(&self) -> Vec<EligiblePlan> {
        get_eligible_plans(
            &self.playbook_array("plans"),
            &self.playbook_array("plan_variations"),
            &self.segment_ids,
            &self.segment_dimensions(),
        )
    }

    /// The public add-on variations this user is eligible for.
    ///
    /// The add-on twin of [`get_eligible_plans`](Self::get_eligible_plans).
    ///
    /// Source: `server-python/src/revturbine/sdk.py` `get_eligible_addons`.
    /// Parity: `tests/parity/fixtures/catalog_variation_eligibility.json`.
    #[must_use]
    pub fn get_eligible_addons(&self) -> Vec<EligibleAddon> {
        get_eligible_addons(
            &self.playbook_array("addons"),
            &self.playbook_array("addon_variations"),
            &self.segment_ids,
            &self.segment_dimensions(),
        )
    }

    /// Evaluate this Playbook's trial rules against a customer's trial
    /// instances → the runtime `UserTrialStatus` (plus reverse-trial grants).
    ///
    /// The config-driven form: `free_trial_rules` / `reverse_trial_rules` come
    /// from the Playbook this SDK was constructed with, so the caller supplies
    /// only the instances and `now_iso`. Pure and deterministic — the clock is
    /// an argument, never a read.
    ///
    /// Source: `server-python/src/revturbine/sdk.py` `evaluate_trial_status`.
    /// Parity: `tests/parity/fixtures/trial_status_evaluation.json`.
    #[must_use]
    pub fn evaluate_trial_status(
        &self,
        instances: &[Value],
        now_iso: &str,
        base_plan_handle: Option<&str>,
        usage_balances: Option<&Value>,
    ) -> TrialEvaluation {
        evaluate_trial_status(
            instances,
            now_iso,
            Some(&self.playbook_array("free_trial_rules")),
            Some(&self.playbook_array("reverse_trial_rules")),
            usage_balances,
            base_plan_handle,
        )
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── Trial-status overlay (BL-0153) ───────────────────────────────────
    //
    // Mirrors `server-python/tests/test_trial_overlay_upsert.py`, the upsert
    // contract the TS `mergeUserContext` / `synthesizeProviderContext` and
    // Python's `_TrialOverlayPlanProvider` share: only DEFINED values write.

    /// A `trial_status` carrying explicit `null`s (the partial-update shape)
    /// leaves the base PlanProviderState untouched and materializes no keys.
    #[test]
    fn overlay_does_not_clobber_base_state_with_null() {
        let mut plan = json!({ "plan_handle": "pro", "trial_active": false })
            .as_object()
            .cloned()
            .expect("object");
        let trial = json!({
            "in_trial": null,
            "state": null,
            "progress_percent": null,
            "days_remaining": null
        })
        .as_object()
        .cloned()
        .expect("object");

        overlay_trial_status_on_plan_provider(&mut plan, &trial);

        assert_eq!(plan.get("plan_handle"), Some(&json!("pro")));
        assert_eq!(plan.get("trial_active"), Some(&json!(false)));
        assert!(!plan.contains_key("trial_state"));
        assert!(!plan.contains_key("trial_progress_percent"));
    }

    /// Defined values DO overwrite / add, and unrelated base fields survive.
    #[test]
    fn overlay_applies_defined_trial_fields() {
        let mut plan = json!({ "plan_handle": "pro" })
            .as_object()
            .cloned()
            .expect("object");
        let trial = json!({ "in_trial": true, "state": "active", "progress_percent": 42 })
            .as_object()
            .cloned()
            .expect("object");

        overlay_trial_status_on_plan_provider(&mut plan, &trial);

        assert_eq!(plan.get("trial_active"), Some(&json!(true)));
        assert_eq!(plan.get("trial_state"), Some(&json!("active")));
        assert_eq!(plan.get("trial_progress_percent"), Some(&json!(42)));
        assert_eq!(plan.get("plan_handle"), Some(&json!("pro")));
    }

    /// Every field the TS canonical's `planTrialFields` emits, including the
    /// usage-mode trio Rust previously dropped (`usage_entitlement_handle`).
    #[test]
    fn overlay_maps_every_canonical_trial_field() {
        let mut plan = Map::new();
        let trial = json!({
            "in_trial": true,
            "trial_limit_type": "usage",
            "progress_percent": 60.0,
            "days_remaining": 4,
            "day_number": 10,
            "state": "trial_ending",
            "usage_entitlement_handle": "api_calls",
            "usage_consumed": 600,
            "usage_limit": 1000
        })
        .as_object()
        .cloned()
        .expect("object");

        overlay_trial_status_on_plan_provider(&mut plan, &trial);

        assert_eq!(plan.get("trial_active"), Some(&json!(true)));
        assert_eq!(plan.get("trial_limit_type"), Some(&json!("usage")));
        assert_eq!(plan.get("trial_progress_percent"), Some(&json!(60.0)));
        assert_eq!(plan.get("trial_days_remaining"), Some(&json!(4)));
        assert_eq!(plan.get("trial_state"), Some(&json!("trial_ending")));
        assert_eq!(
            plan.get("trial_usage_entitlement_handle"),
            Some(&json!("api_calls"))
        );
        assert_eq!(plan.get("trial_usage_consumed"), Some(&json!(600)));
        assert_eq!(plan.get("trial_usage_limit"), Some(&json!(1000)));
        // Derived, not copied — and `day_number` itself lands nowhere, because
        // the provider state has no `trial_day_number` field for it to reach.
        assert_eq!(plan.get("trial_days_total"), Some(&json!(14.0)));
        assert!(!plan.contains_key("trial_day_number"));
    }

    /// `trial_days_total` is time-mode only: one half missing means no total,
    /// never a half defaulted to zero (a usage-mode trial would otherwise get a
    /// bogus time-based progress fallback).
    #[test]
    fn trial_days_total_requires_both_halves() {
        let mut plan = Map::new();
        let trial = json!({ "day_number": 10 })
            .as_object()
            .cloned()
            .expect("object");
        overlay_trial_status_on_plan_provider(&mut plan, &trial);
        assert!(!plan.contains_key("trial_days_total"));

        let mut plan = Map::new();
        let trial = json!({ "days_remaining": 4 })
            .as_object()
            .cloned()
            .expect("object");
        overlay_trial_status_on_plan_provider(&mut plan, &trial);
        assert!(!plan.contains_key("trial_days_total"));
        assert_eq!(plan.get("trial_days_remaining"), Some(&json!(4)));
    }

    /// A legacy artifact: `version`, no `artifact_type`/`format_version`, and —
    /// like every artifact that predates target stamping — no `tenant_id`.
    fn legacy_playbook() -> Value {
        json!({
            "version": "1.0.0",
            "plans": [],
            "entitlements": [{ "unique_handle": "feat_x", "unit": null }],
            "entitlement_rules": [],
            "segments": [],
            "content_ui_paths": [],
            "placements": [{ "placement_id": "pl_known", "name": "Known" }]
        })
    }

    fn ctx(tenant: &str, user: &str) -> UserContext {
        UserContext {
            tenant_id: tenant.to_string(),
            user_id: user.to_string(),
            ..Default::default()
        }
    }

    /// The catalog fixture from `server-python/tests/test_catalog_eligibility.py`,
    /// so both ports' facade tests assert the same Playbook.
    fn catalog_playbook() -> Value {
        json!({
            "version": "1.0.0",
            "plans": [
                { "unique_handle": "free", "name": "Free", "tier_position": 0, "sort_order": 0, "visibility": "public" },
                { "unique_handle": "pro", "name": "Pro", "tier_position": 1, "sort_order": 0, "visibility": "public" }
            ],
            "addons": [
                { "unique_handle": "support", "name": "Support", "sort_order": 0, "visibility": "public" }
            ],
            "plan_variations": [
                { "handle": "free_default", "plan_handle": "free", "billing_period": "monthly", "segment_handle": null, "price_amount": 0, "currency": "usd", "pricing_model": "flat", "visibility": "public" },
                { "handle": "pro_default", "plan_handle": "pro", "billing_period": "monthly", "segment_handle": null, "price_amount": 4900, "currency": "usd", "pricing_model": "flat", "visibility": "public" },
                { "handle": "pro_startup", "plan_handle": "pro", "billing_period": "monthly", "segment_handle": "startup", "price_amount": 2900, "currency": "usd", "pricing_model": "flat", "visibility": "public" }
            ],
            "addon_variations": [
                { "handle": "support_default", "addon_handle": "support", "billing_period": "monthly", "segment_handle": null, "price_amount": 1000, "currency": "usd", "pricing_model": "flat", "visibility": "public" }
            ],
            "entitlements": [],
            "entitlement_rules": [],
            "segments": [
                { "handle": "startup", "name": "Startup", "dimension_id": "stage", "predicates": [] }
            ],
            "content_ui_paths": [],
            "placements": []
        })
    }

    /// Mirrors `server-python/tests/trials/test_trial_status.py::_instance`.
    fn trial_instance() -> Value {
        json!({
            "id": "ti_test",
            "tenant_id": "t_test",
            "created_at": "2026-05-01T00:00:00Z",
            "updated_at": "2026-05-01T00:00:00Z",
            "customer_id": "cust_test",
            "rule_id": "ftr_pro_14d",
            "rule_type": "free_trial",
            "plan_id": "slack_pro",
            "status": "active",
            "started_at": "2026-05-01T00:00:00Z",
            "expires_at": "2026-05-15T00:00:00Z",
            "converted_at": null,
            "cancelled_at": null,
            "metadata": {}
        })
    }

    /// Mirrors `server-python/tests/trials/test_trial_status.py::_free_rule`.
    fn free_trial_rule() -> Value {
        json!({
            "id": "ftr_pro_14d",
            "name": "Pro 14d",
            "handle": "pro_14d",
            "plan_id": "slack_pro",
            "duration_days": 14,
            "grace_period_days": 0,
            "require_payment_method": false,
            "auto_convert": true,
            "limit_per_customer": 1,
            "is_active": true,
            "metadata": {}
        })
    }

    /// Mirrors `server-python/tests/test_catalog_eligibility.py`'s
    /// `test_public_catalog_methods_apply_specificity`: the facade reads the
    /// catalog off the constructed Playbook and the segment ids off the user
    /// context, and the segment-scoped variation SUPPRESSES the default.
    #[test]
    fn catalog_methods_apply_segment_specificity() {
        let user_context = UserContext {
            segment_ids: Some(vec!["startup".to_string()]),
            ..ctx("tenant", "user")
        };
        let sdk = RevTurbineCustomerSdk::new(&user_context, &catalog_playbook())
            .expect("catalog playbook parses");

        let plans = sdk.get_eligible_plans();
        let handles: Vec<&str> = plans
            .iter()
            .map(|item| item.variation_handle.as_str())
            .collect();
        assert_eq!(handles, vec!["free_default", "pro_startup"]);
        assert_eq!(plans[1].price.price, json!(2900));
        assert_eq!(plans[1].price.currency, json!("usd"));
        assert_eq!(plans[1].price.pricing_model, json!("flat"));
        assert_eq!(plans[1].price.billing_period, json!("monthly"));

        let addons = sdk.get_eligible_addons();
        assert_eq!(addons[0].variation_handle, "support_default");
    }

    /// Without segment ids the default variation is the eligible one — the
    /// segment dimensions still come from the Playbook's `segments` array.
    #[test]
    fn catalog_methods_fall_back_to_default_variations() {
        let sdk = RevTurbineCustomerSdk::new(&ctx("tenant", "user"), &catalog_playbook())
            .expect("catalog playbook parses");
        let handles: Vec<String> = sdk
            .get_eligible_plans()
            .into_iter()
            .map(|item| item.variation_handle)
            .collect();
        assert_eq!(handles, vec!["free_default", "pro_default"]);
    }

    /// Mirrors `server-python`'s `TestSdkEvaluateTrialStatus`: the method reads
    /// `free_trial_rules` from the Playbook the SDK was constructed with, so
    /// the caller supplies only instances and the clock.
    #[test]
    fn evaluate_trial_status_reads_rules_from_the_playbook() {
        let mut playbook = legacy_playbook();
        playbook["plans"] =
            json!([{ "id": "slack_pro", "unique_handle": "slack_pro", "name": "Pro" }]);
        playbook["free_trial_rules"] = json!([free_trial_rule()]);

        let sdk =
            RevTurbineCustomerSdk::new(&ctx("t", "u"), &playbook).expect("trial playbook parses");
        let evaluation =
            sdk.evaluate_trial_status(&[trial_instance()], "2026-05-08T00:00:00Z", None, None);
        let trial = evaluation.trial.expect("an active trial resolves");
        let serialized = serde_json::to_value(&trial).expect("trial serializes");
        assert_eq!(serialized["progress_percent"], json!(50.0));
        assert_eq!(serialized["plan_handle"], json!("slack_pro"));
        assert!(evaluation.reverse_grants.is_none());
    }

    /// No rules in the Playbook means no rule resolves — the method must not
    /// invent one from the instance alone.
    #[test]
    fn evaluate_trial_status_without_configured_rules_derives_no_rule_fields() {
        let sdk = RevTurbineCustomerSdk::new(&ctx("t", "u"), &legacy_playbook())
            .expect("legacy playbook parses");
        let evaluation = sdk.evaluate_trial_status(&[], "2026-05-08T00:00:00Z", None, None);
        assert!(evaluation.trial.is_none());
        assert!(evaluation.reverse_grants.is_none());
    }

    /// Mirrors `server-python/tests/test_sdk_can_alias.py`: `can` is the
    /// advertised alias, so it must return exactly what `check_entitlement`
    /// returns for the same arguments.
    #[test]
    fn can_is_an_exact_alias_of_check_entitlement() {
        let sdk = RevTurbineCustomerSdk::new(&ctx("t", "u"), &legacy_playbook())
            .expect("legacy playbook parses");
        let via_alias = sdk.can("feat_x", None);
        let via_canonical = sdk.check_entitlement("feat_x", None);
        assert_eq!(
            serde_json::to_value(&via_alias).expect("alias result serializes"),
            serde_json::to_value(&via_canonical).expect("canonical result serializes"),
        );
    }

    /// Regression: the constructor used to pass `None` for the legacy target
    /// defaults, so it rejected every legacy Playbook — including the parity
    /// corpus's own `example-config.json` — while `LocalRuntime` accepted the
    /// same artifact happily. The parity gate is blind to this: its runners
    /// drive `LocalRuntime` directly and never cross this façade.
    #[test]
    fn accepts_legacy_playbook_without_tenant_id() {
        let sdk = RevTurbineCustomerSdk::new(&ctx("tenant_abc", "user_1"), &legacy_playbook());
        assert!(sdk.is_ok(), "legacy playbook rejected: {:?}", sdk.err());
    }

    /// The tenant the artifact lacks comes from the user context, not from a
    /// placeholder — decisions are tenant-scoped, so a wrong fill-in is worse
    /// than a rejection.
    ///
    /// Asserted at the config layer because `LocalRuntime` exposes no config
    /// accessor and widening the public API for a test is the wrong trade. The
    /// test above proves the SDK passes defaults at all; this proves the
    /// defaults it builds carry the caller's tenant rather than a placeholder.
    #[test]
    fn legacy_target_defaults_use_context_tenant_and_production_environment() {
        let defaults = LegacyConfigTargetDefaults {
            tenant_id: "tenant_abc".to_string(),
            environment_id: PRODUCTION_ENVIRONMENT_ID.to_string(),
        };
        let normalized =
            parse_playbook_or_throw(Some(&legacy_playbook()), "playbook", Some(&defaults))
                .expect("legacy playbook parses")
                .expect("artifact present");
        assert_eq!(normalized["tenant_id"], json!("tenant_abc"));
        assert_eq!(normalized["environment_id"], json!("production"));
    }

    #[test]
    fn rejects_empty_identity() {
        for (tenant, user, label) in [
            ("", "user_1", "empty tenant_id"),
            ("tenant_abc", "", "empty user_id"),
            ("", "", "both empty"),
        ] {
            let err = RevTurbineCustomerSdk::new(&ctx(tenant, user), &legacy_playbook())
                .err()
                .unwrap_or_else(|| panic!("{label} was accepted"));
            assert!(err.contains("non-empty"), "{label}: unexpected error {err}");
        }
    }

    /// The fill-in is scoped to the LEGACY branch. A canonical artifact declares
    /// its own target, and silently substituting the caller's tenant there would
    /// let a Playbook built for one tenant decide for another.
    #[test]
    fn canonical_playbook_still_requires_its_own_tenant_id() {
        let canonical = json!({
            "artifact_type": "playbook",
            "format_version": "1.0.0",
            "environment_id": "env_1",
            "plans": [],
            "entitlements": [],
            "entitlement_rules": [],
            "segments": [],
            "content_ui_paths": [],
            "placements": []
        });
        let err = RevTurbineCustomerSdk::new(&ctx("tenant_abc", "user_1"), &canonical)
            .err()
            .expect("canonical artifact without tenant_id must fail");
        assert!(err.contains("tenant_id"), "unexpected error: {err}");
    }
}
