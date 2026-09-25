//! Trial-episode revision classification and the port's record surface.
//!
//! Rust port of scaffold's `src/trials/models/trial-revision.ts` (plan 276
//! TASK-12/TASK-13, rulings R-1 / R-2; workspace ruling D-21). Same rule order,
//! same closed reason set, same output as the TypeScript and Python sides —
//! parity = Rust ≡ TS ≡ Python.
//!
//! Pure and **clock-free**. `observed_through` is supplied by the caller and
//! nothing here reads the wall clock, so an episode whose scheduled end has
//! merely passed classifies as `pending_unknown` and produces no event. That is
//! R-1(c): an elapsed deadline proves only that the time passed.
//!
//! The port has no event transport, and this module deliberately does not add
//! one. `record_trial_revision` returns the **validated payload for the host to
//! ship** through whatever ingest path it already has; a server SDK opening its
//! own network path to RevTurbine would be a second, unversioned ingest client.
//! What the port owes is that the payload is byte-identical to the browser
//! SDK's for the same facts, which the parity fixtures assert.
//!
//! Source: revturbine-scaffold/src/trials/models/trial-revision.ts

use serde_json::{json, Map, Value};

/// Every revision an episode can undergo.
pub const TRIAL_REVISION_KINDS: [&str; 6] = [
    "started",
    "extended",
    "converted",
    "reverted",
    "expired",
    "revoked",
];

/// The three authority tiers. There is deliberately no `clock` tier (R-1(c)).
pub const TRIAL_EVIDENCE_KINDS: [&str; 3] = ["provider_fact", "app_fact", "usage_exhaustion"];

/// Why an episode has no supported revision. Closed set.
pub const TRIAL_PENDING_UNKNOWN_REASONS: [&str; 6] = [
    "no_authoritative_fact",
    "elapsed_deadline_without_fact",
    "episode_open",
    "usage_expiry_requires_exhaustion_evidence",
    "commitment_precedes_actual_end",
    "end_evidence_without_effective_time",
];

/// Sources naming a USER-grain act. Plan 276 R-2: a user signup does not
/// establish account creation, and neither does a first observation.
pub const USER_GRAIN_SIGNUP_SOURCES: [&str; 3] = ["user_signup", "user_signed_up", "first_seen"];

/// An evidence object, or `None` for anything that is not one.
fn evidence_of(value: Option<&Value>) -> Option<&Map<String, Value>> {
    let obj = value?.as_object()?;
    obj.get("ref").and_then(Value::as_str)?;
    obj.get("kind").and_then(Value::as_str)?;
    Some(obj)
}

