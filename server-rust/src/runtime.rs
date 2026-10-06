//! `LocalRuntime` — the composition layer.
//!
//! Wires the resolved providers ([`crate::adapters`]) to the placement
//! resolver, the entitlement evaluator, and the state machinery, and exposes
//! the two decision capabilities the headless SDK offers:
//!
//! - [`LocalRuntime::check_entitlement`]
//! - [`LocalRuntime::get_placement_decision`] / [`get_placement_decisions`]
//!
//! [`get_placement_decisions`]: LocalRuntime::get_placement_decisions
//!
//! The TS and Python split this across a `DecisionEngine` and a `LocalRuntime`
//! that mostly delegates to it. Both layers are here, but as one type: the
//! engine's public surface is exactly what the runtime re-exports, and a
//! second indirection would only restate it. The pipeline order — suppression
//! → providers → resolver → caps — is preserved exactly, because each stage
//! can veto and the order is what decides which reason a caller sees.
//!
//! [`LocalRuntime::check_entitlement`] is the ONE effective entitlement
//! answer (D-61, Kent 2026-10-06): the shared Playbook + user-context
//! evaluator merged with app-mirrored data — see
//! [`crate::entitlements::effective_entitlement`]. The placement resolver reads
//! the same effective map. The engine's provider-snapshot check stays reachable
//! as [`LocalRuntime::engine_check_entitlement`] (TS `runtime.engine.checkEntitlement`).
//!
//! Source: revturbine-scaffold/src/core/decisions/engine.ts and
//! src/core/runtime/local-runtime.ts

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, PoisonError};

use serde_json::{json, Map, Value};

use crate::decisions::EntitlementCheckResult;
use crate::entitlements::{
    derive_effective_entitlement, derive_effective_entitlements,
    derive_result_from_rule_type_fields, find_matching_entitlement_rule, is_rule_shaped_kind,
    reverse_trial_grants, with_rule_handle, AppEntitlementInputs, EffectiveEntitlementBase,
    EntitlementMergeOptions, RuleEvaluationContext,
};
use crate::placements::StaticPlacementResolver;
use crate::state::{
    CapEnforcer, ImpressionHistory, InMemoryImpressionStore, InMemoryStorage, InteractionTracker,
    TreatmentInteractionInput,
};

/// What an entitlement resolves to when nothing more specific applies.
pub use crate::adapters::EntitlementPolicy;

/// Called once per entitlement handle that neither the Playbook nor the app
/// knows (D-61) — wire telemetry here.
pub type UnknownEntitlementHook = Box<dyn Fn(&str) + Send + Sync>;

/// One placement decision request.
#[derive(Debug, Clone)]
pub struct PlacementDecisionInput {
    /// The placement to decide.
    pub placement_id: String,
    /// The acting user.
    pub user_id: String,
}

/// The headless decision runtime.
pub struct LocalRuntime {
    config: Value,
    providers: Value,
    resolver: StaticPlacementResolver,
    registered: HashMap<String, Value>,
    interaction_tracker: InteractionTracker<InMemoryStorage>,
    impression_history: ImpressionHistory<InMemoryImpressionStore>,
    cap_enforcer: CapEnforcer<InMemoryStorage>,
    default_entitlement_policy: EntitlementPolicy,
    enable_caps_enforcement: bool,
    user_id: String,
    user_entitlements: Map<String, Value>,
    trial_status: Option<Value>,
    entitlement_merge: EntitlementMergeOptions,
    on_unknown_entitlement: Option<UnknownEntitlementHook>,
    reported_unknown_entitlements: Mutex<HashSet<String>>,
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for key in path {
        cur = cur.get(key)?;
    }
    cur.as_str()
}

