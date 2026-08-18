//! The static placement resolver.
//!
//! Builds a candidate index from a Playbook once, then answers placement
//! decisions against it. This is the orchestrator: it drives the trigger
//! readers ([`super::local_resolver`]) and the four gates
//! ([`super::entitlement_gate_gating`] and friends) over the candidates, picks
//! a winner, and shapes the decision.
//!
//! # Content-linked overlay (plan 77)
//!
//! When the Playbook ships content-linked payloads plus the message blocks
//! they point at, the winner's display copy is re-resolved against the user's
//! segments and overlaid. **Selection is unchanged** — only display fields are
//! swapped, and the `__`-prefixed meta keys survive because the existing
//! content is spread first.
//!
//! The TS routes this through a `PlacementContentLookupProvider`. That provider
//! is a static lookup over three arrays, and its resolution path is
//! `resolve_payload_for_user` restricted to flat-OR segment matching — so this
//! calls that function directly with `segment_dimensions: None` rather than
//! introducing a trait whose only implementation would be the static one.
//!
//! Source: revturbine-scaffold/src/placements/controllers/local-resolver.ts

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use super::entitlement_gate_gating::{matches_entitlement_gate_trigger, EntitlementGateTrigger};
use super::local_resolver::{
    decision_content, header_str, is_finite_number, normalize_cta_path,
    read_entitlement_handle_from_trigger, read_json_entitlement_gate_trigger,
    read_json_qualifier_trigger, read_json_threshold_trigger, read_slot_id_from_trigger,
};
use super::payload_resolution::{js_string, next_token, resolve_payload_for_user};
use super::qualifier_gating::{matches_qualifier_trigger, QualifierTrigger};
use super::threshold_gating::{matches_threshold_trigger, ThresholdTrigger};
use super::trial_gating::{
    apply_milestone_supersession, compute_user_elapsed_percent, matches_trial_trigger,
    normalize_json_trigger, TrialCandidate, TrialTrigger,
};
use crate::js_num::js_math_round;
use crate::rules::plan_eligibility::{
    evaluate_plan_eligibility, PlanEligibilityContext, PlanEligibilityRule,
};

/// Built-in surface-template → surface-type mapping, extended by the
/// Playbook's own `surface_templates`.
const DEFAULT_TEMPLATE_TO_SURFACE: &[(&str, &str)] = &[
    ("modal_overlay", "modal"),
    ("banner_placement", "banner"),
    ("in_page_card", "in_page"),
    ("inline_gate_message", "in_page"),
    ("usage_counter", "in_page"),
    ("button", "button"),
    ("email", "email"),
    ("full_page", "full_page"),
];

/// Slot category → the entry categories it prefers.
fn preferred_categories(slot_category: &str) -> Option<&'static [&'static str]> {
    match slot_category {
        "gated" => Some(&["gated"]),
        "fixed" => Some(&["fixed"]),
        "triggered" => Some(&[
            "usage_credit_seat",
            "trials",
            "other_conversion",
            "retention",
        ]),
        _ => None,
    }
}

/// Substitute `{{token}}` markers, sourcing values from `tokens`.
///
/// An absent or null value leaves a **whitespace-collapsed** literal —
/// `{{ name }}` becomes `{{name}}`. That differs from
/// [`super::payload_resolution::resolve_tokens`], which preserves the original
/// match verbatim, and the difference is load-bearing for byte parity.
///
/// Source: local-resolver.ts:62-67
#[must_use]
pub fn interpolate_string_tokens(template: &str, tokens: &Map<String, Value>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut cursor = 0usize;

    while let Some((start, end, name)) = next_token(template, cursor) {
        out.push_str(&template[cursor..start]);
        match tokens.get(name).filter(|v| !v.is_null()) {
            Some(v) => out.push_str(&js_string(v)),
            // Collapsed, NOT the original slice.
            None => {
                out.push_str("{{");
                out.push_str(name);
                out.push_str("}}");
            }
        }
        cursor = end;
    }
    out.push_str(&template[cursor..]);
    out
}

/// Interpolate string-valued content fields, using the content map itself as
/// the token source.
///
/// Source: local-resolver.ts:69-79
#[must_use]
pub fn interpolate_content_tokens(content: &Map<String, Value>) -> Map<String, Value> {
    content
        .iter()
        .map(|(k, v)| {
            let out = match v {
                Value::String(s) => Value::String(interpolate_string_tokens(s, content)),
                other => other.clone(),
            };
            (k.clone(), out)
        })
        .collect()
}