fn str_of(facts: &Map<String, Value>, key: &str) -> Option<String> {
    facts.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Lexicographic comparison is correct for ISO-8601 UTC instants.
fn at_or_after(a: &str, b: &str) -> bool {
    a >= b
}

fn grants_account(facts: &Map<String, Value>) -> bool {
    facts.get("subject_scope").and_then(Value::as_str) == Some("account")
}

fn pending(reason: &str, facts: &Map<String, Value>) -> Value {
    json!({
        "status": "pending_unknown",
        "reason": reason,
        "grants_account_access": grants_account(facts),
    })
}

fn resolved(
    revision: &str,
    effective_at: &str,
    evidence: &Map<String, Value>,
    facts: &Map<String, Value>,
    commitment_ref: Option<&Value>,
) -> Value {
    json!({
        "status": "revision",
        "revision": revision,
        "effective_at": effective_at,
        "evidence": {
            "kind": evidence.get("kind").cloned().unwrap_or(Value::Null),
            "ref": evidence.get("ref").cloned().unwrap_or(Value::Null),
            "occurred_at": evidence.get("occurred_at").cloned().unwrap_or(Value::Null),
        },
        "grants_account_access": grants_account(facts),
        "commitment_ref": commitment_ref.cloned().unwrap_or(Value::Null),
    })
}

/// Classify one trial episode's facts into the revision they support.
///
/// Pure, clock-free and total.
pub fn classify_trial_revision(facts: &Map<String, Value>) -> Value {
    if let Some(revocation) = evidence_of(facts.get("revocation")) {
        let at = revocation
            .get("occurred_at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        return resolved("revoked", &at, revocation, facts, None);
    }

    let enrollment = match evidence_of(facts.get("enrollment")) {
        Some(e) => e,
        None => return pending("no_authoritative_fact", facts),
    };

    let end_evidence = evidence_of(facts.get("end_evidence"));
    let actual_end_at = str_of(facts, "actual_end_at");
    let closed = end_evidence.is_some() || actual_end_at.is_some();

    if !closed {
        if let Some(extension) = evidence_of(facts.get("extension")) {
            let at = extension
                .get("occurred_at")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            return resolved("extended", &at, extension, facts, None);
        }
        let deadline = str_of(facts, "scheduled_end_at");
        let observed = str_of(facts, "observed_through");
        if let (Some(deadline), Some(observed)) = (deadline, observed) {
            if at_or_after(&observed, &deadline) {
                // R-1(c): the deadline passed and nothing evidenced an end.
                return pending("elapsed_deadline_without_fact", facts);
            }
        }
        return match str_of(facts, "started_at") {
            Some(started) => resolved("started", &started, enrollment, facts, None),
            None => pending("episode_open", facts),
        };
    }

    let end_evidence = match end_evidence {
        Some(e) => e,
        None => return pending("end_evidence_without_effective_time", facts),
    };
    let resolved_end = actual_end_at.clone().unwrap_or_else(|| {
        end_evidence
            .get("occurred_at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    });

    // A conversion links ONLY its own episode's commitment, at or after the
    // evidenced end (plan 276 AC-4).
    if let Some(commitment) = facts.get("commitment").and_then(Value::as_object) {
        if commitment.get("trial_episode_id") == facts.get("trial_episode_id") {
            let started = commitment.get("started_at").and_then(Value::as_str);
            return match started {
                Some(started) if at_or_after(started, &resolved_end) => resolved(
                    "converted",
                    started,
                    end_evidence,
                    facts,
                    commitment.get("ref"),
                ),
                _ => pending("commitment_precedes_actual_end", facts),
            };
        }
    }

    if facts.get("limit_type").and_then(Value::as_str) == Some("usage") {
        let mut exhaustion = evidence_of(facts.get("exhaustion"));
        if exhaustion.is_none()
            && end_evidence.get("kind").and_then(Value::as_str) == Some("usage_exhaustion")
        {
            exhaustion = Some(end_evidence);
        }
        let exhaustion = match exhaustion {
            Some(e) => e,
            None => return pending("usage_expiry_requires_exhaustion_evidence", facts),
        };
        let effective = actual_end_at.unwrap_or_else(|| {
            exhaustion
                .get("occurred_at")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        });
        return resolved("expired", &effective, exhaustion, facts, None);
    }

    if let Some(fallback) = evidence_of(facts.get("fallback")) {
        let at = fallback
            .get("occurred_at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        return resolved("reverted", &at, fallback, facts, None);
    }
    resolved("expired", &resolved_end, end_evidence, facts, None)
}

fn label(labels: Option<&Map<String, Value>>, key: &str) -> Value {
    labels
        .and_then(|l| l.get(key))
        .cloned()
        .unwrap_or(Value::Null)
}

/// Translate an episode plus a verdict into the `trial_revision` payload, or
/// `None` when the verdict supports no revision.
pub fn build_trial_revision_payload(
    facts: &Map<String, Value>,
    classification: &Value,
    labels: Option<&Map<String, Value>>,
) -> Option<Value> {
    if classification.get("status").and_then(Value::as_str) != Some("revision") {
        return None;
    }
    let evidence = classification.get("evidence")?;
    Some(json!({
        "trial_episode_id": facts.get("trial_episode_id").cloned().unwrap_or(Value::Null),
        "account_id": facts.get("account_id").cloned().unwrap_or(Value::Null),
        "subject_scope": facts.get("subject_scope").cloned().unwrap_or(Value::Null),
        "rule_handle": label(labels, "rule_handle"),
        "plan_handle": label(labels, "plan_handle"),
        "trial_type": label(labels, "trial_type"),
        "revision": classification.get("revision").cloned().unwrap_or(Value::Null),
        "effective_at": classification.get("effective_at").cloned().unwrap_or(Value::Null),
        "scheduled_end_at": facts.get("scheduled_end_at").cloned().unwrap_or(Value::Null),
        "actual_end_at": facts.get("actual_end_at").cloned().unwrap_or(Value::Null),
        "evidence": {
            "kind": evidence.get("kind").cloned().unwrap_or(Value::Null),
            "ref": evidence.get("ref").cloned().unwrap_or(Value::Null),
        },
        "provider_ref": label(labels, "provider_ref"),
    }))
}

/// Classify one episode and return the payload the host should ship.
///
/// Records nothing itself: the port has no transport. `status` is
/// `payload_ready` with a payload, or `pending_unknown` with `payload: null`.
pub fn record_trial_revision(
    facts: &Map<String, Value>,
    labels: Option<&Map<String, Value>>,
) -> Value {
    let classification = classify_trial_revision(facts);
    let payload = build_trial_revision_payload(facts, &classification, labels);
    json!({
        "status": if payload.is_some() { "payload_ready" } else { "pending_unknown" },
        "classification": classification,
        "payload": payload.unwrap_or(Value::Null),
    })
}

/// Validate an `account_created` payload and return it for the host to ship.
///
/// Refuses a user-grain source (plan 276 R-2) and a payload missing the account
/// grain, the creation time or the evidence (REQ-3 requires all three).
pub fn record_account_created(payload: &Map<String, Value>) -> Value {
    if let Some(source) = payload.get("source").and_then(Value::as_str) {
        if USER_GRAIN_SIGNUP_SOURCES.contains(&source) {
            return json!({
                "status": "refused",
                "reason": "user_grain_signup_is_not_account_creation",
                "payload": Value::Null,
            });
        }
    }
    for (field, reason) in [
        ("source", "unrecognized_source"),
        ("evidence", "no_evidence"),
        ("account_id", "no_account_grain"),
        ("created_at", "no_creation_time"),
    ] {
        let present = match payload.get(field) {
            None | Some(Value::Null) => false,
            Some(Value::String(s)) => !s.is_empty(),
            Some(_) => true,
        };
        if !present {
            return json!({ "status": "refused", "reason": reason, "payload": Value::Null });
        }
    }
    let evidence = payload.get("evidence").cloned().unwrap_or(Value::Null);
    let mut out = Map::new();
    out.insert(
        "account_id".into(),
        payload.get("account_id").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "created_at".into(),
        payload.get("created_at").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "source".into(),
        payload.get("source").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "evidence".into(),
        json!({
            "kind": evidence.get("kind").cloned().unwrap_or(Value::Null),
            "ref": evidence.get("ref").cloned().unwrap_or(Value::Null),
        }),
    );
    if let Some(acq) = payload.get("acquisition_source") {
        if !acq.is_null() {
            out.insert("acquisition_source".into(), acq.clone());
        }
    }
    json!({ "status": "payload_ready", "reason": Value::Null, "payload": Value::Object(out) })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-language agreement on the classifier is the parity fixture's job
    /// (`trial_revision_classification`, ts/py/rs over the same corpus). These
    /// cover what the fixture cannot reach: that the port returns a payload
    /// rather than emitting, and `record_account_created`, which is pure
    /// validation with no classification to compare.
    fn open_episode() -> Map<String, Value> {
        json!({
            "trial_episode_id": "app:acct_1:reverse:1",
            "account_id": "acct_1",
            "subject_scope": "account",
            "limit_type": "time",
            "enrollment": { "kind": "app_fact", "ref": "write_1", "occurred_at": "2026-09-01T00:00:00.000Z" },
            "started_at": "2026-09-01T00:00:00.000Z",
            "scheduled_end_at": "2026-09-15T00:00:00.000Z",
            "actual_end_at": Value::Null,
            "end_evidence": Value::Null,
            "extension": Value::Null,
            "revocation": Value::Null,
            "commitment": Value::Null,
            "fallback": Value::Null,
            "exhaustion": Value::Null,
            "observed_through": "2026-09-05T00:00:00.000Z",
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn an_elapsed_deadline_yields_no_payload() {
        let mut facts = open_episode();
        facts.insert(
            "observed_through".into(),
            Value::String("2026-10-30T00:00:00.000Z".into()),
        );
        let result = record_trial_revision(&facts, None);
        assert_eq!(result["status"], "pending_unknown");
        assert!(result["payload"].is_null());
        assert_eq!(
            result["classification"]["reason"],
            "elapsed_deadline_without_fact"
        );
    }

    #[test]
    fn returns_a_payload_for_the_host_to_ship() {
        let mut facts = open_episode();
        facts.insert(
            "actual_end_at".into(),
            Value::String("2026-09-15T00:00:00.000Z".into()),
        );
        facts.insert(
            "end_evidence".into(),
            json!({ "kind": "app_fact", "ref": "write_end", "occurred_at": "2026-09-15T00:00:00.000Z" }),
        );
        let labels = json!({ "rule_handle": "reverse_14d" });
        let result = record_trial_revision(&facts, labels.as_object());
        assert_eq!(result["status"], "payload_ready");
        assert_eq!(result["payload"]["revision"], "expired");
        assert_eq!(
            result["payload"]["effective_at"],
            "2026-09-15T00:00:00.000Z"
        );
        assert_eq!(result["payload"]["rule_handle"], "reverse_14d");
        assert!(result["payload"]["plan_handle"].is_null());
    }

    #[test]
    fn a_user_subject_episode_never_grants_account_access() {
        let mut facts = open_episode();
        facts.insert("subject_scope".into(), Value::String("user".into()));
        let result = classify_trial_revision(&facts);
        assert_eq!(result["grants_account_access"], false);
    }

    #[test]
    fn account_creation_refuses_a_user_grain_source() {
        let payload = json!({
            "account_id": "acct_1",
            "created_at": "2026-09-01T00:00:00.000Z",
            "source": "user_signup",
            "evidence": { "kind": "app_fact", "ref": "write_1" },
        });
        let result = record_account_created(payload.as_object().unwrap());
        assert_eq!(result["status"], "refused");
        assert_eq!(
            result["reason"],
            "user_grain_signup_is_not_account_creation"
        );
        assert!(result["payload"].is_null());
    }

    #[test]
    fn account_creation_refuses_an_unevidenced_claim() {
        let payload = json!({
            "account_id": "acct_1",
            "created_at": "2026-09-01T00:00:00.000Z",
            "source": "self_serve_signup",
            "evidence": Value::Null,
        });
        let result = record_account_created(payload.as_object().unwrap());
        assert_eq!(result["reason"], "no_evidence");
    }

    #[test]
    fn account_creation_accepts_the_evidenced_shape() {
        let payload = json!({
            "account_id": "acct_1",
            "created_at": "2026-09-01T00:00:00.000Z",
            "source": "self_serve_signup",
            "evidence": { "kind": "app_fact", "ref": "write_1" },
            "acquisition_source": "organic",
        });
        let result = record_account_created(payload.as_object().unwrap());
        assert_eq!(result["status"], "payload_ready");
        assert_eq!(result["payload"]["acquisition_source"], "organic");
    }

    #[test]
    fn every_declared_constant_is_the_contract() {
        assert_eq!(TRIAL_REVISION_KINDS.len(), 6);
        assert_eq!(TRIAL_EVIDENCE_KINDS.len(), 3);
        // R-1(c): there is no clock authority tier.
        assert!(!TRIAL_EVIDENCE_KINDS.contains(&"clock"));
        assert_eq!(TRIAL_PENDING_UNKNOWN_REASONS.len(), 6);
        assert_eq!(USER_GRAIN_SIGNUP_SOURCES.len(), 3);
    }
}
