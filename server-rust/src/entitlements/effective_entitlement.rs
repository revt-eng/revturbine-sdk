//! Effective entitlements — the ONE answer every SDK runtime uses (D-61,
//! Kent 2026-10-06).
//!
//! The shared evaluator ([`super::derive_local_entitlement_from_configured_rules`])
//! decides each entitlement from the Playbook + user context. An app may then
//! enrich that answer with its own data ("Entitlement Mirroring"): grants on
//! `UserContext.entitlements` and/or an app-registered entitlement provider.
//! The two are merged with a configurable precedence — provider level
//! ([`EntitlementMergeOptions::precedence`], default [`EntitlementSource::App`])
//! with optional per-field overrides.
//!
//! Browser and server SDKs run this same function on the same inputs: the
//! browser result shapes interaction, the server result verifies it.
//!
//! An entitlement handle neither the Playbook nor the app knows is DENIED
//! (`entitlement_not_in_playbook`) and flagged
//! [`unknown_handle`](EffectiveEntitlement::unknown_handle), so the runtime can
//! warn and report it.
//!
//! Source: revturbine-scaffold/src/entitlements/controllers/effective-entitlement.ts

use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Number, Value};

use super::entitlement_check::{
    derive_local_entitlement_reporting, derive_result_with_allowance, has_positive_cost,
    report_entitlement_diagnostic, AppReportedNumbers, CostExtras, CostInput, CostTrace,
    LocalEntitlementInput,
};
use crate::decisions::{int_if_integral, EntitlementCheckResult};

/// Which side wins a merge: the app's own data, or the Playbook evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntitlementSource {
    /// App-supplied data (`UserContext.entitlements`, an app entitlement provider).
    App,
    /// The shared Playbook + user-context evaluation.
    Playbook,
}

/// Per-field overrides of [`EntitlementMergeOptions::precedence`]. `status`
/// carries `allowed` and `reason` with it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EntitlementMergeFields {
    /// Winner for `status` (+ `allowed`, `reason`).
    pub status: Option<EntitlementSource>,
    /// Winner for `limit`.
    pub limit: Option<EntitlementSource>,
    /// Winner for `used`.
    pub used: Option<EntitlementSource>,
    /// Winner for `remaining`.
    pub remaining: Option<EntitlementSource>,
}

/// How app-supplied entitlement data merges with the Playbook result.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EntitlementMergeOptions {
    /// Provider-level precedence. `None` means [`EntitlementSource::App`]:
    /// app-supplied data wins.
    pub precedence: Option<EntitlementSource>,
    /// Per-field overrides of `precedence`.
    pub fields: EntitlementMergeFields,
}

impl EntitlementMergeOptions {
    fn winner(&self, field: Option<EntitlementSource>) -> EntitlementSource {
        field.or(self.precedence).unwrap_or(EntitlementSource::App)
    }
}

/// The app's view of one entitlement — the TS `Partial<EntitlementResult>`
/// the merge reads. Every field is optional; `None` is TS `undefined`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PartialEntitlement {
    /// `allowed` | `limited` | `denied`.
    pub status: Option<String>,
    /// Whether the caller may proceed.
    pub allowed: Option<bool>,
    /// The governing limit.
    pub limit: Option<Number>,
    /// Consumption counted against `limit`.
    pub used: Option<Number>,
    /// `max(0, limit - used)` unless supplied.
    pub remaining: Option<Number>,
    /// Machine-readable cause.
    pub reason: Option<String>,
}

impl PartialEntitlement {
    fn is_empty(&self) -> bool {
        self == &Self::default()
    }

    /// `{ ...self, ...over }` — every field `over` defines wins.
    fn overlaid_with(self, over: Self) -> Self {
        Self {
            status: over.status.or(self.status),
            allowed: over.allowed.or(self.allowed),
            limit: over.limit.or(self.limit),
            used: over.used.or(self.used),
            remaining: over.remaining.or(self.remaining),
            reason: over.reason.or(self.reason),
        }
    }
}