impl LocalRuntime {
    /// Compose a runtime from a Playbook and its resolved provider context.
    ///
    /// Storage is in-memory and there is deliberately **no injection point**:
    /// the headless runtime is stateless per user context, and a caller that
    /// needs durability owns it.
    #[must_use]
    pub fn new(config: Value, providers: Value, tenant_id: &str, user_id: &str) -> Self {
        let placements = config
            .get("placements")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let resolver = StaticPlacementResolver::new(&placements, &config);

        Self {
            config,
            providers,
            resolver,
            registered: HashMap::new(),
            interaction_tracker: InteractionTracker::new(
                InMemoryStorage::new(),
                tenant_id,
                user_id,
            ),
            impression_history: ImpressionHistory::new(InMemoryImpressionStore::new(), user_id),
            cap_enforcer: CapEnforcer::new(InMemoryStorage::new(), tenant_id, user_id),
            // D-61 (Kent, 2026-10-06): unknown handles and a missing
            // entitlement provider fail CLOSED by default; `Allow` remains an
            // explicit opt-in.
            default_entitlement_policy: EntitlementPolicy::Deny,
            enable_caps_enforcement: true,
            user_id: user_id.to_string(),
            user_entitlements: Map::new(),
            trial_status: None,
            entitlement_merge: EntitlementMergeOptions::default(),
            on_unknown_entitlement: None,
            reported_unknown_entitlements: Mutex::new(HashSet::new()),
        }
    }

    /// Override the engine's default entitlement policy — `deny` unless set
    /// (fail closed, D-61). It governs
    /// [`engine_check_entitlement`](Self::engine_check_entitlement) (TS
    /// `engineOptions.defaultEntitlementPolicy`), not the effective
    /// [`check_entitlement`](Self::check_entitlement) answer.
    #[must_use]
    pub fn with_entitlement_policy(mut self, policy: EntitlementPolicy) -> Self {
        self.default_entitlement_policy = policy;
        self
    }

    /// D-61 Entitlement Mirroring: the user context's own entitlement data
    /// (`UserContext.entitlements`) — per handle a boolean or a grant-shaped
    /// record — merged with the Playbook evaluation.
    #[must_use]
    pub fn with_user_entitlements(mut self, entitlements: Map<String, Value>) -> Self {
        self.user_entitlements = entitlements;
        self
    }

    /// D-61: the user's trial status (`UserTrialStatus`; `in_trial`,
    /// `trial_type` and `plan_handle` are read), so reverse-trial grants
    /// evaluate exactly as in the browser.
    #[must_use]
    pub fn with_trial_status(mut self, trial_status: Value) -> Self {
        self.trial_status = Some(trial_status);
        self
    }

    /// D-61: how app-supplied entitlement data merges with the Playbook
    /// result. Default: app wins.
    #[must_use]
    pub fn with_entitlement_merge(mut self, merge: EntitlementMergeOptions) -> Self {
        self.entitlement_merge = merge;
        self
    }

    /// Called once per entitlement handle that neither the Playbook nor the
    /// app knows (it is denied). The runtime also prints a warning to stderr.
    #[must_use]
    pub fn with_on_unknown_entitlement<F>(mut self, hook: F) -> Self
    where
        F: Fn(&str) + Send + Sync + 'static,
    {
        self.on_unknown_entitlement = Some(Box::new(hook));
        self
    }

    /// Opt out of cap enforcement. On by default.
    #[must_use]
    pub fn with_caps_enforcement(mut self, enabled: bool) -> Self {
        self.enable_caps_enforcement = enabled;
        self
    }

    /// Register a placement record so the resolver can look it up by slot.
    pub fn register_placement(&mut self, record: Value) {
        if let Some(id) = str_at(&record, &["placement_id"]) {
            self.registered.insert(id.to_string(), record);
        }
    }

    /// The merged provider context.
    #[must_use]
    pub fn resolve_providers(&self) -> &Value {
        &self.providers
    }

    // ── Placement decisions ────────────────────────────────────────────────

