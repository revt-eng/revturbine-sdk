//! Presentation-cap and cooldown enforcement.
//!
//! Reads cap policies (`max_per_period` + `cooldown_days`) off a placement
//! output and either records the presentation or denies it with a per-rule
//! reason code, persisting state through any [`RevTurbineStorage`].
//!
//! Source: revturbine-scaffold/src/core/state/cap-enforcer.ts

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::helpers::{parse_cap_rule, period_window_start, PlacementCapRule};
use crate::state::storage::RevTurbineStorage;

const STORAGE_PREFIX: &str = "revturbine:presentation-caps";
const MS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// A bundle of cap rules plus an optional cooldown for one placement output.
///
/// Source: state/types.ts:56-59 (PlacementCapPolicy)
#[derive(Debug, Clone, PartialEq)]
pub struct PlacementCapPolicy {
    /// Rules that must all pass for the presentation to be allowed.
    pub rules: Vec<PlacementCapRule>,
    /// Cooldown to apply after a successful presentation, in ms.
    pub cooldown_ms: Option<i64>,
}

/// Per-(tenant, user, surface, output) presentation history.
///
/// Source: state/types.ts:61-66 (PresentationCapState)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PresentationCapState {
    /// Epoch-ms timestamps of prior presentations.
    pub seen_at: Vec<i64>,
    /// Epoch-ms instant before which presentations are suppressed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown_until: Option<i64>,
}

/// The outcome of [`CapEnforcer::enforce`].
///
/// Source: state/types.ts:96-99 (CapEnforcementResult)
#[derive(Debug, Clone, PartialEq)]
pub struct CapEnforcementResult {
    /// Whether the presentation may proceed.
    pub allowed: bool,
    /// Suppression cause, present only when denied.
    pub reason: Option<String>,
}

/// Enforces per-placement caps and cooldowns against persisted history.
///
/// # Clock injection
///
/// The TypeScript and Python ports read the wall clock inline. This port takes
/// an injectable `now_ms`, defaulting to system time. Behaviour is identical —
/// but cap decisions are *time-dependent*, so a fixed clock is what makes them
/// testable at window boundaries and deterministic under the parity corpus'
/// `fixedNow`. The alternative is tests that cannot assert a boundary without
/// sleeping.
///
/// Source: cap-enforcer.ts:60-208
pub struct CapEnforcer<S: RevTurbineStorage> {
    storage: S,
    tenant_id: String,
    user_id: String,
    caps_by_key: HashMap<String, PresentationCapState>,
    now_fn: Box<dyn Fn() -> i64 + Send + Sync>,
}

