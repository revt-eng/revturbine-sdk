//! Cross-language canonical-JSON golden corpus — plan 177 TASK-1 / AC-1.
//!
//! Asserts the Rust canonicalizer reproduces, byte for byte, what the
//! TypeScript reference implementation produced for every document in
//! `tests/parity/canonical/`. TypeScript is canonical per
//! `tests/parity/sides.json`; a mismatch here is a **Rust port bug**, never a
//! golden to regenerate.
//!
//! This is the assertion that actually closes AC-1. The unit tests in
//! `canonical_json.rs` prove the cases someone thought to write; this proves
//! agreement on 10 real tenant configs nobody curated for the purpose — which
//! is where fractional prices, unicode content, and unusual key orderings
//! actually live.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use revturbine::canonical_json::canonicalize_json;

#[derive(Deserialize)]
struct Documents {
    documents: Vec<DocumentEntry>,
}

#[derive(Deserialize)]
struct DocumentEntry {
    name: String,
    doc: Value,
}

#[derive(Deserialize)]
struct Golden {
    documents: Vec<GoldenEntry>,
}

#[derive(Deserialize)]
struct GoldenEntry {
    name: String,
    sha256: String,
}

fn canonical_dir() -> PathBuf {
    // server-rust/ -> sdk-internal root
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("parity")
        .join("canonical")
}

fn load() -> (Vec<DocumentEntry>, BTreeMap<String, String>) {
    let dir = canonical_dir();
    let docs_path = dir.join("documents.json");
    let golden_path = dir.join("golden.json");

    let docs_raw = fs::read_to_string(&docs_path).unwrap_or_else(|e| {
        panic!(
            "canonical corpus missing at {}: {e}. \
             Run: node tests/parity/canonical/generate.mjs",
            docs_path.display()
        )
    });
    let golden_raw = fs::read_to_string(&golden_path)
        .unwrap_or_else(|e| panic!("golden missing at {}: {e}", golden_path.display()));

    let docs: Documents = serde_json::from_str(&docs_raw).expect("documents.json parse");
    let golden: Golden = serde_json::from_str(&golden_raw).expect("golden.json parse");

    let by_name: BTreeMap<String, String> = golden
        .documents
        .into_iter()
        .map(|e| (e.name, e.sha256))
        .collect();

    // A document with no golden entry would otherwise pass silently by simply
    // not being asserted — the exact way a corpus gate stops proving anything.
    let missing: Vec<&str> = docs
        .documents
        .iter()
        .filter(|d| !by_name.contains_key(&d.name))
        .map(|d| d.name.as_str())
        .collect();
    assert!(
        missing.is_empty(),
        "documents with no golden entry: {missing:?}"
    );
    assert_eq!(
        docs.documents.len(),
        by_name.len(),
        "corpus and golden are different sizes"
    );

    (docs.documents, by_name)
}

#[test]
fn matches_typescript_reference() {
    let (documents, golden) = load();
    let mut failures = Vec::new();

    for entry in &documents {
        let canonical = canonicalize_json(&entry.doc)
            .unwrap_or_else(|e| panic!("canonicalization failed for {}: {e}", entry.name));
        let actual = format!("{:x}", Sha256::digest(canonical.as_bytes()));
        let expected = &golden[&entry.name];
        if &actual != expected {
            let head: String = canonical.chars().take(400).collect();
            failures.push(format!(
                "  {}\n    expected sha256: {expected}\n    actual sha256:   {actual}\n    produced: {head}",
                entry.name
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "canonicalization diverged from the TypeScript reference for {} document(s):\n{}\n\
         This is a Rust port bug. Do NOT regenerate the golden to make it pass.",
        failures.len(),
        failures.join("\n")
    );
}

/// Guard the corpus's own shape.
///
/// Real-config coverage is the half that catches what nobody curated, so a
/// regeneration on a machine without `revturbine-demo-data` — which would
/// silently drop it — must fail here rather than quietly weaken the gate.
#[test]
fn corpus_covers_both_edge_cases_and_real_configs() {
    let (documents, _) = load();
    let names: Vec<&str> = documents.iter().map(|d| d.name.as_str()).collect();

    let count = |prefix: &str| names.iter().filter(|n| n.starts_with(prefix)).count();
    assert!(count("config__") >= 5, "too few real configs: {names:?}");
    assert!(count("number__") >= 5, "too few number cases: {names:?}");
    assert!(count("sort__") >= 1, "no sort cases: {names:?}");
    assert!(count("string__") >= 1, "no string cases: {names:?}");
}

/// Re-canonicalizing canonical output must be a no-op.
///
/// Catches a class the sha comparison cannot: a canonicalizer stable against
/// the reference but not against itself would still corrupt any pipeline that
/// canonicalizes twice.
#[test]
fn canonicalization_is_idempotent() {
    let (documents, _) = load();
    for entry in &documents {
        let once = canonicalize_json(&entry.doc).expect("first pass");
        let reparsed: Value = serde_json::from_str(&once).expect("canonical output must parse");
        let twice = canonicalize_json(&reparsed).expect("second pass");
        assert_eq!(once, twice, "not idempotent for {}", entry.name);
    }
}
