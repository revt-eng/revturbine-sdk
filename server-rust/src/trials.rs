//! Trial-status derivation.
//!
//! Translates persisted trial schemas (`TrialInstance` + `FreeTrialRule` /
//! `ReverseTrialRule`) into the transient `UserTrialStatus` the SDK consumes.
//!
//! Every function is **pure and deterministic**: the caller supplies
//! `now_iso`, and nothing here reads the wall clock. That is what lets the
//! control plane and the SDK derive the same answer for the same instant —
//! and it is why this module, unlike the state layer, needs no injected clock.
//!
//! Source: revturbine-scaffold/src/trials/controllers/trial-status.ts

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js_num::js_math_round;

const MS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// At or past this universal progress percent, an active trial surfaces as
/// `running_out` — i.e. when a quarter or less remains.
///
/// Source: trial-status.ts RUNNING_OUT_PERCENT_THRESHOLD
const RUNNING_OUT_PERCENT_THRESHOLD: f64 = 75.0;

/// The transient runtime trial shape the SDK consumes.
///
/// Optional fields are **omitted** when absent rather than serialized as
/// null — the TS emits `undefined` for them, and the parity contract turns an
/// absent key and an explicit null into different output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserTrialStatus {
    /// Whether the trial is currently active (after lazy expiry).
    pub in_trial: bool,
    /// `free` | `reverse`.
    pub trial_type: String,
    /// `active` | `running_out` | `expired` | `converted` | `none`.
    pub state: String,
    /// `time` | `usage`.
    pub trial_limit_type: String,
    /// 0–100 universal progress, whichever dimension bounds the trial.
    pub progress_percent: f64,
    /// Plan the trial confers, when one applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_handle: Option<String>,
    /// Day index within a time-based trial.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day_number: Option<i64>,
    /// Whole days left in a time-based trial.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days_remaining: Option<i64>,
    /// Entitlement metered by a usage-based trial.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_entitlement_handle: Option<String>,
    /// Units consumed in a usage-based trial.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_consumed: Option<f64>,
    /// Units left in a usage-based trial.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_remaining: Option<f64>,
    /// The usage-based trial's limit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage_limit: Option<f64>,
}

/// Entitlement-grant inputs for an active reverse trial.
///
/// Source: trial-status.ts deriveReverseTrialGrants
#[derive(Debug, Clone, PartialEq)]
pub struct ReverseTrialGrants {
    /// Entitlement handles granted for the duration of the trial.
    pub trial_granted_entitlement_handles: Vec<String>,
    /// Plan the user effectively occupies while the trial runs.
    pub effective_plan_handle: Option<String>,
}

/// Parse an ISO instant to epoch-ms, mirroring JS `Date.parse`.
///
/// `None` stands in for JS `NaN`; the TS branches on `Number.isNaN`, so every
/// caller must decide explicitly what an unparseable date means rather than
/// silently treating it as the epoch.
fn date_parse_ms(value: Option<&Value>) -> Option<f64> {
    let s = value?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis() as f64)
}

/// Lazy expiry: an active trial whose bounds have been crossed reads as
/// `expired` even though nothing has rewritten the persisted row.
///
/// Source: trial-status.ts effectiveStatus
fn effective_status(persisted: &str, is_expired_by_bounds: bool) -> String {
    if persisted == "converted" || persisted == "cancelled" {
        return persisted.to_string();
    }
    if is_expired_by_bounds && persisted == "active" {
        return "expired".to_string();
    }
    persisted.to_string()
}

/// Persisted status → transient runtime state.
///
/// Note `cancelled` maps to `expired`: the runtime vocabulary has no
/// "cancelled", and the placement triggers care that the trial is over.
///
/// Source: trial-status.ts mapStateForRuntime
fn map_state_for_runtime(status: &str, progress_percent: f64) -> String {
    match status {
        "expired" | "cancelled" => "expired".to_string(),
        "converted" => "converted".to_string(),
        "not_started" => "none".to_string(),
        // active
        _ if progress_percent >= RUNNING_OUT_PERCENT_THRESHOLD => "running_out".to_string(),
        _ => "active".to_string(),
    }
}

