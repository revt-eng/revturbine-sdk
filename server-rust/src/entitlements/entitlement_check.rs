//! Entitlement check lifecycle.
//!
//! [`derive_local_entitlement_from_configured_rules`] is the Playbook-rule
//! fallback wired into `LocalRuntime`'s entitlement derivation. It does its
//! **own** inline rule filtering and reuses the §2.6.5 most-permissive
//! selector from [`super::rules`] — distinct from the provider-snapshot path,
//! but sharing the scorer so §2.6.5 is never implemented twice.
//!
//! Config values stay loosely typed (`serde_json::Value`), matching the Python
//! port's convention; the parity suite is the drift backstop.
//!
//! Source: revturbine-scaffold/src/entitlements/controllers/entitlement-check.ts

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};

use serde_json::{Map, Value};

use super::purchased_allowance::{
    aggregate_purchased_allowance, allowance_field, validate_purchased_addons, AllowanceRule,
    PurchasedContribution,
};
use super::rules::{pick_most_permissive, rule_permissiveness};
use super::segment_matching::matches_rule_segments;
use super::unlimited::resolve_limit_value;
use crate::decisions::{int_if_integral, EntitlementCheckResult, EntitlementDiagnostic};
use crate::segments::segment_dimension_keys;

/// Mirror JS `Number(v)` for the value shapes `type_fields` carry.
///
/// An absent field arrives as `None`, standing in for TS `undefined` →
/// `Number(undefined)` is `NaN`, which keeps the "missing limit ⇒ not finite ⇒
/// unlimited" branch parity-correct. `""` → `0`; unparseable → `NaN`.
///
/// Source: the `Number(...)` coercions in entitlement-check.ts:178-191
fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None | Some(Value::Null) => f64::NAN,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// Apply a rule's `enforcement` mode when a usage / credit limit is reached
/// (plan 34 REQ-3). Under the limit is always allowed.
///
/// Source: entitlement-check.ts:50-68 (applyUsageEnforcement)
fn apply_usage_enforcement(
    over: bool,
    enforcement: Option<&Value>,
    base_reason: &str,
) -> EntitlementCheckResult {
    if !over {
        return EntitlementCheckResult::new("allowed", true);
    }
    match enforcement.and_then(Value::as_str) {
        Some("hard_block") => EntitlementCheckResult::with_reason("denied", false, base_reason),
        // `soft_block` is the pre-v15 spelling of `block_with_upsell` (plan 194
        // TASK-8). Accepting it keeps a v13/v14 payload denying rather than
        // falling to the unset-enforcement default below; both spellings report
        // the new reason.
        Some("block_with_upsell") | Some("soft_block") => EntitlementCheckResult::with_reason(
            "denied",
            false,
            &format!("{base_reason}_block_with_upsell"),
        ),
        Some("degrade") => {
            EntitlementCheckResult::with_reason("limited", true, &format!("{base_reason}_degraded"))
        }
        Some("allow_overage") => {
            EntitlementCheckResult::with_reason("allowed", true, &format!("{base_reason}_overage"))
        }
        // Unset / unknown: limited AND denied. Note this differs from
        // `degrade`, which is limited but ALLOWED.
        _ => EntitlementCheckResult::with_reason("limited", false, base_reason),
    }
}

/// Enrich a limit-bearing outcome so the result carries the numbers (plan 133).
///
/// Source: entitlement-check.ts (withLimitFields)
fn with_limit_fields(
    mut base: EntitlementCheckResult,
    limit: f64,
    used: f64,
) -> EntitlementCheckResult {
    base.limit = int_if_integral(limit);
    base.used = int_if_integral(used);
    base.remaining = int_if_integral((limit - used).max(0.0));
    base
}

/// Rule kinds [`derive_result_from_rule_type_fields`] gives dedicated
/// semantics. A matched rule of a recognised but unshaped kind (see
/// [`is_provider_deferred_kind`]) proves the plan assignment exists and falls
/// through to provider entry/usage logic. Every other kind is decided by
/// [`unrecognised_kind_result`] (BL-0514).
///
/// Source: entitlement-check.ts (isRuleShapedKind)
#[must_use]
pub fn is_rule_shaped_kind(kind: &str) -> bool {
    matches!(
        kind,
        "feature" | "usage_limit" | "limit" | "credits" | "capability_tier" | "seat"
    )
}

/// Recognised kinds the shaper does not model and that stay decided exactly
/// as before BL-0514: the IR spellings of the seat kind (`seats`) and of the
/// tier kind (`tiered`). The schema spellings `seat` and `capability_tier` are
/// shaped. The Playbook path allows; the provider-snapshot path falls through
/// to the provider entry/usage logic.
///
/// Source: entitlement-check.ts (isProviderDeferredKind)
#[must_use]
pub fn is_provider_deferred_kind(kind: &str) -> bool {
    matches!(kind, "seats" | "tiered")
}

static WARNED_RATE_LIMIT: AtomicBool = AtomicBool::new(false);
static WARNED_PRICE_PER_UNIT: AtomicBool = AtomicBool::new(false);

