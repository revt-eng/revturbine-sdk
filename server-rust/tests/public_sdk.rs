//! The public `RevTurbineCustomerSdk` façade.
//!
//! Mirrors `server-python/tests/test_public_api.py`. The load-bearing property
//! is **output transparency**: the façade must add no decision logic, or the
//! parity gate stops proving anything about what customers actually call.

use serde_json::{json, Value};

use revturbine::adapters::{create_static_providers, StaticProviderOptions};
use revturbine::runtime::{LocalRuntime, PlacementDecisionInput};
use revturbine::sdk::{RevTurbineCustomerSdk, UserContext};

fn playbook() -> Value {
    json!({
        "artifact_type": "playbook",
        "format_version": "1.0.0",
        "tenant_id": "tenant_1",
        "environment_id": "env_1",
        "plans": [{ "unique_handle": "starter" }],
        "entitlements": [{ "unique_handle": "exports", "type": "usage_limit" }],
        "entitlement_rules": [],
        "segments": [],
        "content_ui_paths": [],
        "placements": [{
            "id": "pl_banner",
            "category": "fixed",
            "order": 0,
            "payloads": [{
                "id": "pay_1",
                "status": "active",
                "surfaces": [{
                    "template_id": "banner_placement",
                    "fields": { "header": "Hello", "body": "Body" },
                    "ctas": [{ "label": "Go", "path": "view_plans" }],
                }],
            }],
        }],
    })
}

fn ctx() -> UserContext {
    UserContext {
        tenant_id: "tenant_1".into(),
        user_id: "user_1".into(),
        plan_handle: Some("starter".into()),
        ..Default::default()
    }
}

fn input() -> PlacementDecisionInput {
    PlacementDecisionInput {
        placement_id: "pl_banner".into(),
        user_id: "user_1".into(),
    }
}

#[test]
fn the_facade_is_output_transparent() {
    // THE contract: every method is a pure delegation, so the façade's output
    // is byte-identical to driving LocalRuntime directly. If this ever
    // diverges, the parity gate stops proving anything about the surface
    // customers actually call.
    let pb = playbook();
    let mut sdk = RevTurbineCustomerSdk::new(&ctx(), &pb).expect("constructs");

    let providers = create_static_providers(
        &pb,
        &StaticProviderOptions {
            plan_handle: Some("starter".into()),
            ..Default::default()
        },
    );
    let mut runtime = LocalRuntime::new(pb.clone(), providers, "tenant_1", "user_1");

    assert_eq!(
        serde_json::to_value(sdk.check_entitlement("exports", None)).unwrap(),
        serde_json::to_value(runtime.check_entitlement("exports", None)).unwrap(),
    );
    assert_eq!(
        sdk.get_placement_decision(&input()),
        runtime.get_placement_decision(&input()),
    );
}

#[test]
fn it_accepts_a_legacy_artifact_through_the_dual_read_boundary() {
    let mut legacy = playbook();
    let obj = legacy.as_object_mut().unwrap();
    obj.remove("artifact_type");
    obj.remove("format_version");
    obj.insert("version".into(), json!("1.0.0"));

    let mut sdk = RevTurbineCustomerSdk::new(&ctx(), &legacy).expect("legacy is accepted");
    assert_eq!(sdk.get_placement_decision(&input())["visible"], json!(true));
}

#[test]
fn a_malformed_playbook_errors_rather_than_deciding() {
    // A partially-understood Playbook can silently over-grant, so this must
    // fail construction — not build a runtime that decides on half of it.
    let mut broken = playbook();
    broken.as_object_mut().unwrap().remove("entitlements");
    assert!(RevTurbineCustomerSdk::new(&ctx(), &broken).is_err());

    assert!(RevTurbineCustomerSdk::new(&ctx(), &json!("nope")).is_err());
    assert!(RevTurbineCustomerSdk::new(&ctx(), &Value::Null).is_err());
}

#[test]
fn trial_status_reaches_the_trial_gates() {
    // Without the overlay every trial_* gate reads "no trial" and declines,
    // which looks like a config problem rather than a plumbing one.
    let mut trial_pb = playbook();
    trial_pb["placements"][0]["category"] = json!("trials");
    trial_pb["placements"][0]["trigger"] = json!({ "type": "trial_ended" });

    let without = RevTurbineCustomerSdk::new(&ctx(), &trial_pb)
        .unwrap()
        .runtime()
        .get_placement_decision(&input());
    assert_eq!(
        without["visible"],
        json!(false),
        "no trial state → declines"
    );

    let with_trial = UserContext {
        trial_status: Some(json!({ "in_trial": false, "state": "expired" })),
        ..ctx()
    };
    let mut sdk = RevTurbineCustomerSdk::new(&with_trial, &trial_pb).unwrap();
    assert_eq!(
        sdk.get_placement_decision(&input())["visible"],
        json!(true),
        "an expired trial fires the trial_ended placement",
    );
}

#[test]
fn instances_carry_no_cross_user_state() {
    // Construct-per-user-context is the intended usage; two SDKs over the same
    // Playbook must not see each other's interactions.
    let pb = playbook();
    let mut a = RevTurbineCustomerSdk::new(&ctx(), &pb).unwrap();
    let mut b = RevTurbineCustomerSdk::new(
        &UserContext {
            user_id: "user_2".into(),
            ..ctx()
        },
        &pb,
    )
    .unwrap();

    assert_eq!(a.get_placement_decision(&input())["visible"], json!(true));
    let b_input = PlacementDecisionInput {
        placement_id: "pl_banner".into(),
        user_id: "user_2".into(),
    };
    assert_eq!(b.get_placement_decision(&b_input)["visible"], json!(true));
}

#[test]
fn the_batch_form_preserves_order() {
    let pb = playbook();
    let mut sdk = RevTurbineCustomerSdk::new(&ctx(), &pb).unwrap();
    let inputs = vec![
        PlacementDecisionInput {
            placement_id: "missing".into(),
            user_id: "user_1".into(),
        },
        input(),
    ];
    let out = sdk.get_placement_decisions(&inputs);
    assert_eq!(out[0]["placement_id"], json!("missing"));
    assert_eq!(out[1]["placement_id"], json!("pl_banner"));
}
