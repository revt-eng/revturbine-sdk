//! BL-0122 — payload SELECTION is per-payload, not first-payload-wins.
//!
//! Mirrors `revturbine-scaffold/src/placements/controllers/
//! local-resolver-payload-selection.test.ts` and
//! `server-python/tests/placements/test_payload_selection.py` case for case.
//!
//! The defect: the index took only the first active payload of an entry, so
//! payloads 2+ never became candidates and their `target.segment_chips` could
//! never be evaluated. Plan 233 TASK-7 made the chip predicate real, but only
//! for the one payload that reached it — a placement with an admin payload and
//! a member payload gave every member either the admin copy or nothing at all.
//!
//! The contract (placement-prioritization.md §1 stage 3): "Targeting — the
//! user's plan and segment match **a payload**". Drag precedence ranks among
//! payloads the user MATCHES; it is not a pre-filter.

use revturbine::placements::StaticPlacementResolver;
use serde_json::{json, Value};

fn config() -> Value {
    json!({
        "format_version": "1.0",
        "plans": [],
        "entitlements": [],
        "segments": [],
        "surface_templates": [{ "id": "modal_overlay", "surface_type": "modal" }],
    })
}

fn payload(id: &str, header: &str, chips: Value) -> Value {
    json!({
        "id": id,
        "status": "active",
        "target": { "plan_ids": [], "segment_chips": chips },
        "surfaces": [{
            "template_id": "modal_overlay",
            "fields": { "header": header, "body": "Body" },
            "ctas": [{ "label": "Go", "path": "open_checkout", "config": {} }],
        }],
    })
}

fn entry(payloads: Vec<Value>) -> Value {
    json!({ "id": "pl_foo", "category": "gated", "order": 0, "payloads": payloads })
}

fn two_chipped() -> Value {
    entry(vec![
        payload("payload_admin", "Admin message", json!(["seg_org_admin"])),
        payload(
            "payload_member",
            "Member message",
            json!(["seg_org_member"]),
        ),
    ])
}

/// The slot record (carries `surface_template_ids`) and the bare direct-lookup
/// record — both paths must gate identically.
fn records() -> Vec<Option<Value>> {
    vec![
        Some(json!({ "name": "pl_foo", "surface_template_ids": ["modal_overlay"] })),
        Some(json!({ "name": "pl_foo" })),
    ]
}

fn ctx(slugs: Value) -> Value {
    json!({ "__providers": { "segments": { "segment_ids": [], "segment_slugs": slugs } } })
}

#[test]
fn serves_the_second_payload_to_a_user_chipped_to_it() {
    for record in records() {
        let r = StaticPlacementResolver::new(&[two_chipped()], &config());
        let d = r.resolve(
            "pl_foo",
            record.as_ref(),
            Some(&ctx(json!(["seg_org_member"]))),
            None,
        );

        assert_eq!(d["visible"], json!(true), "{d}");
        assert_eq!(d["content"]["header"], json!("Member message"), "{d}");
        assert_eq!(d["output"]["output_id"], json!("payload_member"), "{d}");
    }
}

#[test]
fn still_serves_the_first_payload_to_a_user_chipped_to_it() {
    // Drag precedence is untouched for a user who matches payload 1.
    for record in records() {
        let r = StaticPlacementResolver::new(&[two_chipped()], &config());
        let d = r.resolve(
            "pl_foo",
            record.as_ref(),
            Some(&ctx(json!(["seg_org_admin"]))),
            None,
        );

        assert_eq!(d["visible"], json!(true), "{d}");
        assert_eq!(d["content"]["header"], json!("Admin message"), "{d}");
    }
}

#[test]
fn refuses_when_the_user_matches_no_payload() {
    for record in records() {
        let r = StaticPlacementResolver::new(&[two_chipped()], &config());
        let d = r.resolve(
            "pl_foo",
            record.as_ref(),
            Some(&ctx(json!(["seg_outsider"]))),
            None,
        );

        assert_eq!(d["visible"], json!(false), "{d}");
        assert_eq!(d["reason_codes"], json!(["segment_target_mismatch"]), "{d}");
    }
}

#[test]
fn takes_the_earlier_payload_when_the_user_matches_both() {
    // Among payloads the user DOES match, authored order still decides — the
    // fix widens candidacy, it does not re-rank matches.
    for record in records() {
        let r = StaticPlacementResolver::new(&[two_chipped()], &config());
        let d = r.resolve(
            "pl_foo",
            record.as_ref(),
            Some(&ctx(json!(["seg_org_member", "seg_org_admin"]))),
            None,
        );

        assert_eq!(d["content"]["header"], json!("Admin message"), "{d}");
    }
}

#[test]
fn serves_an_unchipped_later_payload_when_the_chipped_first_one_misses() {
    // An unchipped payload targets everyone, so it is always a candidate.
    for record in records() {
        let e = entry(vec![
            payload("payload_admin", "Admin message", json!(["seg_org_admin"])),
            payload("payload_all", "Everyone message", json!([])),
        ]);
        let r = StaticPlacementResolver::new(&[e], &config());
        let d = r.resolve(
            "pl_foo",
            record.as_ref(),
            Some(&ctx(json!(["seg_org_member"]))),
            None,
        );

        assert_eq!(d["visible"], json!(true), "{d}");
        assert_eq!(d["content"]["header"], json!("Everyone message"), "{d}");
    }
}