    /// Evaluate one placement decision.
    ///
    /// Pipeline: **providers → resolver → category-aware suppression → caps**. Each stage can
    /// veto, and the order decides which reason the caller sees — a placement
    /// that is both interaction-suppressed and cap-exceeded reports the
    /// suppression, because that is the earlier and more specific answer.
    ///
    /// Source: engine.ts:79-147
    pub fn get_placement_decision(&mut self, input: &PlacementDecisionInput) -> Value {
        // 2-4. Providers → resolver. D-61: the resolver's gates read the SAME
        // effective entitlements `check_entitlement` returns, not the
        // providers' raw entries.
        let context = json!({ "__providers": self.resolver_providers() });
        let placement = self.registered.get(&input.placement_id).cloned();
        let mut decision = self.resolver.resolve(
            &input.placement_id,
            placement.as_ref(),
            Some(&context),
            Some(&mut self.impression_history),
        );

        if decision.get("visible").and_then(Value::as_bool) == Some(true) {
            let category = str_at(&decision, &["output", "category"]).unwrap_or("");
            let suppression = self.interaction_tracker.check_suppression_for_category(
                &input.placement_id,
                &input.user_id,
                None,
                category,
            );
            if suppression.suppressed {
                decision["visible"] = json!(false);
                decision["reason_codes"] = suppression
                    .reason
                    .clone()
                    .map_or_else(|| json!([]), |r| json!([r]));
                if let Some(reason) = suppression.reason {
                    decision["suppression_reason"] = json!(reason);
                }
                return decision;
            }
        }

        // 5. Caps apply only to a VISIBLE decision that produced an output —
        //    an invisible one was never presented, so it must not consume the
        //    user's cap budget.
        let visible = decision.get("visible").and_then(Value::as_bool) == Some(true);
        let has_output = decision.get("output").is_some();
        if visible && has_output && self.enable_caps_enforcement {
            let output = decision["output"].clone();
            let cap = self.cap_enforcer.enforce(&output);
            if !cap.allowed {
                let reason = cap
                    .reason
                    .unwrap_or_else(|| "suppressed_by_cap".to_string());
                decision["visible"] = json!(false);
                if let Some(codes) = decision
                    .get_mut("reason_codes")
                    .and_then(Value::as_array_mut)
                {
                    codes.push(json!(reason));
                }
                decision["suppression_reason"] = json!(reason);
            }
        }

        decision
    }

    /// Evaluate a batch, preserving input order — order is decision-semantic.
    ///
    /// Source: engine.ts:152-154
    pub fn get_placement_decisions(&mut self, inputs: &[PlacementDecisionInput]) -> Vec<Value> {
        inputs
            .iter()
            .map(|i| self.get_placement_decision(i))
            .collect()
    }

    /// Resolve the winning placement for a **surface slot** rather than a
    /// placement id (plan 147 REQ-11).
    ///
    /// The slot is looked up in the Playbook's `placement_slots` registry and
    /// turned into a placement record whose `surface_template_ids` drive
    /// candidate gathering; the same resolver pipeline then runs. `None` when
    /// no slot matches.
    ///
    /// Config keys arrive snake_case — the parity harness snake-cases the
    /// corpus' canonical camelCase args.
    ///
    /// Source: local-runtime.ts:195-225 + 375-416
    pub fn get_placement(&mut self, config: &Value) -> Option<Value> {
        let record = self.slot_record_for_config(config)?;
        let placement_id = record
            .get("placement_id")
            .and_then(Value::as_str)?
            .to_string();
        let user_id = self.user_id.clone();
        self.register_placement(record);
        Some(self.get_placement_decision(&PlacementDecisionInput {
            placement_id,
            user_id,
        }))
    }

    /// Build the placement record for a surface-keyed request.
    ///
    /// A caller-registered slot wins; otherwise the record is derived from the
    /// Playbook's `placement_slots` — the headless path, where there is no
    /// mounted component to self-register.
    ///
    /// Metadata keys are snake_case to match the resolver's reads; the TS
    /// record's one camelCase key (`fixedOnly`) is `fixed_only` here.
    fn slot_record_for_config(&self, config: &Value) -> Option<Value> {
        let slot_id = config.get("slot_id").and_then(Value::as_str);
        if let Some(id) = slot_id {
            if let Some(existing) = self.registered.get(id) {
                return Some(existing.clone());
            }
        }
        let component_type = placement_component_type(config);

        let slot = self
            .config
            .get("placement_slots")
            .and_then(Value::as_array)?
            .iter()
            .find(|s| match (slot_id, component_type) {
                // A slot id is the more specific key and wins outright.
                (Some(id), _) => s.get("id").and_then(Value::as_str) == Some(id),
                (None, Some(st)) => s.get("surface_type").and_then(Value::as_str) == Some(st),
                (None, None) => false,
            })?;

        let mut metadata = Map::new();
        metadata.insert("surface_slot_id".into(), slot.get("id").cloned()?);
        metadata.insert(
            "surface_type".into(),
            slot.get("surface_type").cloned().unwrap_or(Value::Null),
        );
        metadata.insert(
            "surface_template_ids".into(),
            slot.get("template")
                .and_then(Value::as_str)
                .map_or_else(|| json!([]), |t| json!([t])),
        );
        if let Some(h) = config.get("entitlement_handle").and_then(Value::as_str) {
            metadata.insert("entitlement_handle".into(), json!(h));
        }
        if config.get("fixed_only").and_then(Value::as_bool) == Some(true) {
            metadata.insert("fixed_only".into(), json!(true));
        }

        // The caller's handle overrides the slot's own.
        let name = config
            .get("placement_handle")
            .cloned()
            .filter(|v| !v.is_null())
            .or_else(|| slot.get("placement_handle").cloned())
            .unwrap_or(Value::Null);

        Some(json!({
            "placement_id": slot.get("id").cloned()?,
            "name": name,
            "route": "",
            "metadata": Value::Object(metadata),
        }))
    }