/// The app's data for one entitlement handle.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AppEntitlementInputs {
    /// `UserContext.entitlements[handle]`: a boolean, or a grant-shaped
    /// record (`status` / `allowed` / `limit` / `used` / `remaining` /
    /// `reason`).
    pub user_context: Option<Value>,
    /// The entry an app-registered entitlement provider supplied for the
    /// handle.
    pub provider: Option<Value>,
}

/// JS truthiness for a JSON value.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

const STATUSES: [&str; 3] = ["allowed", "limited", "denied"];

/// Source: effective-entitlement.ts (fromMirrored)
fn from_mirrored(value: Option<&Value>) -> Option<PartialEntitlement> {
    let record = match value? {
        Value::Bool(b) => {
            return Some(PartialEntitlement {
                status: Some(if *b { "allowed" } else { "denied" }.to_string()),
                allowed: Some(*b),
                ..PartialEntitlement::default()
            })
        }
        Value::Object(record) => record,
        _ => return None,
    };
    let mut out = PartialEntitlement::default();
    if let Some(status) = record
        .get("status")
        .and_then(Value::as_str)
        .filter(|s| STATUSES.contains(s))
    {
        out.status = Some(status.to_string());
        out.allowed = Some(
            record
                .get("allowed")
                .and_then(Value::as_bool)
                .unwrap_or(status != "denied"),
        );
    } else if let Some(allowed) = record.get("allowed").and_then(Value::as_bool) {
        // ST-1741 D-6: `allowed` with no valid `status` sets the answer on its
        // own (it was ignored on 0.16.0): true is `allowed`, false is `denied`.
        // The result then carries reason `entitlement_mirrored` and NO
        // `rule_handle` (the app, not a rule, decided).
        out.status = Some(if allowed { "allowed" } else { "denied" }.to_string());
        out.allowed = Some(allowed);
    }
    // A `serde_json::Number` is always finite, so `as_number` is exactly
    // `typeof v === 'number' && Number.isFinite(v)`.
    let finite = |key: &str| record.get(key).and_then(Value::as_number).cloned();
    out.limit = finite("limit");
    out.used = finite("used");
    out.remaining = finite("remaining").or_else(|| {
        let limit = out.limit.as_ref()?.as_f64()?;
        let used = out.used.as_ref()?.as_f64()?;
        int_if_integral((limit - used).max(0.0))
    });
    out.reason = record
        .get("reason")
        .and_then(Value::as_str)
        .map(str::to_string);
    (!out.is_empty()).then_some(out)
}

/// ST-1741: was the app's `remaining` DERIVED from its `limit` and `used` (it
/// sent no explicit `remaining`)? Follows [`app_entitlement`]'s overlay: the
/// provider entry's `remaining` replaces the user-context one when it has one.
///
/// Source: effective-entitlement.ts (remainingWasDerived)
fn remaining_was_derived(inputs: Option<&AppEntitlementInputs>) -> bool {
    let explicit = |value: Option<&Value>| {
        value
            .and_then(Value::as_object)
            .is_some_and(|record| record.get("remaining").and_then(Value::as_number).is_some())
    };
    let provider = inputs
        .and_then(|i| i.provider.as_ref())
        .filter(|p| js_truthy(p));
    let provider_remaining = provider
        .and_then(|p| from_mirrored(Some(p)))
        .and_then(|p| p.remaining);
    if provider_remaining.is_some() {
        !explicit(provider)
    } else {
        !explicit(inputs.and_then(|i| i.user_context.as_ref()))
    }
}

/// The app's view of one entitlement. A provider entry is the app's live
/// system, so its fields override a `UserContext` grant field by field.
///
/// Source: effective-entitlement.ts (appEntitlement)
#[must_use]
pub fn app_entitlement(inputs: Option<&AppEntitlementInputs>) -> Option<PartialEntitlement> {
    let inputs = inputs?;
    let from_user = from_mirrored(inputs.user_context.as_ref());
    let from_provider = inputs
        .provider
        .as_ref()
        .filter(|p| js_truthy(p))
        .and_then(|p| from_mirrored(Some(p)));
    match (from_user, from_provider) {
        (None, None) => None,
        (user, provider) => Some(
            user.unwrap_or_default()
                .overlaid_with(provider.unwrap_or_default()),
        ),
    }
}

