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
/// Source: helpers.ts (configuredPlanNameFromPlaybook)
#[must_use]
pub fn configured_plan_name_from_playbook(
    playbook: Option<&Value>,
    plan_value: Option<&str>,
) -> Option<String> {
    let plans = playbook?.get("plans")?.as_array()?;
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

// ── Built-in segment dimensions (plan 279 PD-1/PD-4) ──────────────────────
//
// Contract: targeting-studio-ui.md §4.1 "Built-in segment resolution
// contract". Source: scaffold `segments/controllers/builtin-dimensions.ts`
// (the catalogue) and `user/controllers/user-context.ts`
// (`deriveBuiltinDimensionTraits`).

/// The reserved trait-key prefix. Only `builtin_dimensions` (and `id`, for
/// registration) may set a key under it.
pub const BUILTIN_TRAIT_KEY_PREFIX: &str = "rt_";

/// The delivered dimensions in catalogue order, each with its closed
/// vocabulary. `None` marks Seat Type, whose values are tenant seat-type
/// handles. Registration State is absent: it is SDK-local (from `id`).
pub const BUILTIN_DIMENSION_VOCABULARIES: &[(&str, Option<&[&str]>)] = &[
    (
        "activity_level",
        Some(&["new", "high", "medium", "low", "inactive"]),
    ),
    (
        "subscription_state",
        Some(&["none", "trial", "paid", "cancelled"]),
    ),
    ("trial_type", Some(&["none", "free_trial", "reverse_trial"])),
    ("seat_type", None),
    ("buyer_role", Some(&["buyer", "non_buyer"])),
    ("email_type", Some(&["business", "personal", "unknown"])),
    (
        "billing_health",
        Some(&[
            "no_billing",
            "good_standing",
            "trial_payment_method_attached",
            "payment_method_missing",
            "payment_failed",
            "payment_overdue",
            "cancelled",
        ]),
    ),
    ("region", Some(&["us_canada", "europe", "rest_of_world"])),
    (
        "device_type",
        Some(&["desktop", "mobile", "tablet", "unknown"]),
    ),
];

/// Whether a trait key falls under the reserved `rt_` prefix.
///
/// Source: builtin-dimensions.ts (isReservedTraitKey)
#[must_use]
pub fn is_reserved_trait_key(key: &str) -> bool {
    key.starts_with(BUILTIN_TRAIT_KEY_PREFIX)
}

/// `HANDLE_PATTERN` (`^[a-z0-9._]{1,100}$`) capped at 87 characters, so that
/// `rt.seat_type.<handle>` stays within the 100-character handle limit. Every
/// accepted character is ASCII, so byte length equals the TS UTF-16 length.
fn is_seat_type_value(value: &str) -> bool {
    (1..=87).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_')
}

/// The reserved `rt_<dimension>` segment traits for a user context.
///
/// `rt_registration_state` is always stamped: `registered` iff `id` is a
/// non-empty string. Every other dimension is stamped only from
/// `builtin_dimensions`, and only with an in-vocabulary string; an absent or
/// out-of-vocabulary value stamps nothing (unknown is absence). A
/// `registration_state` key inside `builtin_dimensions` is ignored.
///
/// Source: user-context.ts (deriveBuiltinDimensionTraits)
#[must_use]
pub fn derive_builtin_dimension_traits(context: &Value) -> Map<String, Value> {
    let mut traits = Map::new();
    let registered = context
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty());
    traits.insert(
        "rt_registration_state".into(),
        json!(if registered {
            "registered"
        } else {
            "unregistered"
        }),
    );
    let Some(delivered) = context.get("builtin_dimensions").and_then(Value::as_object) else {
        return traits;
    };
    for (key, vocabulary) in BUILTIN_DIMENSION_VOCABULARIES {
        let Some(value) = delivered.get(*key).and_then(Value::as_str) else {
            continue;
        };
        let in_vocabulary = match vocabulary {
            Some(values) => values.contains(&value),
            None => is_seat_type_value(value),
        };
        if in_vocabulary {
            traits.insert(format!("{BUILTIN_TRAIT_KEY_PREFIX}{key}"), json!(value));
        }
    }
    traits
}