/// Warn once per process per kind that an access check reached a non-access
/// entitlement, on stderr like the runtime's other once-per-process
/// diagnostics.
///
/// Source: entitlement-check.ts (warnNonAccessKind)
fn warn_non_access_kind(kind: &str, warned: &AtomicBool) {
    if warned.swap(true, Ordering::Relaxed) {
        return;
    }
    eprintln!(
        "[revturbine] can() / check_entitlement() reached a {kind} entitlement, which is not an access entitlement; denying (not_access_entitlement_kind). Use the rate-limit / metering module for it instead."
    );
}

/// The fail-closed outcome for a matched rule whose kind is neither shaped
/// nor provider-deferred, or `None` when it is one of those (BL-0514).
///
/// - `rate_limit` / `price_per_unit` → denied, `not_access_entitlement_kind`,
///   plus a once-per-process warning.
/// - anything else, including an absent or non-string kind → denied,
///   `unknown_entitlement_kind`.
///
/// Source: entitlement-check.ts (unrecognisedKindResult)
#[must_use]
pub fn unrecognised_kind_result(kind: Option<&str>) -> Option<EntitlementCheckResult> {
    match kind {
        Some(k) if is_rule_shaped_kind(k) || is_provider_deferred_kind(k) => None,
        Some("rate_limit") => {
            warn_non_access_kind("rate_limit", &WARNED_RATE_LIMIT);
            Some(EntitlementCheckResult::with_reason(
                "denied",
                false,
                "not_access_entitlement_kind",
            ))
        }
        Some("price_per_unit") => {
            warn_non_access_kind("price_per_unit", &WARNED_PRICE_PER_UNIT);
            Some(EntitlementCheckResult::with_reason(
                "denied",
                false,
                "not_access_entitlement_kind",
            ))
        }
        _ => Some(EntitlementCheckResult::with_reason(
            "denied",
            false,
            "unknown_entitlement_kind",
        )),
    }
}

/// Shape a result from a matched rule's `type_fields` (plan 133).
///
/// Single-sourced for BOTH evaluators — the Playbook path below and the
/// provider-snapshot path — so a matched rule yields identical results on
/// every surface. Limit-bearing outcomes carry `limit` / `used` / `remaining`.
///
/// Source: entitlement-check.ts (deriveResultFromRuleTypeFields)
#[must_use]
pub fn derive_result_from_rule_type_fields(
    type_fields: &Value,
    used: f64,
) -> EntitlementCheckResult {
    derive_result_with_allowance(type_fields, used, None, None, CostInput::default())
}

// ── Per-call cost (ST-1696, Kent's final rule 2026-11-11) ───────────────────

const COST_TOLERANCE_SCALE_CAP: f64 = (1u64 << 48) as f64;

/// The `cost` a limit-enforcing check was called with, and whether to report on
/// it. `diagnose_handle` is set only by single-handle checks; without it the
/// cost RULE still applies but no diagnostic is produced.
///
/// Source: entitlement-check.ts (CostInput)
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct CostInput<'a> {
    /// The raw `cost` from the caller's context; `None` and JSON `null` are
    /// "missing".
    pub(crate) cost: Option<&'a Value>,
    /// The handle to name in the diagnostic, on single-handle checks only.
    pub(crate) diagnose_handle: Option<&'a str>,
}

/// The ONE comparison the cost > 0 rule uses (usage_limit, credits used-based).
/// Copied from scaffold, not re-derived; IEEE-754 doubles, left to right:
///
/// ```text
/// scale = min(max(1, |used|, |cost|, |limit|), 2**48)
/// over  = ((used + cost) - limit) > 8 * EPSILON * scale
/// ```
///
/// `EPSILON` is `f64::EPSILON` (2**-52). The missing-cost path
/// (`used >= limit`) never uses this.
///
/// Source: entitlement-check.ts (costExceedsLimit)
#[must_use]
pub(crate) fn cost_exceeds_limit(used: f64, cost: f64, limit: f64) -> bool {
    let scale = 1.0_f64
        .max(used.abs())
        .max(cost.abs())
        .max(limit.abs())
        .min(COST_TOLERANCE_SCALE_CAP);
    ((used + cost) - limit) > 8.0 * f64::EPSILON * scale
}

/// Balance form of [`cost_exceeds_limit`] (credits evaluated from a
/// `balance`): `scale = min(max(1, |cost|, |balance|), 2**48)`, over iff
/// `(cost - balance) > 8 * EPSILON * scale`.
///
/// Source: entitlement-check.ts (costExceedsBalance)
#[must_use]
pub(crate) fn cost_exceeds_balance(cost: f64, balance: f64) -> bool {
    let scale = 1.0_f64
        .max(cost.abs())
        .max(balance.abs())
        .min(COST_TOLERANCE_SCALE_CAP);
    (cost - balance) > 8.0 * f64::EPSILON * scale
}