/// Merge the Playbook evaluation with the app's data. Each field comes from
/// its configured winner when that side has it, else from the other side.
/// `status` moves with `allowed` and `reason`; an app-sourced status with no
/// reason reports `entitlement_mirrored`. `rule_handle` survives only when
/// the status comes from the Playbook.
///
/// Source: effective-entitlement.ts (mergeEntitlementResults)
#[must_use]
pub fn merge_entitlement_results(
    playbook: Option<&EntitlementCheckResult>,
    app: Option<&PartialEntitlement>,
    options: &EntitlementMergeOptions,
) -> Option<EntitlementCheckResult> {
    let Some(app) = app else {
        return playbook.cloned();
    };
    // The first side, in the field's precedence order, that has the value.
    let source = |winner: Option<EntitlementSource>,
                  from_app: Option<&Number>,
                  from_playbook: Option<&Number>| {
        let has = |side: EntitlementSource| match side {
            EntitlementSource::App => from_app.is_some(),
            EntitlementSource::Playbook => from_playbook.is_some(),
        };
        let first = options.winner(winner);
        let second = match first {
            EntitlementSource::App => EntitlementSource::Playbook,
            EntitlementSource::Playbook => EntitlementSource::App,
        };
        [first, second].into_iter().find(|side| has(*side))
    };
    let pick = |winner: Option<EntitlementSource>,
                from_app: Option<&Number>,
                from_playbook: Option<&Number>| {
        match source(winner, from_app, from_playbook)? {
            EntitlementSource::App => from_app.cloned(),
            EntitlementSource::Playbook => from_playbook.cloned(),
        }
    };

    let app_status = app.status.as_deref().filter(|_| {
        options.winner(options.fields.status) == EntitlementSource::App || playbook.is_none()
    });
    let mut out = match (app_status, playbook) {
        (Some(status), _) => {
            let mut base =
                EntitlementCheckResult::new(status, app.allowed.unwrap_or(status != "denied"));
            base.reason = Some(
                app.reason
                    .clone()
                    .unwrap_or_else(|| "entitlement_mirrored".to_string()),
            );
            base
        }
        // Spreads the whole Playbook result — `rule_handle` and
        // `current_tier` included.
        (None, Some(evaluated)) => evaluated.clone(),
        (None, None) => {
            EntitlementCheckResult::with_reason("denied", false, "entitlement_not_in_playbook")
        }
    };

    let limit_sides = (
        options.fields.limit,
        app.limit.as_ref(),
        playbook.and_then(|p| p.limit.as_ref()),
    );
    let used_sides = (
        options.fields.used,
        app.used.as_ref(),
        playbook.and_then(|p| p.used.as_ref()),
    );
    let remaining_sides = (
        options.fields.remaining,
        app.remaining.as_ref(),
        playbook.and_then(|p| p.remaining.as_ref()),
    );
    let limit = pick(limit_sides.0, limit_sides.1, limit_sides.2);
    let used = pick(used_sides.0, used_sides.1, used_sides.2);

    // Keep the numbers coherent: when `remaining` would come from a different
    // source than `limit` or `used`, derive it from the merged pair instead.
    let remaining_source = source(remaining_sides.0, remaining_sides.1, remaining_sides.2);
    let mixed = remaining_source.is_some()
        && ((used.is_some()
            && source(used_sides.0, used_sides.1, used_sides.2) != remaining_source)
            || (limit.is_some()
                && source(limit_sides.0, limit_sides.1, limit_sides.2) != remaining_source));
    out.remaining = match (&limit, &used) {
        (Some(l), Some(u)) if mixed => l
            .as_f64()
            .zip(u.as_f64())
            .and_then(|(l, u)| int_if_integral((l - u).max(0.0))),
        _ => pick(remaining_sides.0, remaining_sides.1, remaining_sides.2),
    };
    out.limit = limit;
    out.used = used;
    Some(out)
}

