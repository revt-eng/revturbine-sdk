//! Cross-language payload version-refusal matrix — plan 177 TASK-3 / AC-3.
//!
//! Drives the Rust implementation over the shared matrix at
//! `tests/parity/canonical/version-refusal.json` and asserts the exact
//! outcome — `accepted` or the refusal reason. TypeScript is the reference
//! (scaffold `json-payload.ts`); the Python driver runs the same matrix. A
//! mismatch here is a Rust port bug, never a matrix to edit.
//!
//! The matrix pins reader windows explicitly per case so it never goes stale
//! when the live constants bump; the live-constant defaults are asserted
//! here separately.

use revturbine::config::{
    assert_playbook_payload_readable, BUNDLE_MIN_READABLE_SCHEMA_VERSION, BUNDLE_SCHEMA_VERSION,
};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

fn matrix() -> Value {
    // server-rust/tests/<file> → ../../tests/parity/canonical — the same
    // out-of-tree reach as canonical_corpus.rs.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/parity/canonical/version-refusal.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("matrix missing at {}: {e}", path.display()));
    serde_json::from_str(&text).expect("matrix is valid JSON")
}

fn window(v: &Value) -> (Option<u64>, Option<u64>) {
    (
        v.get("schema_version").and_then(Value::as_u64),
        v.get("min_readable_schema_version").and_then(Value::as_u64),
    )
}

fn outcome(payload: &Value, reader: (Option<u64>, Option<u64>)) -> String {
    match assert_playbook_payload_readable(payload, reader.0, reader.1) {
        Ok(_) => "accepted".into(),
        Err(err) => err.reason.as_str().into(),
    }
}

#[test]
fn every_matrix_case_agrees_with_the_reference() {
    let m = matrix();
    let default_reader = window(&m["reader"]);
    for case in m["cases"].as_array().expect("cases array") {
        let name = case["name"].as_str().expect("case name");
        let expect = case["expect"].as_str().expect("case expect");
        let reader = case.get("reader").map(window).unwrap_or(default_reader);
        let got = outcome(&case["payload"], reader);
        assert_eq!(got, expect, "{name}: expected {expect}, got {got}");
    }
}

#[test]
fn the_matrix_is_not_vacuous() {
    // Every refusal reason and the accept path must be exercised, or a port
    // could pass while silently missing a branch.
    let m = matrix();
    let outcomes: BTreeSet<String> = m["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["expect"].as_str().unwrap().to_string())
        .collect();
    let want: BTreeSet<String> = [
        "accepted",
        "malformed_envelope",
        "missing_schema_version",
        "schema_version_too_new",
        "schema_version_too_old",
        "requires_newer_reader",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert_eq!(outcomes, want);
}

#[test]
fn live_constants_are_the_default_reader_window() {
    // The matrix pins windows explicitly; the defaults come from the live
    // constants and must track scaffold's ir.ts.
    assert_eq!(BUNDLE_SCHEMA_VERSION, 14);
    assert_eq!(BUNDLE_MIN_READABLE_SCHEMA_VERSION, 11);
    let payload = serde_json::json!({ "bundle_schema_version": BUNDLE_SCHEMA_VERSION });
    assert!(assert_playbook_payload_readable(&payload, None, None).is_ok());
}
