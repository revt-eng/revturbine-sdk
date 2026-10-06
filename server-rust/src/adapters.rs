//! Static domain providers.
//!
//! Turns a Playbook snapshot plus a user's plan/usage into the resolved
//! provider context every decision reads — the `plan`, `entitlements`,
//! `segments`, `rules`, `content` and `theme` states.
//!
//! The TS and Python ports return a *list of lazy providers* that a registry
//! resolves. Here the providers are pure snapshots over data already in hand,
//! with no I/O to defer, so this produces the **resolved context directly** —
//! the same map `resolve_all()` yields. A provider indirection whose only
//! implementation is "return this value" would add a layer without adding a
//! capability.
//!
//! A provider is **omitted entirely** when the Playbook carries no data for it,
//! matching the ports: an absent `entitlements` key is what makes the
//! entitlement check fall back to config-rule evaluation, so emitting an empty
//! state instead would silently change behaviour.
//!
//! Source: revturbine-scaffold/src/core/adapters/static.ts

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::segments::evaluate_segments;
use crate::user_context::build_targeting_state;

/// Inputs the caller supplies alongside the Playbook.
#[derive(Debug, Clone, Default)]
pub struct StaticProviderOptions {
    /// The user's current plan handle. No plan provider without it.
    pub plan_handle: Option<String>,
    /// Display name; defaults to the handle.
    pub plan_name: Option<String>,
    /// Per-entitlement `{used, limit}` overrides.
    pub usage: Option<Value>,
    /// Billing-recovery signal for the retention qualifiers.
    pub payment_failed: Option<bool>,
    /// Billing-recovery signal for the retention qualifiers.
    pub payment_at_risk: Option<bool>,
    /// Current tier per `capability_tier` entitlement, for the tier gate.
    pub tiers: Option<Value>,
    /// `allow` (default) or `deny` — the status every entitlement starts at.
    pub default_entitlement_policy: EntitlementPolicy,
    /// Tenant segment handles the app already resolved for this user, reported
    /// as members verbatim (BL-0369).
    pub segment_ids: Option<Vec<String>>,
    /// The user-context snapshot segment membership is evaluated from
    /// (BL-0369). `None` evaluates nothing: membership is `segment_ids` alone
    /// (fail closed).
    pub user_context: Option<Value>,
    /// The control plane's server-resolved built-in dimensions for this user
    /// (BL-0366) — the `builtin_dimensions` of
    /// `GET /api/sdk/user-contexts/{userId}/builtin-dimensions`, which the
    /// app's backend reads with its server key (this crate has no HTTP
    /// transport and never fetches it). Overlaid per key on
    /// `user_context.builtin_dimensions` before membership is evaluated: a
    /// delivered leaf wins over the app-set value (plan 279 PD-3), an app-set
    /// leaf the server did not deliver is kept. Ignored without a
    /// `user_context` (fail closed). See [`apply_server_builtin_dimensions`].
    pub server_builtin_dimensions: Option<Value>,
}

/// What a static entitlement resolves to before rules are applied.
///
/// `Default` (`Allow`) is the STATIC ADAPTER's blanket default, which TS
/// keeps at `'allow'` — those entries carry `origin: "playbook_default"` and
/// never decide a `LocalRuntime::check_entitlement` (D-61). The runtime's own
/// engine default is `Deny`; see `LocalRuntime::with_entitlement_policy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EntitlementPolicy {
    /// Everything allowed unless a rule says otherwise.
    #[default]
    Allow,
    /// Everything denied unless a rule says otherwise.
    Deny,
}

impl EntitlementPolicy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
        }
    }
    fn allowed(self) -> bool {
        self == Self::Allow
    }
}

fn arr<'a>(config: &'a Value, key: &str) -> &'a [Value] {
    config
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[][..], |v| v.as_slice())
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