/// One indexed candidate: its output plus every normalized trigger.
#[derive(Debug, Clone)]
struct CandidateOutput {
    output: Value,
    entry_order: i64,
    entry_category: Option<String>,
    trigger_entitlement_handle: Option<String>,
    trigger_slot_id: Option<String>,
    trial_trigger: Option<TrialTrigger>,
    threshold_trigger: Option<ThresholdTrigger>,
    qualifier_trigger: Option<QualifierTrigger>,
    entitlement_gate_trigger: Option<EntitlementGateTrigger>,
}

/// A placement resolver built once from a Playbook.
pub struct StaticPlacementResolver {
    candidates: Vec<CandidateOutput>,
    by_template: HashMap<String, Vec<usize>>,
    by_name: HashMap<String, usize>,
    tier_ladders_by_handle: HashMap<String, Vec<String>>,
    plan_handle_to_id: HashMap<String, String>,
    /// Content-linked payloads + blocks + tokens, when the Playbook ships them.
    content_linked: Option<ContentLinked>,
}

/// The three arrays the content-linked overlay resolves against.
struct ContentLinked {
    payloads: Vec<Value>,
    message_blocks: Vec<Value>,
    tokens: Vec<Value>,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

/// Adapt the Playbook's studio-shaped content-linked payloads into the
/// `ContentPlacementPayload` shape the overlay resolves against.
///
/// Each content-linked payload carries a `content_link.message_block_id`; its
/// `surface_template_id` is keyed off the LINKED PLACEMENT's surface template,
/// so a lookup for the winning candidate's template matches. Payloads with no
/// `content_link` are inline and skipped.
///
/// `None` when the Playbook ships no content-linked payloads or no message
/// blocks — callers then keep the inline surface content.
///
/// Source: local-resolver.ts buildJsonContentProvider
fn build_content_linked(exported_config: &Value, placements: &[Value]) -> Option<ContentLinked> {
    let message_blocks: Vec<Value> = exported_config
        .get("message_blocks")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())?
        .clone();
    let studio_payloads = exported_config
        .get("placement_payloads")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())?;

    // placement id → surface template id, from the same active-payload surface
    // the inline candidate was built from.
    let mut placement_template: HashMap<String, String> = HashMap::new();
    for entry in placements {
        let Some(id) = s(entry, "id") else { continue };
        let template = entry
            .get("payloads")
            .and_then(Value::as_array)
            .and_then(|ps| {
                ps.iter()
                    .find(|p| p.get("status").and_then(Value::as_str) == Some("active"))
            })
            .and_then(|p| p.get("surfaces"))
            .and_then(Value::as_array)
            .and_then(|v| v.first())
            .and_then(|surface| s(surface, "template_id"));
        if let Some(t) = template {
            placement_template.insert(id, t);
        }
    }

    let mut payloads: Vec<Value> = Vec::new();
    for p in studio_payloads {
        let Some(link) = p.get("content_link").filter(|l| l.is_object()) else {
            continue; // inline payload
        };
        let Some(block_id) = s(link, "message_block_id") else {
            continue;
        };
        let Some(template_id) =
            s(p, "placement_id").and_then(|pid| placement_template.get(&pid).cloned())
        else {
            continue;
        };

        // Anything not explicitly active/draft is inactive — an unrecognized
        // status must not read as publishable.
        let status = match p.get("status").and_then(Value::as_str) {
            Some("active") => "active",
            Some("draft") => "draft",
            _ => "inactive",
        };

        payloads.push(json!({
            "payload_id": p.get("payload_id").cloned().unwrap_or(Value::Null),
            "tenant_id": "",
            "name": p.get("payload_id").cloned().unwrap_or(Value::Null),
            "surface_template_id": template_id,
            "default_message_block_id": block_id,
            "ui_path_id": link.get("ui_path_id").cloned().unwrap_or(Value::Null),
            "promotion_id": link.get("promotion_id").cloned().unwrap_or(Value::Null),
            "status": status,
        }));
    }

    if payloads.is_empty() {
        return None;
    }

    Some(ContentLinked {
        payloads,
        message_blocks,
        tokens: exported_config
            .get("personalization_tokens")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    })
}