fn system_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl<S: RevTurbineStorage> CapEnforcer<S> {
    /// Construct and hydrate from storage.
    pub fn new(storage: S, tenant_id: &str, user_id: &str) -> Self {
        Self::with_clock(storage, tenant_id, user_id, Box::new(system_now_ms))
    }

    /// Construct with an explicit clock. See the type-level note.
    pub fn with_clock(
        storage: S,
        tenant_id: &str,
        user_id: &str,
        now_fn: Box<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        let mut me = Self {
            storage,
            tenant_id: tenant_id.to_string(),
            user_id: user_id.to_string(),
            caps_by_key: HashMap::new(),
            now_fn,
        };
        me.hydrate();
        me
    }

    /// Decide whether `output` is allowed by its cap + cooldown policies.
    ///
    /// On success the presentation is recorded and persisted. On failure the
    /// suppression reason is returned and **nothing is recorded** — a denied
    /// presentation must not count against the user's own cap.
    ///
    /// Source: cap-enforcer.ts:81-128
    pub fn enforce(&mut self, output: &Value) -> CapEnforcementResult {
        let policies = Self::extract_policies(output);
        if policies.is_empty() {
            return CapEnforcementResult {
                allowed: true,
                reason: None,
            };
        }

        let key = self.cap_key(output);
        let now = (self.now_fn)();

        let existing = self.caps_by_key.get(&key).cloned().unwrap_or_default();
        // Defensive cleanup on read — drops malformed timestamps.
        let mut state = PresentationCapState {
            seen_at: existing
                .seen_at
                .iter()
                .copied()
                .filter(|ts| *ts > 0)
                .collect(),
            cooldown_until: existing.cooldown_until,
        };

        // An active cooldown takes precedence over per-period caps.
        if state.cooldown_until.is_some_and(|until| until > now) {
            self.caps_by_key.insert(key, state);
            return CapEnforcementResult {
                allowed: false,
                reason: Some("suppressed_by_payload_cooldown".into()),
            };
        }

        // The first rule that has been hit causes denial.
        for policy in &policies {
            for rule in &policy.rules {
                let window_start = period_window_start(&rule.period, now as f64);
                let within: Vec<i64> = state
                    .seen_at
                    .iter()
                    .copied()
                    .filter(|ts| (*ts as f64) >= window_start && *ts <= now)
                    .collect();
                if within.len() as f64 >= rule.count {
                    // Trim in-memory state to the active window so the next
                    // call does not re-scan stale timestamps.
                    self.caps_by_key.insert(
                        key,
                        PresentationCapState {
                            seen_at: within,
                            cooldown_until: state.cooldown_until,
                        },
                    );
                    return CapEnforcementResult {
                        allowed: false,
                        reason: Some(format!("suppressed_by_payload_cap_{}", rule.period)),
                    };
                }
            }
        }

        // Allowed — record this presentation.
        state.seen_at.push(now);

        let max_cooldown = policies
            .iter()
            .filter_map(|p| p.cooldown_ms)
            .filter(|ms| *ms > 0)
            .max();
        state.cooldown_until = max_cooldown.map(|ms| now + ms);

        self.caps_by_key.insert(key, state);
        self.persist();
        CapEnforcementResult {
            allowed: true,
            reason: None,
        }
    }

    /// Load state from storage. Malformed JSON is dropped and the storage
    /// entry removed.
    ///
    /// Source: cap-enforcer.ts:132-154
    pub fn hydrate(&mut self) {
        let storage_key = self.storage_key();
        let Some(raw) = self.storage.get_item(&storage_key) else {
            return;
        };
        if raw.is_empty() {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            self.storage.remove_item(&storage_key);
            return;
        };
        let Some(obj) = parsed.as_object() else {
            return;
        };
        for (key, value) in obj {
            let Some(entry) = value.as_object() else {
                continue;
            };
            let seen_at: Vec<i64> = entry
                .get("seen_at")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_i64)
                        .filter(|ts| *ts > 0)
                        .collect()
                })
                .unwrap_or_default();
            let cooldown_until = entry
                .get("cooldown_until")
                .and_then(Value::as_f64)
                .filter(|f| f.is_finite())
                .map(|f| f as i64);
            self.caps_by_key.insert(
                key.clone(),
                PresentationCapState {
                    seen_at,
                    cooldown_until,
                },
            );
        }
    }

    /// Best-effort write to storage. Serialization failure is swallowed —
    /// cap state is an optimization, and losing it must never fail a decision.
    ///
    /// Source: cap-enforcer.ts:156-163
    pub fn persist(&mut self) {
        if let Ok(json) = serde_json::to_string(&self.caps_by_key) {
            let key = self.storage_key();
            self.storage.set_item(&key, &json);
        }
    }

    fn storage_key(&self) -> String {
        format!("{STORAGE_PREFIX}:{}:{}", self.tenant_id, self.user_id)
    }

    fn cap_key(&self, output: &Value) -> String {
        let surface_type = output
            .get("surface")
            .filter(|s| s.is_object())
            .and_then(|s| s.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let output_id = output
            .get("output_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        format!(
            "{}:{}:{}:{}",
            self.tenant_id, self.user_id, surface_type, output_id
        )
    }

    /// Walk `output`, `output.content`, and the legacy
    /// `content.{payload,placement,surface}` nests, collecting every `caps`
    /// block found. Caps declared at any level all apply.
    ///
    /// Source: cap-enforcer.ts:175-207
    fn extract_policies(output: &Value) -> Vec<PlacementCapPolicy> {
        let mut roots: Vec<&Value> = vec![output];
        if let Some(content) = output.get("content").filter(|c| c.is_object()) {
            roots.push(content);
            for nested_key in ["payload", "placement", "surface"] {
                if let Some(nested) = content.get(nested_key) {
                    roots.push(nested);
                }
            }
        }

        roots
            .into_iter()
            .filter(|r| r.is_object())
            .filter_map(|root| root.get("caps").filter(|c| c.is_object()))
            .map(|caps| {
                let rules = parse_cap_rule(caps.get("max_per_period"))
                    .map(|r| vec![r])
                    .unwrap_or_default();
                let cooldown_ms = caps
                    .get("cooldown_days")
                    .and_then(Value::as_f64)
                    .filter(|d| d.is_finite() && *d > 0.0)
                    .map(|d| (d * MS_PER_DAY) as i64);
                PlacementCapPolicy { rules, cooldown_ms }
            })
            .collect()
    }
}