struct TimeBased {
    is_expired_by_bounds: bool,
    day_number: i64,
    days_remaining: i64,
    progress_percent: f64,
}

/// Source: trial-status.ts deriveTimeBased
fn derive_time_based(started_at_ms: f64, expires_at_ms: f64, now_ms: f64) -> TimeBased {
    let total_ms = (expires_at_ms - started_at_ms).max(0.0);
    let elapsed_ms = (now_ms - started_at_ms).max(0.0);
    let remaining_ms = (expires_at_ms - now_ms).max(0.0);

    // `js_math_round`, not Rust's `f64::round` — ties must break toward +inf.
    let days_total = (js_math_round(total_ms / MS_PER_DAY) as i64).max(1);
    let day_number = days_total.min((elapsed_ms / MS_PER_DAY).floor() as i64);
    let days_remaining = ((remaining_ms / MS_PER_DAY).ceil() as i64).max(0);
    // `max(1.0, total)` guards a zero-length trial from dividing by zero.
    let progress_percent = ((elapsed_ms / total_ms.max(1.0)) * 100.0).clamp(0.0, 100.0);

    TimeBased {
        is_expired_by_bounds: now_ms >= expires_at_ms,
        day_number,
        days_remaining,
        progress_percent,
    }
}

struct UsageBased {
    is_expired_by_bounds: bool,
    usage_consumed: f64,
    usage_remaining: f64,
    usage_limit: f64,
    progress_percent: f64,
}

/// Source: trial-status.ts deriveUsageBased
fn derive_usage_based(consumed: f64, limit: f64) -> UsageBased {
    let safe_limit = limit.max(1.0);
    let safe_consumed = consumed.max(0.0);
    UsageBased {
        is_expired_by_bounds: safe_consumed >= safe_limit,
        usage_consumed: safe_consumed,
        usage_remaining: (safe_limit - safe_consumed).max(0.0),
        usage_limit: safe_limit,
        progress_percent: ((safe_consumed / safe_limit) * 100.0).clamp(0.0, 100.0),
    }
}

fn str_field<'a>(obj: &'a Value, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str)
}

/// A finite number field. Booleans are rejected — `Value::as_f64` already
/// declines them, mirroring TS `typeof === 'number'`.
fn num_field(obj: &Value, key: &str) -> Option<f64> {
    obj.get(key)
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite())
}