/// The evaluator inputs [`reverse_trial_grants`] derives.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReverseTrialGrants {
    /// The matching rule's `entitlements_during_trial[]`.
    pub trial_granted_entitlement_handles: Option<HashSet<String>>,
    /// The rule's `premium_plan_id` — the plan the granted handles evaluate
    /// against.
    pub effective_plan_handle: Option<String>,
}

/// Reverse-trial grants (plan 43): a user mid-reverse-trial holds the
/// matching rule's `entitlements_during_trial[]`, evaluated against the
/// premium plan. Shared by every runtime so a server verifies exactly what the
/// browser granted.
///
/// `trial` is the user's `UserTrialStatus`; `in_trial`, `trial_type` and
/// `plan_handle` (the user's BASE plan while on a reverse trial) are read.
///
/// Source: effective-entitlement.ts (reverseTrialGrants)
#[must_use]
pub fn reverse_trial_grants(playbook: &Value, trial: Option<&Value>) -> ReverseTrialGrants {
    let Some(trial) = trial else {
        return ReverseTrialGrants::default();
    };
    let in_trial = trial.get("in_trial").is_some_and(js_truthy);
    let reverse = trial.get("trial_type").and_then(Value::as_str) == Some("reverse");
    let Some(plan_handle) = trial.get("plan_handle").filter(|p| js_truthy(p)) else {
        return ReverseTrialGrants::default();
    };
    if !in_trial || !reverse {
        return ReverseTrialGrants::default();
    }
    let rule = playbook
        .get("reverse_trial_rules")
        .and_then(Value::as_array)
        .and_then(|rules| {
            rules.iter().find(|r| {
                r.get("fallback_plan_id") == Some(plan_handle)
                    && r.get("is_active") != Some(&Value::Bool(false))
            })
        });
    let Some(during) = rule
        .and_then(|r| r.get("entitlements_during_trial"))
        .and_then(Value::as_array)
        .filter(|d| !d.is_empty())
    else {
        return ReverseTrialGrants::default();
    };
    ReverseTrialGrants {
        trial_granted_entitlement_handles: Some(
            during
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        ),
        effective_plan_handle: rule
            .and_then(|r| r.get("premium_plan_id"))
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// Every [`derive_effective_entitlement`] input except the handle and the
/// app data — what a runtime builds once and reuses per handle.
///
/// Source: `Omit<EffectiveEntitlementInput, 'handle' | 'app'>`
#[derive(Debug, Clone, Default)]
pub struct EffectiveEntitlementBase<'a> {
    /// The Playbook. `None` knows no handle.
    pub playbook: Option<&'a Value>,
    /// Explicit usage override (`context.used`).
    pub context_used: Option<f64>,
    /// The caller's `{ balance }` (`context.balance`), the remaining credits.
    pub context_balance: Option<f64>,
    /// The caller's per-call `cost` (`context.cost`), raw (ST-1696).
    pub context_cost: Option<Value>,
    /// The user's plan handle.
    pub current_plan_handle: String,
    /// Segments the user belongs to.
    pub segment_ids: HashSet<String>,
    /// Per-entitlement consumption.
    pub usage_balances: HashMap<String, f64>,
    /// Per-entitlement `{amount}` records.
    pub user_usage: Option<&'a Value>,
    /// Reverse-trial grants — see [`reverse_trial_grants`].
    pub trial_granted_entitlement_handles: Option<HashSet<String>>,
    /// The granted plan reverse-trial handles evaluate against.
    pub effective_plan_handle: Option<String>,
    /// How app data merges with the Playbook evaluation.
    pub merge: EntitlementMergeOptions,
    /// Current purchased holdings.
    pub addons: Option<&'a Value>,
    /// Base plan billing cadence.
    pub billing_period: Option<&'a str>,
}

impl EffectiveEntitlementBase<'_> {
    /// Apply [`reverse_trial_grants`]' output (`...reverseTrialGrants(...)`).
    #[must_use]
    pub fn with_reverse_trial_grants(mut self, grants: ReverseTrialGrants) -> Self {
        if grants.trial_granted_entitlement_handles.is_some() {
            self.trial_granted_entitlement_handles = grants.trial_granted_entitlement_handles;
            self.effective_plan_handle = grants.effective_plan_handle;
        }
        self
    }
}