impl StaticPlacementResolver {
    /// Build the candidate index from a Playbook and its placement dataset.
    #[must_use]
    pub fn new(placements: &[Value], exported_config: &Value) -> Self {
        let mut template_to_surface: HashMap<String, String> = DEFAULT_TEMPLATE_TO_SURFACE
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        for t in exported_config
            .get("surface_templates")
            .and_then(Value::as_array)
            .unwrap_or(&vec![])
        {
            if let (Some(id), Some(st)) = (s(t, "id"), s(t, "surface_type")) {
                template_to_surface.insert(id, st);
            }
        }

        // Resolve by handle: the canonical Playbook is handle-only (post
        // plan-120). `id` is the legacy fallback.
        let mut plan_handle_to_id = HashMap::new();
        for p in exported_config
            .get("plans")
            .and_then(Value::as_array)
            .unwrap_or(&vec![])
        {
            if let Some(handle) = s(p, "unique_handle") {
                let id = s(p, "id").unwrap_or_else(|| handle.clone());
                plan_handle_to_id.insert(handle, id);
            }
        }

        // Ordered tier ladder per entitlement handle — ARRAY ORDER IS RANK.
        let mut tier_ladders_by_handle: HashMap<String, Vec<String>> = HashMap::new();
        for ent in exported_config
            .get("entitlements")
            .and_then(Value::as_array)
            .unwrap_or(&vec![])
        {
            let Some(handle) = s(ent, "unique_handle") else {
                continue;
            };
            let handles: Vec<String> = ent
                .get("tier_definitions")
                .and_then(Value::as_array)
                .map(|defs| defs.iter().filter_map(|t| s(t, "handle")).collect())
                .unwrap_or_default();
            if !handles.is_empty() {
                tier_ladders_by_handle.insert(handle, handles);
            }
        }

        let config_version = exported_config
            .get("format_version")
            .or_else(|| exported_config.get("version"))
            .cloned()
            .unwrap_or(Value::Null);

        let mut candidates: Vec<CandidateOutput> = Vec::new();
        let mut by_template: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_name: HashMap<String, usize> = HashMap::new();

        for entry in placements {
            // Only the first ACTIVE payload is considered.
            let Some(payload) = entry
                .get("payloads")
                .and_then(Value::as_array)
                .and_then(|ps| {
                    ps.iter()
                        .find(|p| p.get("status").and_then(Value::as_str) == Some("active"))
                })
            else {
                continue;
            };

            let Some(surface) = payload
                .get("surfaces")
                .and_then(Value::as_array)
                .and_then(|v| v.first())
                .filter(|s| s.is_object())
            else {
                continue;
            };

            let Some(template_id) = s(surface, "template_id") else {
                continue;
            };
            let surface_type = template_to_surface
                .get(&template_id)
                .cloned()
                .unwrap_or_else(|| "custom".to_string());

            let mut content = surface
                .get("fields")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();

            let ctas = surface.get("ctas").and_then(Value::as_array);
            let cta0 = ctas.and_then(|c| c.first());
            let cta1 = ctas.and_then(|c| c.get(1));
            if let Some(c) = cta0 {
                content.insert(
                    "cta_label".into(),
                    c.get("label").cloned().unwrap_or(Value::Null),
                );
            }
            if let Some(c) = cta1 {
                content.insert(
                    "secondary_cta_label".into(),
                    c.get("label").cloned().unwrap_or(Value::Null),
                );
            }

            let entry_id = entry.get("id").cloned().unwrap_or(Value::Null);
            let trigger = entry.get("trigger");
            let trigger_entitlement_handle =
                read_entitlement_handle_from_trigger(trigger).map(str::to_string);

            // `__`-prefixed meta keys ride on content, matching the TS.
            if let Some(target_plan_ids) = payload
                .get("target")
                .filter(|t| t.is_object())
                .map(|t| t.get("plan_ids").cloned().unwrap_or(json!([])))
            {
                let ids = if target_plan_ids.is_array() {
                    target_plan_ids
                } else {
                    json!([])
                };
                content.insert("__target_plan_ids".into(), ids);
            }
            if let Some(h) = trigger_entitlement_handle.as_ref() {
                content.insert("__trigger_entitlement_handle".into(), json!(h));
            }

            let trial_trigger = normalize_json_trigger(trigger);
            if let Some(kind) = trial_trigger.as_ref().map(trial_kind) {
                content.insert("__trigger_kind".into(), json!(kind));
            }

            let output = json!({
                "output_id": payload.get("id").cloned().unwrap_or(Value::Null),
                "category": entry.get("category").cloned().unwrap_or(Value::Null),
                "surface": {
                    "template": template_id,
                    "type": surface_type,
                    "slot_id": entry_id,
                },
                "content": Value::Object(content),
                "cta_path": Value::Object(normalize_cta_path(cta0)),
                "rule_id": entry_id,
                "decision_id": payload.get("id").cloned().unwrap_or(Value::Null),
                "config_version": config_version,
                "present_upsell": true,
            });

            let idx = candidates.len();
            candidates.push(CandidateOutput {
                output,
                entry_order: entry.get("order").and_then(Value::as_i64).unwrap_or(0),
                entry_category: s(entry, "category"),
                trigger_entitlement_handle: trigger_entitlement_handle.clone(),
                trigger_slot_id: read_slot_id_from_trigger(trigger).map(str::to_string),
                trial_trigger,
                threshold_trigger: read_json_threshold_trigger(
                    trigger,
                    trigger_entitlement_handle.as_deref(),
                ),
                qualifier_trigger: read_json_qualifier_trigger(trigger),
                entitlement_gate_trigger: read_json_entitlement_gate_trigger(
                    trigger,
                    trigger_entitlement_handle.as_deref(),
                ),
            });
            by_template.entry(template_id).or_default().push(idx);

            if let Some(id) = entry_id.as_str() {
                // Registered under both the bare and `pl_`-prefixed spellings.
                by_name.insert(id.trim_start_matches("pl_").to_string(), idx);
                by_name.insert(id.to_string(), idx);
            }
        }

        // Authored order decides ties throughout.
        for bucket in by_template.values_mut() {
            bucket.sort_by_key(|i| candidates[*i].entry_order);
        }

        Self {
            candidates,
            by_template,
            by_name,
            tier_ladders_by_handle,
            plan_handle_to_id,
            content_linked: build_content_linked(exported_config, placements),
        }
    }