enum CostClass {
    Positive(f64),
    Zero,
    Missing,
    Invalid(&'static str),
}

fn classify_cost(cost: Option<&Value>) -> CostClass {
    match cost {
        None | Some(Value::Null) => CostClass::Missing,
        Some(Value::Number(n)) => {
            let v = n.as_f64().unwrap_or(f64::NAN);
            if v.is_nan() {
                CostClass::Invalid("nan")
            } else if v.is_infinite() {
                CostClass::Invalid("infinite")
            } else if v < 0.0 {
                CostClass::Invalid("negative")
            } else if v == 0.0 {
                CostClass::Zero
            } else {
                CostClass::Positive(v)
            }
        }
        Some(_) => CostClass::Invalid("non_number"),
    }
}

fn diagnostic(
    input: CostInput,
    level: &str,
    code: &str,
    received: Option<&str>,
) -> Option<EntitlementDiagnostic> {
    input.diagnose_handle.map(|handle| EntitlementDiagnostic {
        level: level.to_string(),
        code: code.to_string(),
        handle: handle.to_string(),
        received: received.map(str::to_string),
    })
}

/// Is a limit-enforcing call over its limit, and what should the developer be
/// told? Truth table (finite limit only; callers skip this for unlimited):
///
/// - cost > 0   : over = `over_with_cost(cost)`, no diagnostic
/// - cost == 0  : never over (free), `entitlement_cost_zero` warning
/// - missing    : over = `legacy_over` (today's check), `entitlement_cost_missing` error
/// - invalid    : over = `legacy_over`, `entitlement_cost_invalid` error naming the kind
///
/// Source: entitlement-check.ts (costVerdict / evaluateCostLimit)
pub(crate) fn cost_verdict(
    input: CostInput,
    legacy_over: bool,
    over_with_cost: impl Fn(f64) -> bool,
) -> (bool, Option<EntitlementDiagnostic>) {
    match classify_cost(input.cost) {
        CostClass::Positive(c) => (over_with_cost(c), None),
        CostClass::Zero => (
            false,
            diagnostic(input, "warning", "entitlement_cost_zero", None),
        ),
        CostClass::Missing => (
            legacy_over,
            diagnostic(input, "error", "entitlement_cost_missing", None),
        ),
        CostClass::Invalid(kind) => (
            legacy_over,
            diagnostic(input, "error", "entitlement_cost_invalid", Some(kind)),
        ),
    }
}

/// Attach a diagnostic to a result; a no-op without one.
pub(crate) fn with_diagnostic(
    mut result: EntitlementCheckResult,
    diagnostic: Option<EntitlementDiagnostic>,
) -> EntitlementCheckResult {
    if diagnostic.is_some() {
        result.diagnostic = diagnostic;
    }
    result
}

static REPORTED_DIAGNOSTICS: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();

/// Default Rust routing for a result's developer diagnostic: once per handle +
/// code per process, on stderr like the runtime's other once-per-process
/// diagnostics ([`warn_non_access_kind`]). Never panics; never changes the
/// result.
///
/// Source: entitlement-check.ts (reportEntitlementDiagnostic)
pub fn report_entitlement_diagnostic(result: &EntitlementCheckResult) {
    let Some(d) = &result.diagnostic else {
        return;
    };
    let first = REPORTED_DIAGNOSTICS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert((d.code.clone(), d.handle.clone()));
    if !first {
        return;
    }
    let handle = &d.handle;
    match d.code.as_str() {
        "entitlement_cost_zero" => eprintln!(
            "[revturbine] can() / check_entitlement(\"{handle}\") was called with cost 0: the action is treated as free and always allowed, even past the limit. Pass a positive cost if it should count against the limit."
        ),
        "entitlement_cost_invalid" => {
            let kind = match d.received.as_deref() {
                Some("negative") => "a negative number",
                Some("nan") => "NaN",
                Some("infinite") => "a non-finite number",
                _ => "a non-number value",
            };
            eprintln!(
                "[revturbine] ERROR can() / check_entitlement(\"{handle}\") was called with an invalid cost ({kind}); falling back to the cost-less check (allowed while usage < limit). Pass cost as a finite number >= 0 (0 for free)."
            );
        }
        _ => eprintln!(
            "[revturbine] ERROR can() / check_entitlement(\"{handle}\") was called without a cost on a usage-limited entitlement; falling back to the cost-less check (allowed while usage < limit). Pass a cost (0 for free)."
        ),
    }
}

/// Shape a result without interpreting computed totals as sentinel literals.
///
/// `balance` is the caller's `{ balance }` (ST-1696 REQ-9): for a credits rule
/// it is the REMAINING balance and wins over `used`. A non-finite balance is
/// ignored by the caller before it gets here. `cost` is the per-call cost
/// (ST-1696): see [`cost_verdict`].
pub(crate) fn derive_result_with_allowance(
    type_fields: &Value,
    used: f64,
    allowance_override: Option<f64>,
    balance: Option<f64>,
    cost: CostInput,
) -> EntitlementCheckResult {
    let kind = type_fields.get("kind").and_then(Value::as_str);

    match kind {
        Some("feature") => {
            // Anything other than an explicit `false` is enabled — an absent
            // flag defaults ON, matching `!== false` in the TS.
            let enabled = type_fields.get("enabled") != Some(&Value::Bool(false));
            if enabled {
                EntitlementCheckResult::new("allowed", true)
            } else {
                EntitlementCheckResult::with_reason("denied", false, "feature_not_enabled_for_plan")
            }
        }

        // `usage_limit` is the bundle-canonical kind; `limit` is the accepted
        // config-authoring shorthand — treated identically.
        Some("usage_limit" | "limit") => {
            let resolved =
                allowance_override.or_else(|| resolve_limit_value(type_fields.get("limit_value")));
            match resolved {
                Some(l) if l.is_finite() && l >= 0.0 => {
                    let (over, diagnostic) =
                        cost_verdict(cost, used >= l, |c| cost_exceeds_limit(used, c, l));
                    with_diagnostic(
                        with_limit_fields(
                            apply_usage_enforcement(
                                over,
                                type_fields.get("enforcement"),
                                "usage_limit_reached",
                            ),
                            l,
                            used,
                        ),
                        diagnostic,
                    )
                }
                // Unlimited (+inf) or unusable → allowed, no limit fields.
                _ => EntitlementCheckResult::new("allowed", true),
            }
        }

        Some("credits") => {
            // An *explicit* allowance (incl. null/'unlimited'/999999 → +inf)
            // wins; only a *truly absent* allowance falls through to
            // initial_grant. Presence, not resolution, picks the source.
            let allowance = if allowance_override.is_some() {
                allowance_override
            } else if type_fields.get("allowance_value").is_some() {
                resolve_limit_value(type_fields.get("allowance_value"))
            } else if type_fields.get("allowance").is_some() {
                resolve_limit_value(type_fields.get("allowance"))
            } else {
                None
            };
            let initial_grant = js_number(type_fields.get("initial_grant"));

            let cr_limit = match allowance {
                Some(a) if a >= 0.0 => Some(a),
                _ if initial_grant.is_finite() && initial_grant >= 0.0 => Some(initial_grant),
                _ => None,
            };

            // ST-1696 REQ-9: a caller-supplied `{ balance }` is the REMAINING
            // balance and wins over `used` and stored usage for this call.
            // Exhausted at `balance <= 0`; `used` is allowance minus balance.
            // Cost rule: with a finite balance the balance IS the limit,
            // whether or not the rule has a finite allowance (then only
            // `remaining` is reported, no `limit` / `used`).
            if let Some(b) = balance.filter(|b| b.is_finite()) {
                let (over, diagnostic) =
                    cost_verdict(cost, b <= 0.0, |c| cost_exceeds_balance(c, b));
                let mut result = with_diagnostic(
                    apply_usage_enforcement(
                        over,
                        type_fields.get("enforcement"),
                        "credit_balance_exhausted",
                    ),
                    diagnostic,
                );
                if let Some(l) = cr_limit.filter(|l| l.is_finite()) {
                    result.limit = int_if_integral(l);
                    result.used = int_if_integral((l - b).max(0.0));
                }
                result.remaining = int_if_integral(b.max(0.0));
                return result;
            }

            match cr_limit {
                Some(l) if l.is_finite() => {
                    let (over, diagnostic) =
                        cost_verdict(cost, used >= l, |c| cost_exceeds_limit(used, c, l));
                    with_diagnostic(
                        with_limit_fields(
                            apply_usage_enforcement(
                                over,
                                type_fields.get("enforcement"),
                                "credit_balance_exhausted",
                            ),
                            l,
                            used,
                        ),
                        diagnostic,
                    )
                }
                _ => EntitlementCheckResult::new("allowed", true),
            }
        }

        Some("seat") => {
            match allowance_override
                .or_else(|| resolve_limit_value(type_fields.get("included_count")))
            {
                Some(limit) if limit.is_finite() && limit >= 0.0 => {
                    with_limit_fields(EntitlementCheckResult::new("allowed", true), limit, used)
                }
                _ => EntitlementCheckResult::new("allowed", true),
            }
        }
        Some("capability_tier") => {
            let mut result = EntitlementCheckResult::new("allowed", true);
            if let Some(tier) = type_fields.get("tier_name").and_then(Value::as_str) {
                if !tier.is_empty() {
                    result.current_tier = Some(tier.to_string());
                }
            }
            result
        }

        // BL-0514: only the recognised-but-unshaped kinds (seats, the
        // `tiered` IR spelling) keep the plain allow. A non-access or unknown
        // kind denies.
        _ => unrecognised_kind_result(kind)
            .unwrap_or_else(|| EntitlementCheckResult::new("allowed", true)),
    }
}

/// Inputs to [`derive_local_entitlement_from_configured_rules`].
#[derive(Debug, Clone, Default)]
pub struct LocalEntitlementInput<'a> {
    /// The entitlement handle being checked.
    pub handle: &'a str,
    /// Explicit usage override. `Some(n)` wins over every other source —
    /// including `0`, which is why this is an `Option` and not a sentinel.
    pub context_used: Option<f64>,
    /// The caller's `{ balance }` — for a credits rule the remaining balance,
    /// which wins over `used` (ST-1696). Non-finite values are ignored.
    pub context_balance: Option<f64>,
    /// The caller's per-call `cost` (ST-1696), raw: `None` and JSON `null` are
    /// "missing". Applies to `usage_limit` / `limit` and `credits` rules only.
    pub context_cost: Option<Value>,
    /// Attach the developer `diagnostic` to the result. Set by the
    /// single-handle check paths; left `false` when every entitlement is
    /// evaluated at once, so a bulk evaluation never reports a missing cost for
    /// calls nobody made. The cost RULE applies either way.
    pub diagnostics: bool,
    /// The user's plan handle. Matched case-insensitively.
    pub current_plan_handle: &'a str,
    /// Segments the user belongs to, pre-resolved by the caller.
    pub segment_ids: HashSet<String>,
    /// Per-entitlement consumption. A finite balance — including `0` — wins
    /// over `user_usage`.
    pub usage_balances: HashMap<String, f64>,
    /// Per-entitlement `{amount}` records.
    pub user_usage: Option<&'a Value>,
    /// Entitlement handles the user holds through an active reverse trial
    /// (plan 43 TASK-2 — `ReverseTrialRule.entitlements_during_trial[]`). A
    /// requested handle in this set is matched against the GRANTED plan's
    /// rules (see [`effective_plan_handle`](Self::effective_plan_handle)).
    /// `None` or empty keeps the pre-trial behaviour. Build it with
    /// [`super::reverse_trial_grants`].
    pub trial_granted_entitlement_handles: Option<HashSet<String>>,
    /// The GRANTED (higher-tier) plan a trial-granted handle is matched
    /// against, so that plan's limits apply. Unset (or empty) with a
    /// trial-granted handle short-circuits to `granted_by_reverse_trial`.
    pub effective_plan_handle: Option<String>,
    /// Explicit purchased holdings, validated without quantity inference.
    pub addons: Option<&'a Value>,
    /// The base plan cadence for billing-period grants.
    pub billing_period: Option<&'a str>,
}

