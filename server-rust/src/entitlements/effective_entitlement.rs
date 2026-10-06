//! Effective entitlements — the ONE answer every SDK runtime uses (D-61,
//! Kent 2026-10-06).
//!
//! The shared evaluator ([`derive_local_entitlement_from_configured_rules`])
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

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Number, Value};

use super::entitlement_check::{
    derive_local_entitlement_from_configured_rules, LocalEntitlementInput,
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
/// Source: effective-entitlement.ts (deriveEffectiveEntitlement)
#[must_use]
pub fn derive_effective_entitlement(
    handle: &str,
    base: &EffectiveEntitlementBase,
    app: Option<&AppEntitlementInputs>,
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
    let mut usage_balances = base.usage_balances.clone();
    if base.merge.winner(base.merge.fields.used) == EntitlementSource::App {
        if let Some(used) = app_view
            .as_ref()
            .and_then(|a| a.used.as_ref())
            .and_then(Number::as_f64)
        {
            usage_balances.insert(handle.to_string(), used);
        }
    }
    let evaluated = known_playbook.and_then(|playbook| {
        let input = LocalEntitlementInput {
            handle,
            context_used: base.context_used,
            current_plan_handle: &base.current_plan_handle,
            segment_ids: base.segment_ids.clone(),
            usage_balances,
            user_usage: base.user_usage,
            trial_granted_entitlement_handles: base.trial_granted_entitlement_handles.clone(),
            effective_plan_handle: base.effective_plan_handle.clone(),
        };
        derive_local_entitlement_from_configured_rules(&input, playbook)
    });
    let result = merge_entitlement_results(evaluated.as_ref(), app_view.as_ref(), &base.merge)
        .unwrap_or_else(|| {
            EntitlementCheckResult::with_reason("denied", false, "entitlement_not_in_playbook")
        });
    EffectiveEntitlement {
        result,
        unknown_handle: false,
    }
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
                derive_effective_entitlement(handle, base, app_by_handle.get(handle)).result,
            )
        })
        .collect()
}