/// Derive the runtime status from a persisted instance, its matching rule, and
/// the current instant.
///
/// `None` when the trial has not started, its persisted status is
/// `not_started`, the instant precedes the start, a time-based trial has no
/// parseable `expires_at`, or a usage-based trial is missing its bounds. In
/// every one of those cases the trial cannot be *described*, and inventing a
/// status would let a malformed row grant entitlements.
///
/// Source: trial-status.ts deriveLocalTrialStatusFromInstance
#[must_use]
pub fn derive_local_trial_status_from_instance(
    instance: &Value,
    rule: Option<&Value>,
    now_iso: &str,
    base_plan_handle: Option<&str>,
    usage_balances: Option<&Value>,
) -> Option<UserTrialStatus> {
    let started_at_ms = date_parse_ms(instance.get("started_at"))?;
    let now_ms = date_parse_ms(Some(&Value::String(now_iso.to_string())))?;

    let status = str_field(instance, "status").unwrap_or("");
    if status == "not_started" || now_ms < started_at_ms {
        return None;
    }

    let limit_type = str_field(instance, "trial_limit_type").unwrap_or("time");

    // Both branches below assign these; deferred init rather than a dead
    // placeholder, so the compiler proves every path sets them.
    let progress_percent;
    let is_expired_by_bounds;
    let mut day_number = None;
    let mut days_remaining = None;
    let mut usage_consumed = None;
    let mut usage_remaining = None;
    let mut usage_limit = None;
    let mut usage_entitlement_handle = None;

    if limit_type == "usage" {
        // The instance snapshot wins; the rule is the fallback.
        let handle = str_field(instance, "usage_entitlement_handle")
            .or_else(|| rule.and_then(|r| str_field(r, "usage_entitlement_handle")))?;
        let limit = num_field(instance, "usage_limit_value")
            .or_else(|| rule.and_then(|r| num_field(r, "usage_limit_value")))?;
        if limit < 1.0 {
            // Missing or nonsensical bounds — malformed, not "unlimited".
            return None;
        }
        let consumed = usage_balances
            .and_then(|b| b.get(handle))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);

        let u = derive_usage_based(consumed, limit);
        progress_percent = u.progress_percent;
        is_expired_by_bounds = u.is_expired_by_bounds;
        usage_consumed = Some(u.usage_consumed);
        usage_remaining = Some(u.usage_remaining);
        usage_limit = Some(u.usage_limit);
        usage_entitlement_handle = Some(handle.to_string());
    } else {
        // 'time' mode (the default) requires an expires_at bound.
        let expires_at_ms = date_parse_ms(instance.get("expires_at"))?;
        let t = derive_time_based(started_at_ms, expires_at_ms, now_ms);
        progress_percent = t.progress_percent;
        is_expired_by_bounds = t.is_expired_by_bounds;
        day_number = Some(t.day_number);
        days_remaining = Some(t.days_remaining);
    }

    let resolved_status = effective_status(status, is_expired_by_bounds);
    let state = map_state_for_runtime(&resolved_status, progress_percent);

    let rule_type = str_field(instance, "rule_type").unwrap_or("");
    let plan_handle = if rule_type == "reverse_trial" {
        base_plan_handle.map(str::to_string)
    } else if rule_type == "free_trial" {
        rule.and_then(|r| str_field(r, "plan_id"))
            .map(str::to_string)
    } else {
        None
    };

    Some(UserTrialStatus {
        in_trial: resolved_status == "active",
        trial_type: if rule_type == "reverse_trial" {
            "reverse".to_string()
        } else {
            "free".to_string()
        },
        state,
        trial_limit_type: limit_type.to_string(),
        progress_percent,
        plan_handle,
        day_number,
        days_remaining,
        usage_entitlement_handle,
        usage_consumed,
        usage_remaining,
        usage_limit,
    })
}

/// Latest-started instance whose *derived* status is `active` or `converted`.
///
/// Expired and cancelled rows are skipped. Note this applies lazy expiry
/// before deciding, so a row still persisted as `active` but past its bounds
/// is correctly excluded.
///
/// Source: trial-status.ts findActiveTrialInstance
#[must_use]
pub fn find_active_trial_instance<'a>(
    instances: &'a [Value],
    now_iso: &str,
    usage_balances: Option<&Value>,
) -> Option<&'a Value> {
    let now_ms = date_parse_ms(Some(&Value::String(now_iso.to_string())))?;

    let mut best: Option<&Value> = None;
    let mut best_started_at = f64::NEG_INFINITY;

    for inst in instances {
        let Some(started_at_ms) = date_parse_ms(inst.get("started_at")) else {
            continue;
        };
        if now_ms < started_at_ms {
            continue;
        }

        let mut is_expired_by_bounds = false;
        if str_field(inst, "trial_limit_type").unwrap_or("time") == "usage" {
            if let (Some(balances), Some(handle), Some(limit)) = (
                usage_balances,
                str_field(inst, "usage_entitlement_handle"),
                num_field(inst, "usage_limit_value"),
            ) {
                let consumed = balances.get(handle).and_then(Value::as_f64).unwrap_or(0.0);
                is_expired_by_bounds = consumed >= limit;
            }
        } else if let Some(expires_at_ms) = date_parse_ms(inst.get("expires_at")) {
            is_expired_by_bounds = now_ms >= expires_at_ms;
        }

        let resolved = effective_status(
            str_field(inst, "status").unwrap_or(""),
            is_expired_by_bounds,
        );
        if resolved != "active" && resolved != "converted" {
            continue;
        }
        if started_at_ms > best_started_at {
            best = Some(inst);
            best_started_at = started_at_ms;
        }
    }
    best
}