/// Derive an entitlement result locally from Playbook rules.
///
/// Returns `None` when no config is available; an explicit result otherwise —
/// including `no_matching_entitlement_rule` ⇒ denied, **failing closed**.
/// Invalid purchased holdings or incompatible additive grants deny with
/// `invalid_purchased_allowance`; use
/// [`try_derive_local_entitlement_from_configured_rules`] for the error message.
///
/// Source: entitlement-check.ts:77-211
#[must_use]
pub fn derive_local_entitlement_from_configured_rules(
    input: &LocalEntitlementInput,
    playbook: &Value,
) -> Option<EntitlementCheckResult> {
    derive_local_entitlement_reporting(input, playbook, &mut None)
}

/// [`derive_local_entitlement_from_configured_rules`], but an invalid
/// purchased holding or an incompatible additive grant is returned as the
/// error TS throws (BUG-554), instead of a fail-closed denial.
///
/// # Errors
///
/// The purchased-holding validation or allowance-compatibility message.
///
/// Source: entitlement-check.ts:77-211
pub fn try_derive_local_entitlement_from_configured_rules(
    input: &LocalEntitlementInput,
    playbook: &Value,
) -> Result<Option<EntitlementCheckResult>, String> {
    let mut error = None;
    let result = derive_local_entitlement_reporting(input, playbook, &mut error);
    error.map_or(Ok(result), Err)
}