/// One handle's effective answer.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveEntitlement {
    /// The merged verdict.
    pub result: EntitlementCheckResult,
    /// Neither the Playbook nor the app knows this handle (denied; warn +
    /// report).
    pub unknown_handle: bool,
}

fn playbook_knows(playbook: &Value, handle: &str) -> bool {
    playbook
        .get("entitlements")
        .and_then(Value::as_array)
        .is_some_and(|ents| {
            ents.iter()
                .any(|e| e.get("unique_handle").and_then(Value::as_str) == Some(handle))
        })
}

/// The effective entitlement for one handle.
///
/// An invalid purchased holding or incompatible additive grant fails closed
/// (`invalid_purchased_allowance`); [`try_derive_effective_entitlement`]
/// returns its message instead.
///
/// Source: effective-entitlement.ts (deriveEffectiveEntitlement)
#[must_use]
pub fn derive_effective_entitlement(
    handle: &str,
    base: &EffectiveEntitlementBase,
    app: Option<&AppEntitlementInputs>,
) -> EffectiveEntitlement {
    // A single-handle check: carries and routes the cost diagnostic (ST-1696).
    let effective = derive_effective_entitlement_reporting(handle, base, app, &mut None, true);
    report_entitlement_diagnostic(&effective.result);
    effective
}

/// [`derive_effective_entitlement`], but the Playbook evaluation's purchased
/// allowance rejection is returned as the error TS throws (BUG-554).
///
/// # Errors
///
/// The purchased-holding validation or allowance-compatibility message.
///
/// Source: effective-entitlement.ts (deriveEffectiveEntitlement)
pub fn try_derive_effective_entitlement(
    handle: &str,
    base: &EffectiveEntitlementBase,
    app: Option<&AppEntitlementInputs>,
) -> Result<EffectiveEntitlement, String> {
    let mut error = None;
    let effective = derive_effective_entitlement_reporting(handle, base, app, &mut error, true);
    if error.is_none() {
        report_entitlement_diagnostic(&effective.result);
    }
    error.map_or(Ok(effective), Err)
}

