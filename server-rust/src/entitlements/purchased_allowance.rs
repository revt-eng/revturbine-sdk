//! Purchased quantities and allowance arithmetic, ported from scaffold
//! `src/user/purchased-addons.ts` and `controllers/purchased-allowance.ts`.

use super::unlimited::resolve_limit_value;
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn valid_handle(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|s| {
        !s.is_empty()
            && s.len() <= 100
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_')
    })
}

/// Validate and sanitize holdings without inferring missing quantities.
pub fn validate_purchased_addons(value: Option<&Value>) -> Result<Vec<Value>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let entries = value
        .as_array()
        .ok_or("Invalid purchased add-ons: expected an array")?;
    let mut holdings = Vec::new();
    let mut keys = HashSet::new();
    let mut aggregates = HashSet::new();
    let mut variations = HashSet::new();
    for entry in entries {
        let quantity = entry.get("quantity").and_then(Value::as_f64);
        if !valid_handle(entry.get("addon_handle"))
            || (entry.get("addon_variation_handle").is_some()
                && !valid_handle(entry.get("addon_variation_handle")))
            || !quantity.is_some_and(|q| {
                q.is_finite() && (0.0..=MAX_SAFE_INTEGER).contains(&q) && q.fract() == 0.0
            })
        {
            return Err("Invalid purchased add-on handle or quantity".into());
        }
        let handle = entry["addon_handle"].as_str().unwrap_or_default();
        let variation = entry.get("addon_variation_handle").and_then(Value::as_str);
        if !keys.insert((handle, variation)) {
            return Err(format!(
                "Duplicate purchased add-on holding: {handle}:{}",
                variation.unwrap_or("")
            ));
        }
        if variation.is_some() {
            variations.insert(handle);
        } else {
            aggregates.insert(handle);
        }
        if aggregates.contains(handle) && variations.contains(handle) {
            return Err(format!(
                "Ambiguous purchased add-on aggregate and variation: {handle}"
            ));
        }
        let mut holding = json!({"addon_handle": handle, "quantity": entry["quantity"]});
        if let Some(variation) = variation {
            holding["addon_variation_handle"] = json!(variation);
        }
        holdings.push(holding);
    }
    Ok(holdings)
}

/// Resolve reset cadence without equating calendar periods with durations.
pub fn allowance_period(kind: &str, fields: &Value, billing: Option<&str>) -> Option<String> {
    if kind == "seat" {
        return Some("seat".into());
    }
    let raw = fields
        .get(if kind == "credits" {
            "reset_period"
        } else {
            "period_scope"
        })?
        .as_str()?;
    match raw {
        "billing_period" | "per_billing_period" => match billing {
            Some("monthly") => Some("month".into()),
            Some("annual") => Some("year".into()),
            _ => None,
        },
        "" => None,
        "per_6_hours" | "six_hours" => Some("six_hours".into()),
        _ => Some(raw.strip_prefix("per_").unwrap_or(raw).into()),
    }
}

/// One immutable rule plus the kind derived from its parent entitlement.
#[derive(Clone)]
pub struct AllowanceRule {
    pub id: String,
    pub kind: String,
    pub fields: Value,
    pub source: Value,
}

/// An owned holding after rule selection.
pub struct PurchasedContribution {
    pub rule: AllowanceRule,
    pub quantity: f64,
    pub billing_period: Option<String>,
}

/// An aggregate keeps policy separate from the computed allowance.
pub struct PurchasedAggregate {
    pub rule: AllowanceRule,
    pub effective_allowance: Option<f64>,
    pub contributing_rule_handles: Option<Vec<String>>,
}