    /// Record a treatment interaction.
    /// The per-user impression history — the retirement/suppression state
    /// the resolver consults. Public like TS core's `impressionHistory` so a
    /// caller (and the parity harness) can record a confirmed conversion.
    pub fn impression_history_mut(&mut self) -> &mut ImpressionHistory<InMemoryImpressionStore> {
        &mut self.impression_history
    }

    /// Build the full targeting state from a user context snapshot
    /// (plan 234 TASK-8b — closes the REQ-14 deferral in this port too).
    #[must_use]
    pub fn build_targeting_state(
        &self,
        context: &Value,
        usage_overrides: Option<&serde_json::Map<String, Value>>,
    ) -> Value {
        crate::user_context::build_targeting_state(context, Some(&self.config), usage_overrides)
    }

    /// Track a treatment interaction (dismiss / remind-later / convert).
    pub fn track_interaction(&mut self, input: &TreatmentInteractionInput) {
        self.interaction_tracker.track(input);
    }

    /// Clear a placement's suppression window.
    pub fn clear_suppression(&mut self, placement_id: &str, user_id: &str) {
        self.interaction_tracker
            .clear_suppression(placement_id, user_id, None);
    }

    // ── Entitlements ───────────────────────────────────────────────────────

    /// Check entitlement access (D-61): the shared evaluator decides from the
    /// Playbook + user context, then app-mirrored data (user-context grants
    /// and any app entitlement provider) merges per the runtime's precedence
    /// (default: app wins). The browser SDK runs the same function on the
    /// same inputs, so the server verifies exactly what the browser showed.
    /// An entitlement nobody knows is denied, warned and reported.
    ///
    /// Source: local-runtime.ts (checkEntitlement)
    #[must_use]
    pub fn check_entitlement(
        &self,
        handle: &str,
        context: Option<&Value>,
    ) -> EntitlementCheckResult {
        let app_by_handle = self.app_inputs_by_handle(&self.providers);
        let effective = derive_effective_entitlement(
            handle,
            &self.effective_base(&self.providers, context),
            app_by_handle.get(handle),
        );
        if effective.unknown_handle {
            self.report_unknown_entitlement(handle);
        }
        effective.result
    }