fn derive_effective_entitlement_reporting(
    handle: &str,
    base: &EffectiveEntitlementBase,
    app: Option<&AppEntitlementInputs>,
    error: &mut Option<String>,
    diagnostics: bool,
) -> EffectiveEntitlement {
    let app_view = app_entitlement(app);
    let known_playbook = base.playbook.filter(|pb| playbook_knows(pb, handle));
    if known_playbook.is_none() && app_view.is_none() {
        return EffectiveEntitlement {
            result: EntitlementCheckResult::with_reason(
                "denied",
                false,
                "entitlement_not_in_playbook",
            ),
            unknown_handle: true,
        };
    }
    // App-mirrored usage is an INPUT to the Playbook evaluation (when `used`
    // follows the app), so the evaluated status reflects it — not a number
    // pasted on afterwards.
    let follows =
        |field: Option<EntitlementSource>| base.merge.winner(field) == EntitlementSource::App;
    let mut usage_balances = base.usage_balances.clone();
    if follows(base.merge.fields.used) {
        if let Some(used) = app_view
            .as_ref()
            .and_then(|a| a.used.as_ref())
            .and_then(Number::as_f64)
        {
            usage_balances.insert(handle.to_string(), used);
        }
    }
    // ST-1741: the numbers the app reported, for the cost rule (only the fields
    // that follow the app), and a trace of what that comparison did.
    let mut app_numbers = AppReportedNumbers::default();
    if let Some(a) = app_view.as_ref() {
        if follows(base.merge.fields.limit) {
            app_numbers.limit = a.limit.as_ref().and_then(Number::as_f64);
        }
        if follows(base.merge.fields.used) {
            app_numbers.used = a.used.as_ref().and_then(Number::as_f64);
        }
        if follows(base.merge.fields.remaining) {
            app_numbers.remaining = a.remaining.as_ref().and_then(Number::as_f64);
            app_numbers.remaining_derived =
                app_numbers.remaining.is_some() && remaining_was_derived(app);
        }
    }
    let cost_trace = Cell::new(CostTrace::default());
    let evaluated = known_playbook.and_then(|playbook| {
        let input = LocalEntitlementInput {
            handle,
            context_used: base.context_used,
            context_balance: base.context_balance,
            context_cost: base.context_cost.clone(),
            diagnostics,
            current_plan_handle: &base.current_plan_handle,
            segment_ids: base.segment_ids.clone(),
            usage_balances,
            user_usage: base.user_usage,
            addons: base.addons,
            billing_period: base.billing_period,
            trial_granted_entitlement_handles: base.trial_granted_entitlement_handles.clone(),
            effective_plan_handle: base.effective_plan_handle.clone(),
        };
        let extras = CostExtras {
            app_numbers: (!app_numbers.is_empty()).then_some(app_numbers),
            cost_trace: Some(&cost_trace),
        };
        derive_local_entitlement_reporting(&input, playbook, error, extras)
    });
    let merged = merge_entitlement_results(evaluated.as_ref(), app_view.as_ref(), &base.merge)
        .unwrap_or_else(|| {
            EntitlementCheckResult::with_reason("denied", false, "entitlement_not_in_playbook")
        });
    let mut result = apply_cost_to_merged(
        base,
        handle,
        known_playbook,
        app_view.as_ref(),
        app_numbers,
        evaluated.as_ref(),
        merged,
        cost_trace.get(),
    );
    // ST-1696: the cost diagnostic rides on the result for runtimes with their
    // own channel; the Playbook's own evaluation is where it was produced.
    if let Some(diagnostic) = evaluated.as_ref().and_then(|e| e.diagnostic.clone()) {
        result.diagnostic = Some(diagnostic);
    }
    EffectiveEntitlement {
        result,
        unknown_handle: false,
    }
}

