//! RM-782: exercise generated serde carriers, not the evaluator's untyped Value path.
use revturbine::types::RevTurbineConfigPlanVariationsItem;
use serde_json::Value;

#[test]
fn clerk_price_snapshots_roundtrip() {
    let input = include_str!("../../tests/parity/canonical/clerk-price-snapshots.json");
    let fixtures: Vec<Value> = serde_json::from_str(input).expect("shared fixtures");
    assert_eq!(fixtures.len(), 2);
    for fixture in fixtures {
        let parsed: RevTurbineConfigPlanVariationsItem =
            serde_json::from_value(fixture.clone()).expect("Clerk snapshot must parse");
        let serialized = serde_json::to_value(parsed).expect("serialize snapshot");
        for (key, expected) in fixture.as_object().expect("fixture object") {
            if key == "price_amount" {
                assert_eq!(serialized[key].as_f64(), expected.as_f64());
            } else {
                assert_eq!(&serialized[key], expected, "field {key}");
            }
        }
        assert!(serialized.get("stripe_price_id").is_none_or(Value::is_null));
    }
}