    fn is_eligible_for_plan(
        &self,
        output: &Value,
        current_plan_id: Option<&str>,
        plan_handle: Option<&str>,
        billing_period: Option<&str>,
    ) -> bool {
        let content = output.get("content");
        let list = |key: &str| -> Vec<String> {
            content
                .and_then(|c| c.get(key))
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default()
        };

        evaluate_plan_eligibility(
            &PlanEligibilityRule {
                target_plan_ids: list("__target_plan_ids"),
                target_billing_periods: list("__target_billing_periods"),
                category: s(output, "category"),
            },
            &PlanEligibilityContext {
                current_plan_id: current_plan_id.map(str::to_string),
                plan_handle: plan_handle.map(str::to_string),
                billing_period: billing_period.map(str::to_string),
            },
        )
        .eligible
    }

    /// Resolve a placement decision.
    ///
    /// `placement` is the registered slot record (may carry
    /// `surface_template_ids` and slot metadata); `context` carries the
    /// resolved provider state under `__providers`.
    #[must_use]
    pub fn resolve(
        &self,
        placement_id: &str,
        placement: Option<&Value>,
        context: Option<&Value>,
    ) -> Value {
        let providers = context.and_then(|c| c.get("__providers"));
        let plan = providers.and_then(|p| p.get("plan"));
        let entitlements_state = providers.and_then(|p| p.get("entitlements"));
        let plan_handle = plan
            .and_then(|p| p.get("current_plan_handle"))
            .and_then(Value::as_str);
        let billing_period = plan
            .and_then(|p| p.get("billing_period"))
            .and_then(Value::as_str);
        let current_plan_id = plan_handle
            .and_then(|h| self.plan_handle_to_id.get(h))
            .map(String::as_str);

        // The TS record nests slot metadata; the port flattens it. Read the
        // nested map when present, else the record itself — works with both.
        let meta = placement
            .and_then(|p| p.get("metadata"))
            .filter(|m| m.is_object())
            .or(placement);

        let allowed_template_ids: Option<Vec<&str>> = meta
            .and_then(|m| m.get("surface_template_ids"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .filter(|v: &Vec<&str>| !v.is_empty());

        let mut selected: Option<Value> = None;
        let mut reason_codes: Vec<String> = Vec::new();

        if let Some(template_ids) = allowed_template_ids {
            let mut idxs: Vec<usize> = template_ids
                .iter()
                .filter_map(|tid| self.by_template.get(*tid))
                .flatten()
                .copied()
                .collect();

            if idxs.is_empty() {
                return self.not_visible(
                    placement_id,
                    "no_candidates_for_template",
                    "No placements configured for this surface template",
                );
            }
            idxs.sort_by_key(|i| self.candidates[*i].entry_order);

            let slot_entitlement_handle = meta
                .and_then(|m| m.get("entitlement_handle"))
                .and_then(Value::as_str);
            let slot_category = meta
                .and_then(|m| m.get("surface_slot_category"))
                .and_then(Value::as_str);
            let slot_id = meta
                .and_then(|m| m.get("surface_slot_id"))
                .and_then(Value::as_str);

            // Narrowing filters: each applies ONLY if it leaves something, so
            // a slot hint never empties the candidate set on its own.
            if let Some(h) = slot_entitlement_handle {
                let narrowed: Vec<usize> = idxs
                    .iter()
                    .copied()
                    .filter(|i| {
                        self.candidates[*i].trigger_entitlement_handle.as_deref() == Some(h)
                    })
                    .collect();
                if !narrowed.is_empty() {
                    idxs = narrowed;
                }
            }
            if let Some(sid) = slot_id {
                let narrowed: Vec<usize> = idxs
                    .iter()
                    .copied()
                    .filter(|i| self.candidates[*i].trigger_slot_id.as_deref() == Some(sid))
                    .collect();
                if !narrowed.is_empty() {
                    idxs = narrowed;
                }
            }

            // `fixed_only` is a HARD filter — a slot reserved for PM-wired
            // content must never render an RT-initiated nudge, even if that
            // leaves nothing to show.
            if meta
                .and_then(|m| m.get("fixed_only"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                idxs.retain(|i| self.candidates[*i].entry_category.as_deref() == Some("fixed"));
            }

            if let Some(prefs) = slot_category.and_then(preferred_categories) {
                if slot_category != Some("fixed") && idxs.len() > 1 {
                    let narrowed: Vec<usize> = idxs
                        .iter()
                        .copied()
                        .filter(|i| {
                            self.candidates[*i]
                                .entry_category
                                .as_deref()
                                .is_some_and(|c| prefs.contains(&c))
                        })
                        .collect();
                    if !narrowed.is_empty() {
                        idxs = narrowed;
                    }
                }
            }

            // The four gates.
            idxs.retain(|i| {
                matches_trial_trigger(self.candidates[*i].trial_trigger.as_ref(), plan)
            });
            idxs.retain(|i| {
                matches_threshold_trigger(
                    self.candidates[*i].threshold_trigger.as_ref(),
                    entitlements_state,
                )
            });
            idxs.retain(|i| {
                let c = &self.candidates[*i];
                matches_qualifier_trigger(
                    c.qualifier_trigger.as_ref(),
                    c.entry_category.as_deref().unwrap_or(""),
                    plan,
                )
            });
            idxs.retain(|i| {
                matches_entitlement_gate_trigger(
                    self.candidates[*i].entitlement_gate_trigger.as_ref(),
                    &self.tier_ladders_by_handle,
                    entitlements_state,
                )
            });

            // Milestone supersession: among crossed trial_progress candidates,
            // keep only the winner; non-progress candidates are untouched.
            let mut superseded_ids: Vec<String> = Vec::new();
            let mut winner_rule_id: Option<String> = None;
            if let Some(pct) = compute_user_elapsed_percent(plan) {
                if idxs.len() > 1 {
                    let tcs: Vec<TrialCandidate> = idxs
                        .iter()
                        .map(|i| {
                            let c = &self.candidates[*i];
                            TrialCandidate {
                                rule_id: s(&c.output, "rule_id"),
                                entry_order: c.entry_order,
                                trial_trigger: c.trial_trigger.clone(),
                            }
                        })
                        .collect();
                    if let Some(outcome) = apply_milestone_supersession(&tcs, pct) {
                        winner_rule_id = tcs[outcome.winner_index].rule_id.clone();
                        superseded_ids = outcome.superseded_ids;
                        idxs.retain(|i| {
                            let c = &self.candidates[*i];
                            !matches!(c.trial_trigger, Some(TrialTrigger::Progress { .. }))
                                || s(&c.output, "rule_id") == winner_rule_id
                        });
                    }
                }
            }

            for i in idxs {
                let c = &self.candidates[i];
                if self.is_eligible_for_plan(
                    &c.output,
                    current_plan_id,
                    plan_handle,
                    billing_period,
                ) {
                    let mut out = c.output.clone();
                    // Attach the supersession diagnostic only when the winner
                    // is the one actually selected.
                    if !superseded_ids.is_empty() && s(&out, "rule_id") == winner_rule_id {
                        if let Some(content) = out.get_mut("content").and_then(Value::as_object_mut)
                        {
                            content
                                .insert("__superseded_placement_ids".into(), json!(superseded_ids));
                        }
                    }
                    selected = Some(out);
                    break;
                }
            }
            if selected.is_none() {
                reason_codes.push("no_eligible_candidate".into());
            }
        } else {
            // Direct lookup: the registered slot name first, then the raw
            // placement id — so a caller can resolve without registering.
            let name = placement
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str);
            let idx = name
                .and_then(|n| self.by_name.get(n))
                .or_else(|| self.by_name.get(placement_id))
                .copied();

            match idx {
                None => reason_codes.push("placement_not_found".into()),
                Some(i) => {
                    let c = &self.candidates[i];
                    if !matches_trial_trigger(c.trial_trigger.as_ref(), plan) {
                        reason_codes.push("trial_trigger_unmet".into());
                    } else if !matches_threshold_trigger(
                        c.threshold_trigger.as_ref(),
                        entitlements_state,
                    ) {
                        reason_codes.push("threshold_trigger_unmet".into());
                    } else if !matches_qualifier_trigger(
                        c.qualifier_trigger.as_ref(),
                        c.entry_category
                            .as_deref()
                            .or_else(|| c.output.get("category").and_then(Value::as_str))
                            .unwrap_or(""),
                        plan,
                    ) {
                        reason_codes.push("qualifier_trigger_unmet".into());
                    } else if !matches_entitlement_gate_trigger(
                        c.entitlement_gate_trigger.as_ref(),
                        &self.tier_ladders_by_handle,
                        entitlements_state,
                    ) {
                        reason_codes.push("entitlement_gate_unmet".into());
                    } else if self.is_eligible_for_plan(
                        &c.output,
                        current_plan_id,
                        plan_handle,
                        billing_period,
                    ) {
                        selected = Some(c.output.clone());
                    } else {
                        reason_codes.push("plan_target_mismatch".into());
                    }
                }
            }
        }

        let Some(selected_output) = selected else {
            let code = reason_codes
                .first()
                .cloned()
                .unwrap_or_else(|| "placement_not_found".into());
            return self.not_visible(placement_id, &code, "Placement not configured");
        };

        self.shape_decision(placement_id, selected_output, providers, plan_handle)
    }

    /// Overlay content-linked copy onto the winner, resolved against the
    /// user's segments.
    ///
    /// Segment identity is the **handle** (plan 120): content overrides
    /// reference `segment_value_id` handles, so the user's set is keyed off
    /// `segment_slugs`, NOT `segment_ids`. Using ids here would match nothing
    /// and silently fall back to inline copy.
    ///
    /// No content-linked match leaves the inline content standing.
    fn apply_content_overlay(&self, selected_output: Value, providers: Option<&Value>) -> Value {
        let Some(linked) = self.content_linked.as_ref() else {
            return selected_output;
        };
        let Some(template_id) = selected_output
            .get("surface")
            .and_then(|s| s.get("template"))
            .and_then(Value::as_str)
        else {
            return selected_output;
        };

        let segment_slugs: Vec<String> = providers
            .and_then(|p| p.get("segments"))
            .and_then(|s| s.get("segment_slugs"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        // Flat-OR matching only, matching the TS `...WithProvider` path which
        // takes no options.
        let Some(resolved) = resolve_payload_for_user(
            template_id,
            &segment_slugs,
            &linked.payloads,
            &linked.message_blocks,
            &linked.tokens,
            &Map::new(),
            None,
        ) else {
            return selected_output;
        };

        let mut out = selected_output;
        if let Some(content) = out.get_mut("content").and_then(Value::as_object_mut) {
            // Spread the existing content first so the `__`-prefixed meta keys
            // (read by usage enrichment below) survive the overlay.
            for (k, v) in resolved.resolved_content {
                content.insert(k, v);
            }
        }
        out
    }

    fn not_visible(&self, placement_id: &str, code: &str, header: &str) -> Value {
        json!({
            "placement_id": placement_id,
            "visible": false,
            "decision_source": "fallback",
            "reason_codes": [code],
            "content": Value::Object(decision_content(header, "", "")),
        })
    }

    /// Enrich the winner with usage tokens, interpolate, and shape the
    /// decision.
    fn shape_decision(
        &self,
        placement_id: &str,
        selected_output: Value,
        providers: Option<&Value>,
        plan_handle: Option<&str>,
    ) -> Value {
        // ── Content-linked overlay (plan 77) ────────────────────────────
        // Runs BEFORE usage enrichment, so injected usage tokens are computed
        // against the copy the user will actually see.
        let selected_output = self.apply_content_overlay(selected_output, providers);

        let mut content = selected_output
            .get("content")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        // An explicit `entitlement` wins over the trigger's handle.
        let entitlement_handle = content
            .get("entitlement")
            .and_then(Value::as_str)
            .or_else(|| {
                content
                    .get("__trigger_entitlement_handle")
                    .and_then(Value::as_str)
            })
            .map(str::to_string);

        let usage_entry = entitlement_handle.as_ref().and_then(|h| {
            providers
                .and_then(|p| p.get("entitlements"))
                .and_then(|e| e.get("usage"))
                .and_then(|u| u.get(h))
                .filter(|e| e.is_object())
        });

        if let Some(entry) = usage_entry {
            let n = |k: &str| entry.get(k);
            let or_zero = |k: &str| {
                if is_finite_number(n(k)) {
                    n(k).cloned().unwrap_or(json!(0))
                } else {
                    json!(0)
                }
            };
            content.insert("usage_remaining".into(), or_zero("remaining"));
            content.insert("usage_limit".into(), or_zero("limit"));
            content.insert("usage_current".into(), or_zero("used"));

            let limit = n("limit").and_then(Value::as_f64).filter(|l| l.is_finite());
            let percent = match limit {
                Some(l) if l > 0.0 => {
                    // Non-finite `used` is treated as 0 to stay
                    // JSON-serializable; the TS would produce NaN here.
                    let used = n("used")
                        .and_then(Value::as_f64)
                        .filter(|u| u.is_finite())
                        .unwrap_or(0.0);
                    // js_math_round, NOT f64::round — ties break toward +inf.
                    js_math_round((used / l) * 100.0).min(100.0)
                }
                _ => 0.0,
            };
            content.insert("usage_percent".into(), json!(percent as i64));

            if let Some(rd) = n("reset_date")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                content.insert("reset_date".into(), json!(rd));
            }
        }

        let interpolated = interpolate_content_tokens(&content);
        let mut resolved_output = selected_output;
        resolved_output["content"] = Value::Object(interpolated.clone());

        // Upsell surfaces are suppressed for enterprise.
        let category = resolved_output.get("category").and_then(Value::as_str);
        let is_upsell = matches!(category, Some("upsell") | Some("trial_conversion"));
        let visible = !(is_upsell && plan_handle == Some("enterprise"));

        json!({
            "placement_id": placement_id,
            "visible": visible,
            "decision_source": "fallback",
            "reason_codes": if visible { json!([]) } else { json!(["plan_tier_suppressed"]) },
            "content": Value::Object(decision_content(
                &header_str(interpolated.get("header")),
                &header_str(interpolated.get("body")),
                &header_str(interpolated.get("cta_label")),
            )),
            "output": resolved_output,
        })
    }
}

fn trial_kind(t: &TrialTrigger) -> &'static str {
    match t {
        TrialTrigger::Started => "trial_started",
        TrialTrigger::Progress { .. } => "trial_progress",
        TrialTrigger::Ending { .. } => "trial_ending",
        TrialTrigger::Ended => "trial_ended",
        TrialTrigger::Converted => "trial_converted",
    }
}