/// Shared evaluator body: a rejection denies and records its message in `error`.
pub(crate) fn derive_local_entitlement_reporting(
    input: &LocalEntitlementInput,
    playbook: &Value,
    error: &mut Option<String>,
) -> Option<EntitlementCheckResult> {
    let mut invalid = |message: String| {
        *error = Some(message);
        Some(EntitlementCheckResult::with_reason(
            "denied",
            false,
            "invalid_purchased_allowance",
        ))
    };
    let declared = match validate_purchased_addons(input.addons) {
        Ok(declared) => declared,
        Err(message) => return invalid(message),
    };
    let empty: Vec<Value> = Vec::new();
    let addon_variations = playbook
        .get("addon_variations")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let holdings: Vec<_> = declared
        .into_iter()
        .filter(|h| {
            h["quantity"].as_f64().unwrap_or(0.0) > 0.0
                && playbook
                    .get("addons")
                    .and_then(Value::as_array)
                    .is_some_and(|addons| {
                        addons
                            .iter()
                            .any(|a| a.get("unique_handle") == h.get("addon_handle"))
                    })
                && (h.get("addon_variation_handle").is_none()
                    || addon_variations.iter().any(|v| {
                        v.get("handle") == h.get("addon_variation_handle")
                            && v.get("addon_handle") == h.get("addon_handle")
                    }))
        })
        .collect();
    let entitlements = playbook
        .get("entitlements")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    // Plan 120 TASK-4 / plan 191 REQ-1: the config carries only the handle, so
    // entitlements resolve by handle alone. The `id` fallback this port used to
    // carry was a pre-plan-120 mirror that TS dropped; because the ids in the
    // corpus (`ent_core_credits`) differ from the handles the rules reference
    // (`core_credits`), it made every rule miss and every check deny.
    let entitlement = entitlements
        .iter()
        .find(|item| item.get("unique_handle").and_then(Value::as_str) == Some(input.handle));

    let entitlement_id = entitlement
        .and_then(|e| e.get("unique_handle"))
        .and_then(Value::as_str)
        .unwrap_or(input.handle)
        .to_string();

    // Reverse-trial grant resolution (plan 43 TASK-2 + gap-1 follow-up). A
    // handle in `trial_granted_entitlement_handles` is held mid-trial: with an
    // `effective_plan_handle` the GRANTED plan's rules apply (so its limits
    // enforce); without one the v1 backstop grants outright. Mirrors
    // entitlement-check.ts.
    let unique_handle = entitlement
        .and_then(|e| e.get("unique_handle"))
        .and_then(Value::as_str);
    let handle_is_trial_granted = input
        .trial_granted_entitlement_handles
        .as_ref()
        .is_some_and(|granted| {
            !granted.is_empty()
                && (granted.contains(input.handle)
                    || granted.contains(&entitlement_id)
                    || unique_handle.is_some_and(|u| granted.contains(u)))
        });
    let effective_plan_handle = input
        .effective_plan_handle
        .as_deref()
        .filter(|p| !p.is_empty());
    if handle_is_trial_granted && effective_plan_handle.is_none() {
        return Some(EntitlementCheckResult::with_reason(
            "allowed",
            true,
            "granted_by_reverse_trial",
        ));
    }

    // Plan-matching key: trial-granted entitlements use the GRANTED plan
    // (limits apply); everything else uses the user's base plan.
    let plan_handle_for_matching = match (handle_is_trial_granted, effective_plan_handle) {
        (true, Some(granted_plan)) => granted_plan,
        _ => input.current_plan_handle,
    };

    // Trimmed, so a whitespace-only handle collapses to "no identity" rather
    // than becoming an identity that matches no plan. Both fail closed, but
    // only the collapsed form reports the actual cause (plan 194 REQ-1).
    let normalized_plan_handle = plan_handle_for_matching.trim().to_lowercase();

    let plans = playbook
        .get("plans")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    // Plan 191 REQ-1: plan identity IS the handle. `plans[].id` is DB-internal
    // and never participates in matching — a context whose only plan signal is
    // that id must miss every plan-targeted rule.
    let matched_plan = plans.iter().find(|p| {
        p.get("unique_handle")
            .and_then(Value::as_str)
            .is_some_and(|h| h.to_lowercase() == normalized_plan_handle)
    });

    // The handle the user's current plan is known by — plan targets are
    // handle-valued, so this is what a `kind:'plan'` target matches against.
    let current_plan_handle_ref: Option<String> = matched_plan
        .and_then(|p| p.get("unique_handle"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            if normalized_plan_handle.is_empty() {
                None
            } else {
                Some(normalized_plan_handle.clone())
            }
        });

    // Plan 194 REQ-1. Without a plan identity there is nothing to match plan
    // targets against, and the rule filter below used to SKIP the plan check
    // rather than fail it — so every plan-targeted rule matched and a
    // plan-gated entitlement came back allowed for a user with no plan.
    // Entitlement-rule targeting has been explicit since plan 34 REQ-9 (an
    // empty `targets` matches nothing), so "no identity" can only ever mean
    // "matches nothing", never "matches everything". The reason is distinct
    // from `no_matching_entitlement_rule` on purpose: "we could not identify
    // the user's plan" is a broken integration, "their plan lacks this" is a
    // correctly-gated user, and telemetry has to tell them apart.
    if current_plan_handle_ref.is_none() && holdings.is_empty() {
        return Some(EntitlementCheckResult::with_reason(
            "denied",
            false,
            "no_plan_identity",
        ));
    }
    let current_plan_handle_ref = current_plan_handle_ref.unwrap_or_default();

    let rules = playbook
        .get("entitlement_rules")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    // Plan #39 REQ-28: build the segment_id → dimension_id lookup once per
    // call. Segments missing a dimension fall into `__no_dim__` inside the
    // matcher, preserving flat-OR back-compat for pre-PR-B exports.
    //
    // Plan 234 TASK-2: keyed by HANDLE, matching the TS canonical (rule
    // `segment_ids` are handle-valued, plan 120 TASK-4). ST-1391: the key is
    // DERIVED from each segment's predicates (`classify_segment`), so a stored
    // `dimension_id` (the BUG-1389 upload placeholder) cannot decide it.
    let segment_dimensions: HashMap<String, String> = segment_dimension_keys(
        playbook
            .get("segments")
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice),
    );

    let matches_holding = |rule: &Value, holding: &Value| -> bool {
        rule.get("targets")
            .and_then(Value::as_array)
            .is_some_and(|targets| {
                targets.iter().any(|t| {
                    (t.get("kind").and_then(Value::as_str) == Some("addon")
                        && t.get("id") == holding.get("addon_handle"))
                        || (t.get("kind").and_then(Value::as_str) == Some("addon_variation")
                            && holding.get("addon_variation_handle").is_some()
                            && t.get("id") == holding.get("addon_variation_handle"))
                })
            })
    };
    let matches_baseline = |rule: &Value| -> bool {
        if current_plan_handle_ref.is_empty() {
            return false;
        }
        if let Some(targets) = rule.get("targets").and_then(Value::as_array) {
            targets
                .iter()
                .any(|t| match t.get("kind").and_then(Value::as_str) {
                    Some("plan") => {
                        t.get("id").and_then(Value::as_str)
                            == Some(current_plan_handle_ref.as_str())
                    }
                    Some("plan_variation") => playbook
                        .get("plan_variations")
                        .and_then(Value::as_array)
                        .is_some_and(|vs| {
                            vs.iter().any(|v| {
                                v.get("handle") == t.get("id")
                                    && v.get("plan_handle").and_then(Value::as_str)
                                        == Some(current_plan_handle_ref.as_str())
                                    && v.get("billing_period").and_then(Value::as_str)
                                        == input.billing_period
                                    && v.get("segment_handle").and_then(Value::as_str).is_none_or(
                                        |s| s.is_empty() || input.segment_ids.contains(s),
                                    )
                            })
                        }),
                    _ => false,
                })
        } else {
            rule.get("plan_ids")
                .or_else(|| rule.get("planIds"))
                .and_then(Value::as_array)
                .is_some_and(|ids| {
                    ids.iter()
                        .any(|id| id.as_str() == Some(current_plan_handle_ref.as_str()))
                })
        }
    };
    let matches = |rule: &Value| -> bool {
        let rule_ent_id = rule
            .get("entitlement_id")
            .and_then(Value::as_str)
            .or_else(|| rule.get("entitlementId").and_then(Value::as_str))
            .unwrap_or("");
        if rule_ent_id != entitlement_id {
            return false;
        }

        // Match an ordinary plan grant or an explicitly purchased holding.
        if !matches_baseline(rule) && !holdings.iter().any(|h| matches_holding(rule, h)) {
            return false;
        }

        let rule_segment_ids: Option<Vec<String>> = rule
            .get("segment_ids")
            .or_else(|| rule.get("segmentIds"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            });

        matches_rule_segments(
            rule_segment_ids.as_deref(),
            &input.segment_ids,
            &segment_dimensions,
        )
    };

    let matching_rules: Vec<&Value> = rules.iter().filter(|r| matches(r)).collect();

    // No rule grants this entitlement to the user's plan. Plan #39 made plan
    // targeting explicit, so the absence of a match means NOT granted — deny,
    // failing closed.
    if matching_rules.is_empty() {
        return Some(EntitlementCheckResult::with_reason(
            "denied",
            false,
            "no_matching_entitlement_rule",
        ));
    }

    // Plan 147 (OQ-6): the wire is flat — the rule IS the type-fields bag, and
    // `kind` is derived from the parent entitlement's type. A legacy nested
    // `type_fields` / camel `typeFields` bag is tolerated for the migration
    // window, merged UNDER the flat fields (flat wins).
    let mut entitlement_type_by_handle: HashMap<&str, &str> = HashMap::new();
    for e in entitlements {
        if let (Some(h), Some(t)) = (
            e.get("unique_handle").and_then(Value::as_str),
            e.get("type").and_then(Value::as_str),
        ) {
            entitlement_type_by_handle.insert(h, t);
        }
    }

    let type_fields_of = |r: &Value| -> Value {
        let mut merged = Map::new();
        if let Some(nested) = r
            .get("type_fields")
            .or_else(|| r.get("typeFields"))
            .and_then(Value::as_object)
        {
            for (k, v) in nested {
                merged.insert(k.clone(), v.clone());
            }
        }
        if let Some(flat) = r.as_object() {
            for (k, v) in flat {
                merged.insert(k.clone(), v.clone());
            }
        }
        if !merged.get("kind").is_some_and(Value::is_string) {
            if let Some(ent_id) = r.get("entitlement_id").and_then(Value::as_str) {
                if let Some(derived) = entitlement_type_by_handle.get(ent_id) {
                    merged.insert("kind".into(), Value::String((*derived).to_string()));
                }
            }
        }
        Value::Object(merged)
    };

    // §2.6.5 (plan 34 REQ-1): when multiple rules match, the MOST PERMISSIVE
    // wins — NOT array order. Reuses the single-sourced scorer + tie-break, so
    // this is identical to find_matching_entitlement_rule.
    let scored: Vec<(&Value, Value)> = matching_rules
        .iter()
        .map(|r| (*r, type_fields_of(r)))
        .collect();
    let chosen = pick_most_permissive(&scored, |(_, tf)| {
        let kind = tf.get("kind").and_then(Value::as_str).unwrap_or("");
        rule_permissiveness(kind, tf)
    });
    // BL-0062 (gap G3): read the winner's IDENTITY as well as its fields. The
    // `(_, tf)` destructure that used to stand here threw the rule `&Value`
    // away while it was in hand. Rule refs are handle-valued (plan 120
    // TASK-4), so the rule's `id` IS its `unique_handle`; an empty id is
    // missing data, not a rule named "". Mirrors entitlement-check.ts
    // `selectedRuleHandle`.
    let mut selected_rule = chosen.map_or(matching_rules[0], |(rule, _)| *rule).clone();
    let mut type_fields =
        chosen.map_or_else(|| type_fields_of(matching_rules[0]), |(_, tf)| tf.clone());
    let mut effective_allowance = None;
    let mut contributing_handles = None;
    if !holdings.is_empty()
        && allowance_field(
            type_fields
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
        .is_some()
    {
        let as_allowance = |rule: &Value| {
            let fields = type_fields_of(rule);
            AllowanceRule {
                id: rule.get("id").and_then(Value::as_str).unwrap_or("").into(),
                kind: fields
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                fields,
                source: rule.clone(),
            }
        };
        let score = |r: &AllowanceRule| rule_permissiveness(&r.kind, &r.fields);
        let recurring =
            |r: &AllowanceRule| r.kind != "credits" || r.fields.get("reset_period").is_some();
        let mut purchases = Vec::new();
        for holding in &holdings {
            let candidates: Vec<_> = matching_rules
                .iter()
                .filter(|r| matches_holding(r, holding))
                .map(|r| as_allowance(r))
                .filter(&recurring)
                .collect();
            if let Some(rule) = pick_most_permissive(&candidates, score) {
                let billing_period = addon_variations
                    .iter()
                    .find(|v| {
                        holding.get("addon_variation_handle").is_some()
                            && v.get("handle") == holding.get("addon_variation_handle")
                    })
                    .and_then(|v| v.get("billing_period"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                purchases.push(PurchasedContribution {
                    rule: rule.clone(),
                    quantity: holding["quantity"].as_f64().unwrap_or(0.0),
                    billing_period,
                });
            }
        }
        let baselines: Vec<_> = matching_rules
            .iter()
            .filter(|r| matches_baseline(r))
            .map(|r| as_allowance(r))
            .filter(|r| purchases.is_empty() || recurring(r))
            .collect();
        let baseline = pick_most_permissive(&baselines, score).cloned();
        match aggregate_purchased_allowance(baseline, purchases, input.billing_period) {
            Ok(Some(aggregate)) => {
                selected_rule = aggregate.rule.source;
                type_fields = aggregate.rule.fields;
                effective_allowance = aggregate.effective_allowance;
                contributing_handles = aggregate.contributing_rule_handles;
            }
            Ok(None) => {
                return Some(EntitlementCheckResult::with_reason(
                    "denied",
                    false,
                    "no_matching_entitlement_rule",
                ))
            }
            Err(message) => return invalid(message),
        }
    }
    let selected_rule_handle = selected_rule
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string);

    // JS `??` chain: nullish-coalescing — 0 passes through, only absent falls
    // to the next source. Explicit `is_none()` checks, never `unwrap_or`,
    // which would skip a legitimate 0.
    let usage_amount_for = |key: &str| -> Option<f64> {
        input
            .user_usage?
            .get(key)
            .filter(|e| e.is_object())?
            .get("amount")
            .and_then(Value::as_f64)
    };
    let finite_balance = |key: &str| -> Option<f64> {
        input
            .usage_balances
            .get(key)
            .copied()
            .filter(|v| v.is_finite())
    };

    let used = input.context_used.unwrap_or_else(|| {
        finite_balance(input.handle)
            .or_else(|| finite_balance(&entitlement_id))
            .or_else(|| usage_amount_for(input.handle))
            .or_else(|| usage_amount_for(&entitlement_id))
            .unwrap_or(0.0)
    });

    let mut result = with_rule_handle(
        derive_result_with_allowance(
            &type_fields,
            used,
            effective_allowance,
            input.context_balance,
            CostInput {
                cost: input.context_cost.as_ref(),
                diagnose_handle: input.diagnostics.then_some(input.handle),
            },
        ),
        selected_rule_handle,
    );
    result.contributing_rule_handles = contributing_handles;
    Some(result)
}

/// Stamp the winning rule's handle onto a shaped result (BL-0062).
///
/// Kept out of `derive_result_from_rule_type_fields` deliberately: that shaper
/// reads `type_fields`, and a rule's IDENTITY is not one of its type fields.
/// Both evaluators own the selection, so both stamp. `None` leaves the field
/// `None`, which `skip_serializing_if` omits entirely — absence and null are
/// different bytes in a canonical-JSON parity snapshot.
///
/// Source: entitlement-check.ts (withRuleHandle)
pub fn with_rule_handle(
    mut result: EntitlementCheckResult,
    rule_handle: Option<String>,
) -> EntitlementCheckResult {
    if let Some(handle) = rule_handle {
        result.rule_handle = Some(handle);
    }
    result
}