/// The Playbook's version identifier: canonical `format_version`, else the
/// legacy `version`, else `""`.
///
/// Source: helpers.ts (playbookVersion)
fn playbook_version(config: &Value) -> String {
    s(config, "format_version")
        .or_else(|| s(config, "version"))
        .unwrap_or_default()
}

/// Overlay server-resolved built-in dimensions onto an app-supplied user
/// context (BL-0366; plan 279 PD-3: the server value wins).
///
/// Per key: every leaf of `server_builtin_dimensions` replaces the app's value
/// for that dimension; an app-set leaf the server did not deliver is kept —
/// the overlay `mergeUserContext` applies to a client-context delivery in the
/// browser. Returns the context unchanged when either side is absent (a
/// non-object overlay counts as absent). Pure: the input is never mutated.
///
/// Source: static.ts (applyServerBuiltinDimensions)
#[must_use]
pub fn apply_server_builtin_dimensions(
    user_context: Option<&Value>,
    server_builtin_dimensions: Option<&Value>,
) -> Option<Value> {
    let context = user_context?;
    let (Some(overlay), Some(fields)) = (
        server_builtin_dimensions.and_then(Value::as_object),
        context.as_object(),
    ) else {
        return Some(context.clone());
    };
    let mut dimensions = fields
        .get("builtin_dimensions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (key, value) in overlay {
        dimensions.insert(key.clone(), value.clone());
    }
    let mut merged = fields.clone();
    merged.insert("builtin_dimensions".into(), Value::Object(dimensions));
    Some(Value::Object(merged))
}