    /// The engine's provider-snapshot entitlement check — TS
    /// `runtime.engine.checkEntitlement`. It reads the provider entries and
    /// rule snapshots and falls back to the default policy (`deny` unless
    /// [`with_entitlement_policy`](Self::with_entitlement_policy) says
    /// otherwise, D-61) for a missing provider or entry.
    ///
    /// Decisions go through [`check_entitlement`](Self::check_entitlement);
    /// this stays reachable for callers that want the raw engine view.
    ///
    /// Source: engine.ts:186-229
    #[must_use]
    pub fn engine_check_entitlement(
        &self,
        handle: &str,
        context: Option<&Value>,
    ) -> EntitlementCheckResult {
        let policy = self.default_entitlement_policy;
        let policy_default = |allowed_reason: &str, denied_reason: &str| {
            let allow = policy == EntitlementPolicy::Allow;
            let mut r =
                EntitlementCheckResult::new(if allow { "allowed" } else { "denied" }, allow);
            r.reason = Some(if allow { allowed_reason } else { denied_reason }.to_string());
            r
        };

        let Some(entitlements) = self.providers.get("entitlements") else {
            return policy_default(
                "no_entitlement_provider",
                "no_entitlement_provider_default_deny",
            );
        };

        let Some(entry) = entitlements
            .get("entries")
            .and_then(|e| e.get(handle))
            .filter(|e| e.is_object())
        else {
            return policy_default(
                "entitlement_not_found_default_allow",
                "entitlement_not_found_default_deny",
            );
        };

        let usage = entitlements.get("usage").and_then(|u| u.get(handle));

        // Plan 133: a configured rule is AUTHORITATIVE over the provider
        // entry's default-policy status.
        if let Some(rules) = self.providers.get("rules") {
            let by_ent: HashMap<String, Vec<Value>> = rules
                .get("entitlement_rules")
                .and_then(Value::as_object)
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| (k.clone(), v.as_array().cloned().unwrap_or_default()))
                        .collect()
                })
                .unwrap_or_default();

            let plan = self.providers.get("plan");
            let rule_ctx = RuleEvaluationContext {
                segment_ids: self
                    .providers
                    .get("segments")
                    .and_then(|s| s.get("segment_ids"))
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                current_plan_handle: plan
                    .and_then(|p| p.get("current_plan_handle"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                billing_period: plan
                    .and_then(|p| p.get("billing_period"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                // TS passes `ruleState.segmentDimensions` to the matcher; without
                // it every segment falls into one OR bucket (BL-0369).
                segment_dimensions: rules
                    .get("segment_dimensions")
                    .and_then(Value::as_object)
                    .map(|m| {
                        m.iter()
                            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                            .collect()
                    })
                    .unwrap_or_default(),
                ..Default::default()
            };

            match find_matching_entitlement_rule(&by_ent, handle, &rule_ctx) {
                Some(matched) => {
                    // The snapshot's `kind` seeds the shaper; a `fields.kind`
                    // wins via merge order. The two agree wherever both exist.
                    let mut type_fields = Map::new();
                    if let Some(k) = matched.get("kind") {
                        type_fields.insert("kind".into(), k.clone());
                    }
                    if let Some(fields) = matched.get("fields").and_then(Value::as_object) {
                        for (k, v) in fields {
                            type_fields.insert(k.clone(), v.clone());
                        }
                    }
                    let tf = Value::Object(type_fields);

                    if tf
                        .get("kind")
                        .and_then(Value::as_str)
                        .is_some_and(is_rule_shaped_kind)
                    {
                        let used = context
                            .and_then(|c| c.get("used"))
                            .and_then(Value::as_f64)
                            .or_else(|| usage.and_then(|u| u.get("used")).and_then(Value::as_f64))
                            .unwrap_or(0.0);
                        // BL-0062 (gap G3): stamp the winner of the §2.6.5
                        // selection. The snapshot's `rule_id` comes from the
                        // Playbook entry's handle-valued `id`, so both
                        // evaluators agree on the VALUE, not just the field.
                        return with_rule_handle(
                            derive_result_from_rule_type_fields(&tf, used),
                            matched
                                .get("rule_id")
                                .and_then(Value::as_str)
                                .filter(|id| !id.is_empty())
                                .map(str::to_string),
                        );
                    }
                    // A kind the shaper does not model (legacy 'metered')
                    // still proves the plan assignment exists — fall through.
                }
                None => {
                    // Kent's 2026-07-13 ruling: a CONFIGURED entitlement with
                    // no rule assigning it to the user's plan is DENIED.
                    // Unknown handles and engines with no rules provider keep
                    // the default-policy behaviour instead.
                    let mut r = EntitlementCheckResult::new("denied", false);
                    r.reason = Some("no_matching_entitlement_rule".to_string());
                    return r;
                }
            }
        }

        // Caller-supplied usage enforces the limit.
        if let (Some(usage), Some(used)) = (
            usage,
            context.and_then(|c| c.get("used")).and_then(Value::as_f64),
        ) {
            let limit = usage.get("limit").and_then(Value::as_f64).unwrap_or(0.0);
            if limit > 0.0 && used >= limit {
                let mut r = EntitlementCheckResult::new("denied", false);
                r.reason = Some("usage_limit_exceeded".to_string());
                r.limit = serde_json::Number::from_f64(limit);
                r.used = serde_json::Number::from_f64(used);
                r.remaining = serde_json::Number::from_f64((limit - used).max(0.0));
                return r;
            }
        }

        let status = entry
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("denied");
        let mut result = EntitlementCheckResult::new(status, status == "allowed");
        result.reason = entry
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(u) = usage {
            result.limit = u.get("limit").and_then(Value::as_number).cloned();
            result.used = u.get("used").and_then(Value::as_number).cloned();
            result.remaining = u.get("remaining").and_then(Value::as_number).cloned();
        }
        result
    }

    /// Evaluator inputs from the resolved providers — the same facts the
    /// browser SDK uses.
    ///
    /// Source: local-runtime.ts (effectiveBase)
    fn effective_base(
        &self,
        providers: &Value,
        context: Option<&Value>,
    ) -> EffectiveEntitlementBase<'_> {
        // `Number.isFinite(entry.used)` — a JSON number is always finite.
        let usage_balances: HashMap<String, f64> = providers
            .get("entitlements")
            .and_then(|e| e.get("usage"))
            .and_then(Value::as_object)
            .map(|usage| {
                usage
                    .iter()
                    .filter_map(|(h, entry)| Some((h.clone(), entry.get("used")?.as_f64()?)))
                    .collect()
            })
            .unwrap_or_default();
        let segments = providers.get("segments");
        let segment_ids: HashSet<String> = ["segment_slugs", "segment_ids"]
            .iter()
            .filter_map(|key| segments.and_then(|s| s.get(*key)).and_then(Value::as_array))
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        // `String(providers.plan?.currentPlanHandle ?? '').toLowerCase()`
        let current_plan_handle = match providers
            .get("plan")
            .and_then(|p| p.get("current_plan_handle"))
        {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(h)) => h.clone(),
            Some(other) => other.to_string(),
        }
        .to_lowercase();
        EffectiveEntitlementBase {
            playbook: Some(&self.config),
            context_used: context.and_then(|c| c.get("used")).and_then(Value::as_f64),
            current_plan_handle,
            segment_ids,
            usage_balances,
            merge: self.entitlement_merge,
            ..EffectiveEntitlementBase::default()
        }
        .with_reverse_trial_grants(reverse_trial_grants(
            &self.config,
            self.trial_status.as_ref(),
        ))
    }

    /// App-mirrored data per handle: user-context grants plus non-default
    /// provider entries.
    ///
    /// Source: local-runtime.ts (appInputsByHandle)
    fn app_inputs_by_handle(&self, providers: &Value) -> BTreeMap<String, AppEntitlementInputs> {
        let mut out: BTreeMap<String, AppEntitlementInputs> = self
            .user_entitlements
            .iter()
            .map(|(handle, grant)| {
                (
                    handle.clone(),
                    AppEntitlementInputs {
                        user_context: Some(grant.clone()),
                        provider: None,
                    },
                )
            })
            .collect();
        if let Some(state) = providers
            .get("entitlements")
            .filter(|s| s.get("origin").and_then(Value::as_str) != Some("playbook_default"))
        {
            for (handle, entry) in state
                .get("entries")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                out.entry(handle.clone()).or_default().provider = Some(entry.clone());
            }
        }
        out
    }

    /// The provider context the built-in resolver sees: the effective
    /// entitlement map in place of the raw entries, origin cleared.
    ///
    /// Source: local-runtime.ts (buildPlacementResolver wrapper)
    fn resolver_providers(&self) -> Value {
        let entries: Map<String, Value> = derive_effective_entitlements(
            &self.effective_base(&self.providers, None),
            &self.app_inputs_by_handle(&self.providers),
        )
        .into_iter()
        .map(|(handle, result)| (handle, serde_json::to_value(result).unwrap_or(Value::Null)))
        .collect();
        let mut providers = self.providers.as_object().cloned().unwrap_or_default();
        let mut entitlements = providers
            .get("entitlements")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        entitlements.insert("entries".into(), Value::Object(entries));
        // TS writes `origin: undefined`: the effective map is no longer a
        // blanket default, so the marker does not travel with it.
        entitlements.remove("origin");
        providers.insert("entitlements".into(), Value::Object(entitlements));
        Value::Object(providers)
    }

    /// Warn once per handle and hand it to the unknown-entitlement hook.
    ///
    /// Source: local-runtime.ts (reportUnknownEntitlement)
    fn report_unknown_entitlement(&self, handle: &str) {
        let first = self
            .reported_unknown_entitlements
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(handle.to_string());
        if !first {
            return;
        }
        eprintln!(
            "[revturbine] entitlement \"{handle}\" is not in the Playbook and no app data was supplied for it; denying (entitlement_not_in_playbook)."
        );
        if let Some(hook) = &self.on_unknown_entitlement {
            hook(handle);
        }
    }
}

/// Single compatibility boundary for component_type / surface_type.
fn placement_component_type(config: &Value) -> Option<&str> {
    config
        .get("component_type")
        .or_else(|| config.get("surface_type"))
        .and_then(Value::as_str)
}