/// Latest-started row that is `active` / `expired` / `converted`.
///
/// Unlike [`find_active_trial_instance`] this **keeps** expired and converted
/// rows, so `trial_ended` / `trial_converted` placements can still fire.
/// `not_started`, `cancelled`, and future-dated rows are dropped.
///
/// Source: trial-status.ts findLatestStartedTrialInstance
#[must_use]
pub fn find_latest_started_trial_instance<'a>(
    instances: &'a [Value],
    now_iso: &str,
) -> Option<&'a Value> {
    let now_ms = date_parse_ms(Some(&Value::String(now_iso.to_string())))?;

    let mut best: Option<&Value> = None;
    let mut best_started_at = f64::NEG_INFINITY;

    for inst in instances {
        let status = str_field(inst, "status").unwrap_or("");
        if status != "active" && status != "expired" && status != "converted" {
            continue;
        }
        let Some(started_at_ms) = date_parse_ms(inst.get("started_at")) else {
            continue;
        };
        if now_ms < started_at_ms {
            continue;
        }
        if started_at_ms > best_started_at {
            best = Some(inst);
            best_started_at = started_at_ms;
        }
    }
    best
}

/// Entitlement grants for an active reverse trial.
///
/// `None` unless the instance is a reverse trial referencing *this* rule and
/// the rule grants at least one entitlement.
///
/// Source: trial-status.ts deriveReverseTrialGrants
#[must_use]
pub fn derive_reverse_trial_grants(instance: &Value, rule: &Value) -> Option<ReverseTrialGrants> {
    if str_field(instance, "rule_type") != Some("reverse_trial") {
        return None;
    }
    if instance.get("rule_id") != rule.get("id") {
        return None;
    }
    let handles: Vec<String> = rule
        .get("entitlements_during_trial")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if handles.is_empty() {
        return None;
    }
    Some(ReverseTrialGrants {
        trial_granted_entitlement_handles: handles,
        effective_plan_handle: str_field(rule, "premium_plan_id").map(str::to_string),
    })
}

/// The outcome of [`evaluate_trial_status`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TrialEvaluation {
    /// The derived runtime status, when a trial applies.
    pub trial: Option<UserTrialStatus>,
    /// Reverse-trial grants, when the applicable trial is a reverse trial.
    pub reverse_grants: Option<ReverseTrialGrants>,
}

fn find_rule_by_id<'a>(rules: Option<&'a [Value]>, rule_id: Option<&Value>) -> Option<&'a Value> {
    rules?.iter().find(|r| r.get("id") == rule_id)
}

/// Evaluate a Playbook's trial rules against a customer's instances.
///
/// The config-driven counterpart of
/// [`derive_local_trial_status_from_instance`]: it resolves the matching rule
/// *from the config arrays* by `rule_id` + `rule_type`, rather than asking the
/// caller to supply it.
///
/// Source: trial-status.ts evaluateTrialStatus
#[must_use]
pub fn evaluate_trial_status(
    instances: &[Value],
    now_iso: &str,
    free_trial_rules: Option<&[Value]>,
    reverse_trial_rules: Option<&[Value]>,
    usage_balances: Option<&Value>,
    base_plan_handle: Option<&str>,
) -> TrialEvaluation {
    let Some(instance) = find_latest_started_trial_instance(instances, now_iso) else {
        return TrialEvaluation::default();
    };

    let is_reverse = str_field(instance, "rule_type") == Some("reverse_trial");
    let rules = if is_reverse {
        reverse_trial_rules
    } else {
        free_trial_rules
    };
    let rule = find_rule_by_id(rules, instance.get("rule_id"));

    let trial = derive_local_trial_status_from_instance(
        instance,
        rule,
        now_iso,
        base_plan_handle,
        usage_balances,
    );
    let reverse_grants = if is_reverse {
        rule.and_then(|r| derive_reverse_trial_grants(instance, r))
    } else {
        None
    };

    TrialEvaluation {
        trial,
        reverse_grants,
    }
}