fn strip_reserved_trait_keys(bag: &mut Map<String, Value>) {
    bag.retain(|key, _| !is_reserved_trait_key(key));
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
/// Deprecated alias of [`configured_plan_name_from_playbook`].
///
/// `ExportedConfig` is dead vocabulary (BL-0156): plan 118 renamed the domain
/// object to **Playbook** and plan 104 renamed the schema type to
/// `RevTurbineConfig`, but the function names that carry a Playbook around still
/// spelled it `ExportedConfig`. Kept so an existing `use` keeps compiling.
///
/// This is the crate's FIRST `#[deprecated]` item. Clippy runs with
/// `-D warnings`, so every in-crate caller must either move to the canonical
/// name or `#[allow(deprecated)]` at the call site — which is the point: the
/// lint is the migration checklist.
#[deprecated(
    since = "0.11.0",
    note = "renamed to `configured_plan_name_from_playbook` (BL-0156); removed in 0.12.0"
)]
#[must_use]
pub fn configured_plan_name_from_exported_config(
    exported_config: Option<&Value>,
    plan_value: Option<&str>,
) -> Option<String> {
    configured_plan_name_from_playbook(exported_config, plan_value)
}

/// RESERVED trait key — a `custom.plan_handle` can never shadow or
/// impersonate the first-class identity (plan 191 REQ-2). So is every `rt_*`
/// key: stamped only from `builtin_dimensions` and `id`, and deleted when it
/// arrives through `custom`, `entitlements` or usage (plan 279 PD-1).
///
/// Source: user-context.ts (buildTargetingState)
#[must_use]
pub fn build_targeting_state(
    context: &Value,
    playbook: Option<&Value>,
    usage_overrides: Option<&Map<String, Value>>,
) -> Value {
    let plan_identity = plan_identity_from_context(context);
    let configured_plan_name =
        configured_plan_name_from_playbook(playbook, plan_identity.as_deref());
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

    // `rt_*` is a reserved trait-key PREFIX (plan 279 PD-1 — plan 191
    // REQ-2's `plan_handle` rule extended to a namespace): a custom or
    // entitlement `rt_*` key is DELETED, and the built-in dimension traits
    // are stamped from the first-class fields only.
    strip_reserved_trait_keys(&mut traits);
    traits.extend(derive_builtin_dimension_traits(context));

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
    // Usage never reaches a reserved key either (plan 279 PD-1).
    strip_reserved_trait_keys(&mut usage);

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

#[cfg(test)]
mod playbook_rename_tests {
    //! BL-0156 — `configured_plan_name_from_exported_config` is a deprecated
    //! alias of `configured_plan_name_from_playbook`.
    //!
    //! Rust has no keyword arguments, so unlike TypeScript and Python this port
    //! needed only the FUNCTION name aliased: every other `exported_config`
    //! occurrence was a positional parameter or a local, invisible to callers
    //! and renamed outright.
    //!
    //! `#[allow(deprecated)]` is scoped to this module and nowhere else in the
    //! crate. Clippy runs with `-D warnings`, so a blanket allow would defeat
    //! the deprecation: the lint IS how the next migration finds its call sites.
    #![allow(deprecated)]

    use super::{configured_plan_name_from_exported_config, configured_plan_name_from_playbook};
    use serde_json::json;

    fn playbook() -> serde_json::Value {
        json!({ "plans": [{ "unique_handle": "pro", "name": "Pro" }] })
    }

    #[test]
    fn canonical_resolves_a_plan_display_name() {
        assert_eq!(
            configured_plan_name_from_playbook(Some(&playbook()), Some("pro")),
            Some("Pro".to_string())
        );
    }

    #[test]
    fn deprecated_alias_returns_exactly_what_the_canonical_returns() {
        let pb = playbook();
        for plan in [Some("pro"), Some("PRO"), Some("missing"), None] {
            assert_eq!(
                configured_plan_name_from_exported_config(Some(&pb), plan),
                configured_plan_name_from_playbook(Some(&pb), plan),
                "alias diverged from the canonical fn for {plan:?}"
            );
        }
    }

    #[test]
    fn alias_handles_an_absent_playbook_like_the_canonical_fn() {
        assert_eq!(
            configured_plan_name_from_exported_config(None, Some("pro")),
            configured_plan_name_from_playbook(None, Some("pro"))
        );
    }
}

#[cfg(test)]
mod builtin_dimension_tests {
    //! Plan 279 TASK-4 (BL-0310/BL-0311): built-in dimension trait stamping.
    //! The byte-level contract with TS and Python is the parity fixture
    //! `builtin_dimension_traits.json`; these tests pin the port's own rules.

    use super::{
        build_targeting_state, derive_builtin_dimension_traits, BUILTIN_DIMENSION_VOCABULARIES,
    };
    use serde_json::{json, Map, Value};

    fn rt(bag: &Value) -> Map<String, Value> {
        bag.as_object()
            .expect("object")
            .iter()
            .filter(|(k, _)| k.starts_with("rt_"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    fn unregistered_only() -> Map<String, Value> {
        let mut only = Map::new();
        only.insert("rt_registration_state".into(), json!("unregistered"));
        only
    }

    #[test]
    fn anonymous_context_stamps_only_unregistered() {
        let state = build_targeting_state(&json!({}), None, None);
        assert_eq!(rt(&state["traits"]), unregistered_only());
        assert_eq!(rt(&state["segment_traits"]), unregistered_only());
    }

    #[test]
    fn registration_follows_a_non_empty_string_id() {
        let reg =
            |ctx: Value| derive_builtin_dimension_traits(&ctx)["rt_registration_state"].clone();
        assert_eq!(reg(json!({ "id": "u" })), json!("registered"));
        assert_eq!(reg(json!({ "id": "" })), json!("unregistered"));
        assert_eq!(reg(json!({ "id": 7 })), json!("unregistered"));
    }

    #[test]
    fn every_in_vocabulary_value_stamps() {
        let long = "a".repeat(87);
        for (key, vocabulary) in BUILTIN_DIMENSION_VOCABULARIES {
            let values: Vec<&str> = match vocabulary {
                Some(values) => values.to_vec(),
                None => vec!["editor", long.as_str()],
            };
            for value in values {
                let traits = derive_builtin_dimension_traits(
                    &json!({ "builtin_dimensions": { *key: value } }),
                );
                let mut expected = unregistered_only();
                expected.insert(format!("rt_{key}"), json!(value));
                assert_eq!(traits, expected, "{key}={value}");
            }
        }
    }

    #[test]
    fn out_of_vocabulary_and_wrong_type_values_drop() {
        let traits = derive_builtin_dimension_traits(&json!({
            "builtin_dimensions": {
                "registration_state": "registered",
                "activity_level": "active",
                "trial_type": "free",
                "email_type": "Business",
                "seat_type": "a".repeat(88),
                "buyer_role": true,
                "region": 3,
                "device_type": null,
                "billing_health": ""
            }
        }));
        assert_eq!(traits, unregistered_only());
        assert_eq!(
            derive_builtin_dimension_traits(&json!({ "builtin_dimensions": ["paid"] })),
            unregistered_only()
        );
    }

    #[test]
    fn reserved_keys_from_custom_entitlements_and_usage_are_deleted() {
        let mut overrides = Map::new();
        overrides.insert("rt_device_type".into(), json!(1));
        overrides.insert("seats".into(), json!(2));
        let state = build_targeting_state(
            &json!({
                "custom": { "rt_subscription_state": "paid", "rt_email_type": "business", "role": "admin" },
                "entitlements": { "rt_region": true, "beta": true },
                "usage": { "rt_activity_level": { "amount": 5 }, "api_calls": { "amount": 3 } },
                "builtin_dimensions": { "subscription_state": "trial" }
            }),
            None,
            Some(&overrides),
        );
        let mut expected = unregistered_only();
        expected.insert("rt_subscription_state".into(), json!("trial"));
        assert_eq!(rt(&state["traits"]), expected);
        assert_eq!(rt(&state["segment_traits"]), expected);
        assert!(rt(&state["usage"]).is_empty());
        assert_eq!(state["traits"]["role"], json!("admin"));
        assert_eq!(state["traits"]["beta"], json!(true));
    }
}