/// ST-1741 (Kent's D-7): when the cost > 0 comparison used numbers the APP
/// reported (mirrored values, or a per-call balance / used), the comparison's
/// numbers describe the result, and a mirrored "allowed" no longer overrides an
/// over result. A mirrored denial always stays denied. A mirrored answer with no
/// numbers (and no per-call balance / used), and every cost that is not above 0,
/// leave the 0.16.0 result exactly as it was.
///
/// Source: effective-entitlement.ts (applyCostToMerged)
#[allow(clippy::too_many_arguments)]
fn apply_cost_to_merged(
    base: &EffectiveEntitlementBase,
    handle: &str,
    known_playbook: Option<&Value>,
    app: Option<&PartialEntitlement>,
    app_numbers: AppReportedNumbers,
    evaluated: Option<&EntitlementCheckResult>,
    merged: EntitlementCheckResult,
    trace: CostTrace,
) -> EntitlementCheckResult {
    let Some(app) = app else {
        return merged;
    };
    if !has_positive_cost(base.context_cost.as_ref()) {
        return merged;
    }
    let status_from_app = app.status.is_some()
        && base.merge.winner(base.merge.fields.status) == EntitlementSource::App;
    let with_numbers = |from: &EntitlementCheckResult| {
        let mut out = merged.clone();
        out.limit = from.limit.clone();
        out.used = from.used.clone();
        out.remaining = from.remaining.clone();
        out
    };
    let app_denies = app.allowed == Some(false) || app.status.as_deref() == Some("denied");

    // A rule was evaluated against numbers the app reported or the call passed.
    if trace.applied && trace.app_numbers {
        if let Some(evaluated) = evaluated {
            let numbered = with_numbers(evaluated);
            if !(trace.over && status_from_app && !app_denies) {
                return numbered;
            }
            // Over: the rule's enforcement decides, whatever the app mirrored
            // as allowed.
            let mut out = numbered;
            out.status = evaluated.status.clone();
            out.allowed = evaluated.allowed;
            out.reason = evaluated.reason.clone();
            if evaluated.rule_handle.is_some() {
                out.rule_handle = evaluated.rule_handle.clone();
            }
            if evaluated.contributing_rule_handles.is_some() {
                out.contributing_rule_handles = evaluated.contributing_rule_handles.clone();
            }
            return out;
        }
    }

    // No rule was compared (no plan identity, no matching rule): the app said
    // "allowed", so compare against what the app reported, with no enforcement
    // mode to read (status `limited`, not allowed, the plain reason).
    if !trace.applied && known_playbook.is_some() && status_from_app && !app_denies {
        let kind = known_playbook
            .and_then(|pb| pb.get("entitlements"))
            .and_then(Value::as_array)
            .and_then(|ents| {
                ents.iter()
                    .find(|e| e.get("unique_handle").and_then(Value::as_str) == Some(handle))
            })
            .and_then(|e| e.get("type"))
            .and_then(Value::as_str);
        let limit_number = app_numbers.limit.and_then(Number::from_f64);
        let type_fields = match kind {
            Some("credits") => {
                let mut tf = serde_json::json!({ "kind": "credits" });
                if let Some(n) = &limit_number {
                    tf["allowance"] = Value::Number(n.clone());
                }
                Some(tf)
            }
            Some("usage_limit") => {
                let mut tf = serde_json::json!({ "kind": "usage_limit" });
                if let Some(n) = &limit_number {
                    tf["limit_value"] = Value::Number(n.clone());
                }
                Some(tf)
            }
            _ => None,
        };
        if let Some(type_fields) = type_fields {
            let synthetic = Cell::new(CostTrace::default());
            let verdict = derive_result_with_allowance(
                &type_fields,
                base.context_used.or(app_numbers.used).unwrap_or(0.0),
                None,
                base.context_balance,
                CostInput {
                    cost: base.context_cost.as_ref(),
                    diagnose_handle: None,
                    used_given: base.context_used.is_some(),
                    app: Some(app_numbers),
                    trace: Some(&synthetic),
                },
            );
            let synthetic = synthetic.get();
            if synthetic.applied && synthetic.app_numbers {
                let numbered = with_numbers(&verdict);
                if !synthetic.over {
                    return numbered;
                }
                let mut out = numbered;
                out.status = verdict.status.clone();
                out.allowed = verdict.allowed;
                out.reason = verdict.reason.clone();
                return out;
            }
        }
    }
    merged
}

/// Effective entitlements for every handle the Playbook or the app knows —
/// the map a runtime publishes to the placement resolver so gates read the
/// same answer `check_entitlement` returns.
///
/// Source: effective-entitlement.ts (deriveEffectiveEntitlements)
#[must_use]
pub fn derive_effective_entitlements(
    base: &EffectiveEntitlementBase,
    app_by_handle: &BTreeMap<String, AppEntitlementInputs>,
) -> BTreeMap<String, EntitlementCheckResult> {
    let playbook_handles = base
        .playbook
        .and_then(|pb| pb.get("entitlements"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|e| e.get("unique_handle").and_then(Value::as_str));
    playbook_handles
        .chain(app_by_handle.keys().map(String::as_str))
        .map(|handle| {
            (
                handle.to_string(),
                // The all-handles map carries no diagnostics and reports none.
                derive_effective_entitlement_reporting(
                    handle,
                    base,
                    app_by_handle.get(handle),
                    &mut None,
                    false,
                )
                .result,
            )
        })
        .collect()
}