/// Reject mismatched measurement scopes or reset periods.
pub fn assert_compatible_allowances(
    a: &AllowanceRule,
    b: &AllowanceRule,
    a_billing: Option<&str>,
    b_billing: Option<&str>,
) -> Result<(), String> {
    let period = allowance_period(&a.kind, &a.fields, a_billing);
    let compatible = a.kind == b.kind
        && period.is_some()
        && period == allowance_period(&b.kind, &b.fields, b_billing)
        && [
            ("allocation", "account"),
            ("instance", ""),
            ("seat_type_id", ""),
        ]
        .iter()
        .all(|(field, default)| {
            let fallback = json!(default);
            a.fields
                .get(field)
                .filter(|v| !v.is_null())
                .unwrap_or(&fallback)
                == b.fields
                    .get(field)
                    .filter(|v| !v.is_null())
                    .unwrap_or(&fallback)
        });
    if compatible {
        Ok(())
    } else {
        Err(format!(
            "Incompatible purchased allowances: {} and {} require matching periods and scopes",
            a.id, b.id
        ))
    }
}

/// The numeric field for an additive kind.
pub fn allowance_field(kind: &str) -> Option<&'static str> {
    match kind {
        "seat" => Some("included_count"),
        "credits" => Some("allowance_value"),
        "usage_limit" | "limit" => Some("limit_value"),
        _ => None,
    }
}

/// Maximum ordinary allowance plus one selected grant per owned holding.
pub fn aggregate_purchased_allowance(
    baseline: Option<AllowanceRule>,
    purchases: Vec<PurchasedContribution>,
    billing: Option<&str>,
) -> Result<Option<PurchasedAggregate>, String> {
    let Some(anchor) = baseline
        .as_ref()
        .or_else(|| purchases.first().map(|p| &p.rule))
    else {
        return Ok(None);
    };
    let Some(field) = allowance_field(&anchor.kind).filter(|_| !purchases.is_empty()) else {
        return Ok(Some(PurchasedAggregate {
            rule: anchor.clone(),
            effective_allowance: None,
            contributing_rule_handles: None,
        }));
    };
    let recurring: Vec<_> = purchases
        .into_iter()
        .filter(|p| p.rule.kind != "credits" || p.rule.fields.get("reset_period").is_some())
        .collect();
    if recurring.is_empty() {
        return Ok(baseline.map(|rule| PurchasedAggregate {
            rule,
            effective_allowance: None,
            contributing_rule_handles: None,
        }));
    }
    let policy = baseline.as_ref().unwrap_or(&recurring[0].rule);
    let period = if baseline.is_some() {
        billing
    } else {
        recurring[0].billing_period.as_deref()
    };
    let value_of = |rule: &AllowanceRule| -> Result<f64, String> {
        let raw = rule.fields.get(field).or_else(|| {
            if field == "allowance_value" {
                rule.fields.get("allowance")
            } else {
                None
            }
        });
        resolve_limit_value(raw)
            .filter(|v| *v >= 0.0)
            .ok_or_else(|| format!("Invalid allowance: {}", rule.id))
    };
    let mut total = baseline.as_ref().map(value_of).transpose()?.unwrap_or(0.0);
    let mut handles = baseline
        .as_ref()
        .map(|b| vec![b.id.clone()])
        .unwrap_or_default();
    for purchase in &recurring {
        assert_compatible_allowances(
            policy,
            &purchase.rule,
            period,
            purchase.billing_period.as_deref(),
        )?;
        let value = value_of(&purchase.rule)?;
        let contribution = value * purchase.quantity;
        if value.is_finite() && (!contribution.is_finite() || contribution > MAX_SAFE_INTEGER) {
            return Err(format!(
                "Purchased allowance overflow: {}",
                purchase.rule.id
            ));
        }
        total += contribution;
        if total.is_finite() && total > MAX_SAFE_INTEGER {
            return Err("Purchased allowance overflow".into());
        }
        if !handles.contains(&purchase.rule.id) {
            handles.push(purchase.rule.id.clone());
        }
    }
    Ok(Some(PurchasedAggregate {
        rule: policy.clone(),
        effective_allowance: Some(total),
        contributing_rule_handles: Some(handles),
    }))
}
