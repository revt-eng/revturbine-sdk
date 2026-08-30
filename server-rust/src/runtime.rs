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
//! Source: revturbine-scaffold/src/core/decisions/engine.ts and
//! src/core/runtime/local-runtime.ts

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use crate::decisions::EntitlementCheckResult;
use crate::entitlements::{
    derive_local_entitlement_from_configured_rules, derive_result_from_rule_type_fields,
    find_matching_entitlement_rule, is_rule_shaped_kind, LocalEntitlementInput,
    RuleEvaluationContext,
};
use crate::placements::{decision_content, StaticPlacementResolver};
use crate::state::{CapEnforcer, InMemoryStorage, InteractionTracker, TreatmentInteractionInput};

/// What an entitlement resolves to when nothing more specific applies.
pub use crate::adapters::EntitlementPolicy;

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
    cap_enforcer: CapEnforcer<InMemoryStorage>,
    default_entitlement_policy: EntitlementPolicy,
    enable_caps_enforcement: bool,
    user_id: String,
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
            cap_enforcer: CapEnforcer::new(InMemoryStorage::new(), tenant_id, user_id),
            default_entitlement_policy: EntitlementPolicy::default(),
            enable_caps_enforcement: true,
            user_id: user_id.to_string(),
        }
    }

    /// Override the default entitlement policy (`allow` unless set).
    #[must_use]
    pub fn with_entitlement_policy(mut self, policy: EntitlementPolicy) -> Self {
        self.default_entitlement_policy = policy;
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
    /// Pipeline: **suppression → providers → resolver → caps**. Each stage can
    /// veto, and the order decides which reason the caller sees — a placement
    /// that is both interaction-suppressed and cap-exceeded reports the
    /// suppression, because that is the earlier and more specific answer.
    ///
    /// Source: engine.ts:79-147
    pub fn get_placement_decision(&mut self, input: &PlacementDecisionInput) -> Value {
        // 1. Interaction suppression short-circuits everything downstream: a
        //    dismissed placement must not even be resolved.
        let suppression =
            self.interaction_tracker
                .check_suppression(&input.placement_id, &input.user_id, None);
        if suppression.suppressed {
            let name = self
                .registered
                .get(&input.placement_id)
                .and_then(|r| str_at(r, &["name"]))
                .unwrap_or(&input.placement_id)
                .to_string();

            let mut decision = json!({
                "placement_id": input.placement_id,
                "visible": false,
                "decision_source": "cache",
                "reason_codes": suppression.reason.clone().map_or_else(|| json!([]), |r| json!([r])),
                "content": Value::Object(decision_content(
                    &format!("{name} suppressed"),
                    "Suppressed due to recent interaction state.",
                    "Continue",
                )),
            });
            if let Some(reason) = suppression.reason {
                decision["suppression_reason"] = json!(reason);
            }
            return decision;
        }

        // 2-4. Providers → resolver.
        let context = json!({ "__providers": self.providers });
        let placement = self.registered.get(&input.placement_id).cloned();
        let mut decision =
            self.resolver
                .resolve(&input.placement_id, placement.as_ref(), Some(&context));

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
    pub fn track_interaction(&mut self, input: &TreatmentInteractionInput) {
        self.interaction_tracker.track(input);
    }

    /// Clear a placement's suppression window.
    pub fn clear_suppression(&mut self, placement_id: &str, user_id: &str) {
        self.interaction_tracker
            .clear_suppression(placement_id, user_id, None);
    }

    // ── Entitlements ───────────────────────────────────────────────────────

    /// Check entitlement access.
    ///
    /// Provider-backed first; the ExportedConfig-rule evaluator is the
    /// fallback, used **only** when no entitlements provider is registered.
    ///
    /// Source: local-runtime.ts:198-214
    #[must_use]
    pub fn check_entitlement(
        &self,
        handle: &str,
        context: Option<&Value>,
    ) -> EntitlementCheckResult {
        let result = self.derive_entitlement_result(handle, context);
        if result.reason.as_deref() == Some("no_entitlement_provider") {
            return self.derive_entitlement_from_config(handle, context, result);
        }
        result
    }

    /// Source: engine.ts:186-229
    fn derive_entitlement_result(
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
                        return derive_result_from_rule_type_fields(&tf, used);
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

    /// The ExportedConfig-rule fallback, used only when no entitlements
    /// provider exists.
    ///
    /// # Deliberately plan- and segment-agnostic
    ///
    /// The plan handle is passed as `""` and the segment set empty — **not**
    /// the user's real values — because that is what the canonical TS does
    /// (`local-runtime.ts` `deriveEntitlementFromConfig`). An empty handle
    /// normalizes to "no plan reference", which makes the matcher SKIP plan
    /// targeting entirely, so on this path a rule targeting any plan matches
    /// every user.
    ///
    /// Passing the real plan handle here looks more correct and is what this
    /// port did first — it made `feat_pro_only` (a rule targeting `pro`, user
    /// on `starter`) come back denied where TS returns allowed. The corpus
    /// caught it. TS is canonical, so the port matches TS; if the
    /// plan-agnostic fallback is wrong, it is wrong in the shared contract and
    /// must change in all three ports together.
    ///
    /// Source: local-runtime.ts:431-445 (deriveEntitlementFromConfig)
    fn derive_entitlement_from_config(
        &self,
        handle: &str,
        context: Option<&Value>,
        provider_result: EntitlementCheckResult,
    ) -> EntitlementCheckResult {
        // Plan 194 REQ-1: evaluate against the runtime's ACTUAL plan. This
        // used to hardcode `""`, so the fallback evaluated plan-targeted rules
        // against no plan — and the evaluator papered over that by skipping
        // the plan filter, matching every rule and granting. The plan provider
        // is present even when the entitlements one is not, which is the only
        // reason this branch runs at all.
        let current_plan_handle = self
            .providers
            .get("plan")
            .and_then(|p| p.get("current_plan_handle"))
            .and_then(Value::as_str)
            .unwrap_or("");

        let input = LocalEntitlementInput {
            handle,
            context_used: context.and_then(|c| c.get("used")).and_then(Value::as_f64),
            current_plan_handle,
            segment_ids: HashSet::new(),
            usage_balances: HashMap::new(),
            user_usage: None,
        };
        derive_local_entitlement_from_configured_rules(&input, &self.config)
            .unwrap_or(provider_result)
    }
}

/// Single compatibility boundary for component_type / surface_type.
fn placement_component_type(config: &Value) -> Option<&str> {
    config
        .get("component_type")
        .or_else(|| config.get("surface_type"))
        .and_then(Value::as_str)
}
