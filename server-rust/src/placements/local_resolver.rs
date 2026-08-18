//! Playbook → gate input normalization, and CTA path mapping.
//!
//! The bridge between the Playbook's `type`-keyed wire format and the typed
//! trigger shapes the gating predicates consume. A placement's authored
//! trigger is one untyped JSON object; these readers turn it into whichever of
//! [`ThresholdTrigger`], [`QualifierTrigger`], [`EntitlementGateTrigger`] or
//! [`TrialTrigger`](super::TrialTrigger) applies — returning `None` for
//! "not my kind", which is exactly what each gate treats as pass-through.
//!
//! The resolver that drives these over a placement dataset
//! (`create_static_placement_resolver`) follows in the next slice.
//!
//! Source: revturbine-scaffold/src/placements/controllers/local-resolver.ts

use serde_json::{Map, Value};

use super::entitlement_gate_gating::EntitlementGateTrigger;
use super::qualifier_gating::QualifierTrigger;
use super::threshold_gating::ThresholdTrigger;

/// The threshold kinds the resolver recognizes.
const THRESHOLD_KINDS: &[&str] = &["usage_threshold", "credit_threshold", "seat_threshold"];

/// Read a trigger's `entitlement_handle`, if it carries a string one.
///
/// Source: local-resolver.ts:28-34
#[must_use]
pub fn read_entitlement_handle_from_trigger(trigger: Option<&Value>) -> Option<&str> {
    trigger?.get("entitlement_handle")?.as_str()
}

/// Read a trigger's `slot_id`, if it carries a string one.
///
/// Source: local-resolver.ts:36-42
#[must_use]
pub fn read_slot_id_from_trigger(trigger: Option<&Value>) -> Option<&str> {
    trigger?.get("slot_id")?.as_str()
}

/// Normalize a usage / credit / seat threshold trigger.
///
/// `None` unless the type is a recognized threshold kind, an entitlement
/// handle is present, and `threshold_percent` is a real number. A missing
/// percent yields `None` rather than defaulting to zero — which would make the
/// placement fire at any usage at all.
///
/// Source: local-resolver.ts readJsonThresholdTrigger
#[must_use]
pub fn read_json_threshold_trigger(
    trigger: Option<&Value>,
    entitlement_handle: Option<&str>,
) -> Option<ThresholdTrigger> {
    let t = trigger?;
    let kind = t.get("type")?.as_str()?;
    if !THRESHOLD_KINDS.contains(&kind) {
        return None;
    }
    let handle = entitlement_handle.filter(|h| !h.is_empty())?;
    // `as_f64` declines booleans, matching the TS `typeof === 'number'`.
    let threshold_percent = t.get("threshold_percent")?.as_f64()?;

    Some(ThresholdTrigger {
        kind: kind.to_string(),
        entitlement_handle: handle.to_string(),
        threshold_percent,
    })
}

/// Normalize a qualifier trigger.
///
/// Source: local-resolver.ts readJsonQualifierTrigger
#[must_use]
pub fn read_json_qualifier_trigger(trigger: Option<&Value>) -> Option<QualifierTrigger> {
    let t = trigger?;
    if t.get("type")?.as_str()? != "qualifier" {
        return None;
    }
    let qualifier = t.get("qualifier")?.as_str().filter(|q| !q.is_empty())?;
    Some(QualifierTrigger {
        qualifier: qualifier.to_string(),
    })
}

/// Normalize an `entitlement_gate` trigger.
///
/// A blank or absent `tier_threshold` yields a **non-tier** gate
/// (`tier_threshold: None`), which passes through rather than failing closed —
/// such a gate is governed by entitlement status, not by tier.
///
/// Source: local-resolver.ts readJsonEntitlementGateTrigger
#[must_use]
pub fn read_json_entitlement_gate_trigger(
    trigger: Option<&Value>,
    entitlement_handle: Option<&str>,
) -> Option<EntitlementGateTrigger> {
    let t = trigger?;
    if t.get("type")?.as_str()? != "entitlement_gate" {
        return None;
    }
    let handle = entitlement_handle.filter(|h| !h.is_empty())?;
    let tier_threshold = t
        .get("tier_threshold")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    Some(EntitlementGateTrigger {
        entitlement_handle: handle.to_string(),
        tier_threshold,
    })
}

/// Map a raw CTA `{path, config}` to the resolved `cta_path` shape.
///
/// `plan_handle` / `placement_handle` are **omitted** — not set to null — when
/// the source config field is not a string. That mirrors `JSON.stringify`
/// dropping `undefined` properties, and the parity contract treats an absent
/// key and an explicit null as different output.
///
/// An unmapped action passes its authored name through as `type` and spreads
/// its config, so a custom CTA's params reach the SDK resolver intact.
///
/// Source: local-resolver.ts:81-118
#[must_use]
pub fn normalize_cta_path(cta: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();

    let raw_path = cta
        .and_then(|c| c.get("path"))
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty());

    let Some(raw_path) = raw_path else {
        // No CTA, or one with no path — nothing to navigate to.
        out.insert("type".into(), Value::String("dismiss".into()));
        return out;
    };

    let empty = Map::new();
    let config = cta
        .and_then(|c| c.get("config"))
        .and_then(Value::as_object)
        .unwrap_or(&empty);

    match raw_path {
        "open_checkout" => {
            out.insert("type".into(), Value::String("open_checkout_modal".into()));
            if let Some(p) = config.get("purchase").and_then(Value::as_str) {
                out.insert("plan_handle".into(), Value::String(p.to_string()));
            }
        }
        "view_plans" => {
            out.insert("type".into(), Value::String("navigate_to_plans".into()));
        }
        "open_rt_placement" => {
            out.insert("type".into(), Value::String("open_rt_placement".into()));
            if let Some(h) = config.get("placement_handle").and_then(Value::as_str) {
                out.insert("placement_handle".into(), Value::String(h.to_string()));
            }
        }
        custom => {
            out.insert("type".into(), Value::String(custom.to_string()));
            for (k, v) in config {
                out.insert(k.clone(), v.clone());
            }
        }
    }

    out
}

/// Header / body / CTA mirrored across the legacy and canonical spellings.
///
/// Both namings are emitted deliberately — `title` mirrors `header` and `cta`
/// mirrors `cta_label` — because consumers exist for each, and dropping either
/// would break one of them.
#[must_use]
pub fn decision_content(header: &str, body: &str, cta_label: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("header".into(), Value::String(header.to_string()));
    m.insert("body".into(), Value::String(body.to_string()));
    m.insert("cta_label".into(), Value::String(cta_label.to_string()));
    m.insert("title".into(), Value::String(header.to_string()));
    m.insert("cta".into(), Value::String(cta_label.to_string()));
    m
}

/// Coerce a non-string to `""`, matching the TS `headerStr`.
#[must_use]
pub fn header_str(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map_or_else(String::new, str::to_string)
}

/// JS `Number.isFinite` — true only for finite real numbers. No string
/// coercion, and booleans excluded.
#[must_use]
pub fn is_finite_number(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(f64::is_finite)
}