/// The segment handles a static snapshot's user belongs to (BL-0369).
///
/// The browser SDK's rule (`resolveEffectiveProviderContext`): the
/// caller-resolved `segment_ids`, then every configured segment whose
/// predicates match `build_targeting_state(user_context).segment_traits` (the
/// reserved `rt_*` traits come only from `builtin_dimensions`, plan 279 PD-3),
/// with `user_context.experiments` as the enrollment map — deduplicated in
/// first-seen order. No user context evaluates nothing (fail closed, PD-4).
/// This used to report EVERY configured segment, so a payload or rule chipped
/// to any segment was served to every user.
///
/// Source: static.ts (resolveStaticSegmentMembership)
#[must_use]
pub fn resolve_static_segment_membership(
    config: &Value,
    segment_ids: Option<&[String]>,
    user_context: Option<&Value>,
) -> Vec<String> {
    let mut members: Vec<String> = segment_ids.map(<[String]>::to_vec).unwrap_or_default();
    if let Some(context) = user_context {
        let state = build_targeting_state(context, Some(config), None);
        let assignments: BTreeMap<String, String> = context
            .get("experiments")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    // Enrollment is key presence (as `in` on the TS side),
                    // so a non-string variant still enrolls.
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            v.as_str().map_or_else(|| v.to_string(), str::to_string),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let traits = state
            .get("segment_traits")
            .cloned()
            .unwrap_or_else(|| json!({}));
        members.extend(evaluate_segments(
            arr(config, "segments"),
            &traits,
            &assignments,
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    members.retain(|m| seen.insert(m.clone()));
    members
}

/// Build the resolved provider context from a Playbook snapshot.
///
/// Source: static.ts:42-182 (createStaticProviders)
#[must_use]
pub fn create_static_providers(config: &Value, opts: &StaticProviderOptions) -> Value {
    let mut ctx = Map::new();

    if let Some(handle) = opts.plan_handle.as_deref().filter(|h| !h.is_empty()) {
        let mut plan = Map::new();
        plan.insert("current_plan_handle".into(), json!(handle));
        plan.insert(
            "current_plan_name".into(),
            json!(opts.plan_name.as_deref().unwrap_or(handle)),
        );
        // Omitted when not supplied — the retention qualifiers fail closed on
        // absent state, which differs from an explicit `false`.
        if let Some(v) = opts.payment_failed {
            plan.insert("payment_failed".into(), json!(v));
        }
        if let Some(v) = opts.payment_at_risk {
            plan.insert("payment_at_risk".into(), json!(v));
        }
        ctx.insert("plan".into(), Value::Object(plan));
    }

    let entitlements = arr(config, "entitlements");
    if !entitlements.is_empty() {
        let policy = opts.default_entitlement_policy;
        let mut entries = Map::new();
        let mut usage_out = Map::new();

        for ent in entitlements {
            let Some(handle) = s(ent, "unique_handle") else {
                continue;
            };
            entries.insert(
                handle.clone(),
                json!({
                    "status": if policy.allowed() { "allowed" } else { "denied" },
                    "allowed": policy.allowed(),
                    "reason": format!("static_config_default_{}", policy.as_str()),
                }),
            );

            let Some(override_entry) = opts
                .usage
                .as_ref()
                .and_then(|u| u.get(&handle))
                .filter(|e| e.is_object())
            else {
                continue;
            };
            let used = override_entry
                .get("used")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let limit = override_entry
                .get("limit")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let mut entry = Map::new();
            entry.insert("used".into(), json!(used));
            entry.insert("limit".into(), json!(limit));
            // Never negative — an over-consumed allowance reports 0 left, not
            // a negative remainder.
            entry.insert("remaining".into(), json!((limit - used).max(0.0)));
            if let Some(unit) = ent.get("unit").filter(|u| !u.is_null()) {
                entry.insert("unit".into(), unit.clone());
            }
            usage_out.insert(handle, Value::Object(entry));
        }

        let mut state = Map::new();
        state.insert("entries".into(), Value::Object(entries));
        // D-61: blanket defaults, not app-mirrored data. An entitlements state
        // WITHOUT this marker is app data and merges with the Playbook
        // evaluation per the runtime's precedence.
        state.insert("origin".into(), json!("playbook_default"));
        state.insert("usage".into(), Value::Object(usage_out));
        if let Some(tiers) = opts.tiers.as_ref() {
            state.insert("tiers".into(), tiers.clone());
        }
        ctx.insert("entitlements".into(), Value::Object(state));
    }

    // The user's segment MEMBERSHIP, never the configured catalogue (BL-0369).
    // Segment identity is the handle (plan 120), so both views carry the same
    // handles.
    let supplied_segment_ids = opts.segment_ids.as_deref().filter(|ids| !ids.is_empty());
    if !arr(config, "segments").is_empty() || supplied_segment_ids.is_some() {
        let context = apply_server_builtin_dimensions(
            opts.user_context.as_ref(),
            opts.server_builtin_dimensions.as_ref(),
        );
        let members = resolve_static_segment_membership(
            config,
            opts.segment_ids.as_deref(),
            context.as_ref(),
        );
        ctx.insert(
            "segments".into(),
            json!({ "segment_ids": members, "segment_slugs": members }),
        );
    }

    let rules = arr(config, "entitlement_rules");
    if !rules.is_empty() {
        // Plan 147: the wire is flat — `kind` derives from the parent
        // entitlement's type, indexed by handle.
        let ent_type_by_handle: BTreeMap<String, String> = entitlements
            .iter()
            .filter_map(|e| Some((s(e, "unique_handle")?, s(e, "type")?)))
            .collect();

        let mut by_ent: Map<String, Value> = Map::new();
        for rule in rules {
            let Some(ent_id) = s(rule, "entitlement_id") else {
                continue;
            };

            // Flat wire: the rule IS the type-fields bag. A legacy nested
            // `type_fields` is tolerated, with the flat fields winning.
            let mut fields = rule
                .get("type_fields")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(flat) = rule.as_object() {
                for (k, v) in flat {
                    fields.insert(k.clone(), v.clone());
                }
            }

            let kind = s(rule, "kind")
                .or_else(|| rule.get("type_fields").and_then(|tf| s(tf, "kind")))
                .or_else(|| ent_type_by_handle.get(&ent_id).cloned())
                .unwrap_or_else(|| "feature".to_string());

            // Kind-discriminated targets, with a legacy flat `plan_ids`
            // fallback. Under the fail-closed ruling an unmapped legacy rule
            // would DENY the entitlement rather than merely not enrich it.
            let targets = arr(rule, "targets");
            let plan_ids: Vec<Value> = if targets.is_empty() {
                arr(rule, "plan_ids")
                    .iter()
                    .filter(|p| p.is_string())
                    .cloned()
                    .collect()
            } else {
                targets
                    .iter()
                    .filter(|t| t.get("kind").and_then(Value::as_str) == Some("plan"))
                    .filter_map(|t| t.get("id").cloned())
                    .collect()
            };

            let segment_ids: Vec<Value> = arr(rule, "segment_ids")
                .iter()
                .filter(|s| s.is_string())
                .cloned()
                .collect();

            let snapshot = json!({
                "rule_id": rule.get("id").cloned().unwrap_or(Value::Null),
                "entitlement_id": ent_id,
                "plan_ids": plan_ids,
                "kind": kind,
                "fields": Value::Object(fields),
                "segment_ids": segment_ids,
            });

            by_ent
                .entry(ent_id)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .expect("just inserted an array")
                .push(snapshot);
        }

        // Plan #39 REQ-28: the segment → dimension lookup the rule evaluator
        // needs for intra-dimension OR / cross-dimension AND, keyed by handle
        // (plan 120). Omitting it collapsed every segment into one OR bucket on
        // the provider-backed path — invisible while every configured segment
        // matched, a grant once membership is real (BL-0369).
        let segment_dimensions: Map<String, Value> = arr(config, "segments")
            .iter()
            .filter_map(|seg| Some((s(seg, "handle")?, json!(s(seg, "dimension_id")?))))
            .collect();

        ctx.insert(
            "rules".into(),
            json!({
                "entitlement_rules": Value::Object(by_ent),
                "segment_dimensions": Value::Object(segment_dimensions),
                "config_version": playbook_version(config),
            }),
        );
    }

    let message_blocks = arr(config, "message_blocks");
    let personalization_tokens = arr(config, "personalization_tokens");
    if !message_blocks.is_empty() || !personalization_tokens.is_empty() {
        let mut blocks = Map::new();
        for block in message_blocks {
            let Some(block_id) = s(block, "block_id") else {
                continue;
            };
            let mut entry = Map::new();
            entry.insert("block_id".into(), json!(block_id));
            entry.insert(
                "name".into(),
                block.get("name").cloned().unwrap_or(Value::Null),
            );
            entry.insert(
                "default_content".into(),
                block.get("default_content").cloned().unwrap_or(Value::Null),
            );
            entry.insert(
                "status".into(),
                block.get("status").cloned().unwrap_or(Value::Null),
            );
            if let Some(overrides) = block.get("segment_overrides").and_then(Value::as_array) {
                // `segment_value_id` is renamed to `segment_id` for the
                // provider-state shape.
                entry.insert(
                    "segment_overrides".into(),
                    Value::Array(
                        overrides
                            .iter()
                            .map(|o| {
                                json!({
                                    "segment_id": o.get("segment_value_id").cloned().unwrap_or(Value::Null),
                                    "content": o.get("content").cloned().unwrap_or(Value::Null),
                                })
                            })
                            .collect(),
                    ),
                );
            }
            blocks.insert(block_id, Value::Object(entry));
        }
        ctx.insert(
            "content".into(),
            json!({ "message_blocks": Value::Object(blocks), "personalization": {} }),
        );
    }

    if let Some(theme) = config
        .get("theme")
        .and_then(Value::as_object)
        .filter(|t| !t.is_empty())
    {
        ctx.insert(
            "theme".into(),
            json!({ "overrides": Value::Object(theme.clone()) }),
        );
    }

    Value::Object(ctx)
}
