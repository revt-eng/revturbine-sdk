//! Rust port of scaffold's `user/controllers/user-context.ts` targeting-state
//! derivation (plan 234 TASK-8b).
//!
//! Until this landed, segment parity was "agrees given the same traits" —
//! `evaluate_segments` was byte-locked as a pure predicate, but the
//! derivation from a raw user context TO those traits existed only in the
//! TypeScript core and web SDK; this module (and its Python twin) closes
//! that to "agrees given the same user context".

use serde_json::{json, Map, Value};

/// THE plan matching identity (plan 191 Q-1, amended): the flat
/// `plan_handle` when present, else a string-form `plan`, else the plan
/// object's `handle`. `custom` never drives plan identity (REQ-2).
///
/// Source: helpers.ts (planIdentityFromContext)
#[must_use]
pub fn plan_identity_from_context(context: &Value) -> Option<String> {
    let trimmed_str = |v: Option<&Value>| -> Option<String> {
        v.and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    if let Some(handle) = trimmed_str(context.get("plan_handle")) {
        return Some(handle);
    }
    if let Some(plan) = trimmed_str(context.get("plan")) {
        return Some(plan);
    }
    trimmed_str(context.get("plan").and_then(|p| p.get("handle")))
}

/// Look up a plan's display name from a Playbook's plans list. Plan 120
/// TASK-4: plans resolve by `unique_handle` ALONE; a plan object resolves
/// nothing (callers pass the identity via [`plan_identity_from_context`]).
///
/// Source: helpers.ts (configuredPlanNameFromExportedConfig)
#[must_use]
pub fn configured_plan_name_from_exported_config(
    exported_config: Option<&Value>,
    plan_value: Option<&str>,
) -> Option<String> {
    let plans = exported_config?.get("plans")?.as_array()?;
    let plan_id = plan_value.map(str::trim).filter(|s| !s.is_empty())?;
    let normalized = plan_id.to_lowercase();

    for raw_plan in plans {
        let handle = raw_plan
            .get("unique_handle")
            .and_then(Value::as_str)
            .map(str::to_lowercase)
            .unwrap_or_default();
        if handle == normalized {
            let name = raw_plan
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// Flatten a `UserUsageEntry` map to `{handle: amount}`. Each entry may be a
/// `{amount}` record or a bare number (legacy); non-conforming entries drop.
///
/// Source: helpers.ts (usageAmountsFromEntries)
#[must_use]
pub fn usage_amounts_from_entries(usage: Option<&Value>) -> Map<String, Value> {
    let mut amounts = Map::new();
    let Some(entries) = usage.and_then(Value::as_object) else {
        return amounts;
    };
    for (key, entry) in entries {
        if let Some(amount) = entry.get("amount").and_then(Value::as_f64) {
            amounts.insert(key.clone(), json!(amount));
        } else if entry.is_object() {
            // record without a numeric amount — skip
        } else if let Some(amount) = entry.as_f64() {
            amounts.insert(key.clone(), json!(amount));
        }
    }
    amounts
}

fn is_scalar(value: &Value) -> bool {
    value.is_string() || value.is_number() || value.is_boolean()
}

/// Scalar-only trait view for segment evaluation; non-scalars drop.
///
/// Source: user-context.ts (toSegmentEvaluationTraits)
#[must_use]
pub fn to_segment_evaluation_traits(
    traits: &Map<String, Value>,
    effective_plan: Option<&str>,
    usage: &Map<String, Value>,
) -> Map<String, Value> {
    let mut segment_traits = Map::new();
    for (key, value) in traits {
        if is_scalar(value) {
            segment_traits.insert(key.clone(), value.clone());
        }
    }
    if let Some(plan) = effective_plan {
        if !plan.is_empty() && !segment_traits.contains_key("plan") {
            segment_traits.insert("plan".into(), json!(plan));
        }
    }
    for (key, amount) in usage {
        if !segment_traits.contains_key(key) {
            segment_traits.insert(key.clone(), amount.clone());
        }
    }
    segment_traits
}

/// Build the full targeting state from a user context snapshot: effective
/// plan, merged traits, usage amounts, and the scalar-only
/// segment-evaluation traits, as one pure computation. `plan_handle` is a
/// RESERVED trait key — a `custom.plan_handle` can never shadow or
/// impersonate the first-class identity (plan 191 REQ-2).
///
/// Source: user-context.ts (buildTargetingState)
#[must_use]
pub fn build_targeting_state(
    context: &Value,
    exported_config: Option<&Value>,
    usage_overrides: Option<&Map<String, Value>>,
) -> Value {
    let plan_identity = plan_identity_from_context(context);
    let configured_plan_name =
        configured_plan_name_from_exported_config(exported_config, plan_identity.as_deref());
    let effective_plan = configured_plan_name
        .clone()
        .or_else(|| plan_identity.clone());

    let mut traits: Map<String, Value> = context
        .get("custom")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    if let Some(entitlements) = context.get("entitlements").and_then(Value::as_object) {
        for (key, value) in entitlements {
            if !traits.contains_key(key) {
                traits.insert(key.clone(), value.clone());
            }
        }
    }

    match &plan_identity {
        Some(identity) => {
            traits.insert("plan_handle".into(), json!(identity));
        }
        None => {
            traits.remove("plan_handle");
        }
    }
    if let Some(name) = &configured_plan_name {
        if !traits.contains_key("plan_name") {
            traits.insert("plan_name".into(), json!(name));
        }
    }
    if let Some(plan) = &effective_plan {
        if !traits.contains_key("plan") {
            traits.insert("plan".into(), json!(plan));
        }
    }

    let mut usage = usage_amounts_from_entries(context.get("usage"));
    if let Some(overrides) = usage_overrides {
        for (key, value) in overrides {
            usage.insert(key.clone(), value.clone());
        }
    }

    for (key, amount) in &usage {
        if !traits.contains_key(key) {
            traits.insert(key.clone(), amount.clone());
        }
    }

    let segment_traits = to_segment_evaluation_traits(&traits, effective_plan.as_deref(), &usage);

    let mut state = Map::new();
    // JSON.stringify drops an undefined effectivePlan on the TS side, so the
    // key is OMITTED (never null) when there is no plan — byte parity.
    if let Some(plan) = &effective_plan {
        state.insert("effective_plan".into(), json!(plan));
    }
    state.insert("traits".into(), Value::Object(traits));
    state.insert("usage".into(), Value::Object(usage.clone()));
    state.insert("segment_traits".into(), Value::Object(segment_traits));
    Value::Object(state)
}
