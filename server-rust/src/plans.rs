//! Pure plan and add-on variation eligibility, plus the display-price
//! formatter that renders their minor-unit amounts (plan 161).
//!
//! The catalog counterpart of the entitlement evaluator: given the Playbook's
//! `plans` / `plan_variations` (or `addons` / `addon_variations`) arrays and a
//! user's pre-resolved segment ids, return the **public, segment-eligible**
//! variations in a deterministic order. Segment matching goes through the one
//! shared [`matches_rule_segments`] algorithm (intra-dimension OR,
//! cross-dimension AND), and a segment-specific variation always wins over the
//! default one for the same entity.
//!
//! Source (canonical): `@revt-eng/core` `src/plans/controllers/eligibility.ts`
//! (`getEligiblePlans` / `getEligibleAddons`) and `web-sdk/customer-side.ts`
//! (`formatCurrencyMinorUnits`); mirrored from the Python port's
//! `revturbine/core/plans.py`.
//!
//! Parity: fixture `tests/parity/fixtures/catalog_variation_eligibility.json`
//! drives all three of these through every port and byte-diffs the output.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

use crate::entitlements::segment_matching::matches_rule_segments;

/// Currency symbols the deterministic formatter renders for `en-US`.
///
/// Deliberately a fixed table rather than a locale database: the port must
/// agree byte-for-byte with the TypeScript `Intl.NumberFormat` output for the
/// currencies the fixture corpus covers, and an ICU dependency would make that
/// agreement depend on the host's ICU version.
const CURRENCY_SYMBOLS: [(&str, &str); 5] = [
    ("usd", "$"),
    ("eur", "€"),
    ("gbp", "£"),
    ("jpy", "¥"),
    ("krw", "₩"),
];

/// Currencies whose minor unit *is* the major unit, so they render no decimals.
const ZERO_DECIMAL_CURRENCIES: [&str; 2] = ["jpy", "krw"];

/// The locale the formatter renders symbol-first; everything else falls back to
/// the `CODE 1,234.56` form.
const DEFAULT_LOCALE: &str = "en-US";

/// The non-authoritative display price carried by one eligible variation.
///
/// Values are copied verbatim from the Playbook variation record — this type
/// transports them, it never re-derives or re-rounds them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EligiblePrice {
    /// Amount in the currency's **minor** units (cents for `usd`).
    pub price: Value,
    /// ISO-4217 code, lower-cased as the Playbook stores it.
    pub currency: Value,
    /// `flat` / `per_unit` / `tiered` / `metered`.
    pub pricing_model: Value,
    /// `monthly` / `annual` / `one_time` / `custom`.
    pub billing_period: Value,
}

/// One eligible plan variation with its plan metadata and display price.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EligiblePlan {
    /// The plan's `unique_handle`.
    pub handle: String,
    /// The plan's display name.
    pub name: Value,
    /// Position in the plan ladder; the primary sort key.
    pub tier_position: Value,
    /// Authored ordering within a tier; the secondary sort key.
    pub sort_order: Value,
    /// The winning variation's own handle.
    pub variation_handle: String,
    /// The segment this variation is scoped to, or `null` for the default one.
    pub segment_handle: Option<String>,
    /// The variation's display price.
    pub price: EligiblePrice,
}

/// One eligible add-on variation with its add-on metadata and display price.
///
/// Identical to [`EligiblePlan`] minus `tier_position` — add-ons are not a
/// ladder, so they sort on `sort_order` alone.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EligibleAddon {
    /// The add-on's `unique_handle`.
    pub handle: String,
    /// The add-on's display name.
    pub name: Value,
    /// Authored ordering; the primary sort key.
    pub sort_order: Value,
    /// The winning variation's own handle.
    pub variation_handle: String,
    /// The segment this variation is scoped to, or `null` for the default one.
    pub segment_handle: Option<String>,
    /// The variation's display price.
    pub price: EligiblePrice,
}

fn str_field<'a>(record: &'a Value, key: &str) -> Option<&'a str> {
    record.get(key).and_then(Value::as_str)
}

fn field(record: &Value, key: &str) -> Value {
    record.get(key).cloned().unwrap_or(Value::Null)
}

/// A sort key read off an already-extracted field. A non-numeric or absent
/// value sorts as `0`, mirroring the Python port's `.get(key, 0)` reads.
fn number_key(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

/// Public, segment-matching variations for one entity, with specific-over-default
/// precedence: if ANY segment-scoped variation matches, the unscoped default is
/// dropped entirely.
fn matching_variations<'a>(
    variations: impl Iterator<Item = &'a Value>,
    segment_ids: &HashSet<String>,
    segment_dimensions: &HashMap<String, String>,
) -> Vec<&'a Value> {
    let matching: Vec<&Value> = variations
        .filter(|variation| str_field(variation, "visibility") == Some("public"))
        .filter(|variation| {
            let scope: Vec<String> = str_field(variation, "segment_handle")
                .map(|handle| vec![handle.to_string()])
                .unwrap_or_default();
            matches_rule_segments(Some(&scope), segment_ids, segment_dimensions)
        })
        .collect();
    let specific: Vec<&Value> = matching
        .iter()
        .copied()
        .filter(|variation| str_field(variation, "segment_handle").is_some())
        .collect();
    if specific.is_empty() {
        matching
            .into_iter()
            .filter(|variation| str_field(variation, "segment_handle").is_none())
            .collect()
    } else {
        specific
    }
}

fn price_of(variation: &Value) -> EligiblePrice {
    EligiblePrice {
        price: field(variation, "price_amount"),
        currency: field(variation, "currency"),
        pricing_model: field(variation, "pricing_model"),
        billing_period: field(variation, "billing_period"),
    }
}

fn eligibility_inputs(
    segment_ids: &[String],
    segment_dimensions: &HashMap<String, String>,
) -> (HashSet<String>, HashMap<String, String>) {
    (
        segment_ids.iter().cloned().collect(),
        segment_dimensions.clone(),
    )
}

/// Return the public, segment-eligible **plan** variations, deterministically
/// ordered by `(tier_position, sort_order, handle, variation_handle)`.
///
/// `segment_dimensions` maps a segment handle to its dimension id; a handle
/// absent from it is treated as undimensioned (flat OR), exactly as the
/// entitlement path treats it.
///
/// Source: eligibility.ts `getEligiblePlans`; Python
/// `revturbine/core/plans.py` `get_eligible_plans`.
/// Parity: `tests/parity/fixtures/catalog_variation_eligibility.json`.
#[must_use]
pub fn get_eligible_plans(
    plans: &[Value],
    variations: &[Value],
    segment_ids: &[String],
    segment_dimensions: &HashMap<String, String>,
) -> Vec<EligiblePlan> {
    let (context_ids, dimensions) = eligibility_inputs(segment_ids, segment_dimensions);
    let mut result: Vec<EligiblePlan> = Vec::new();

    for plan in plans
        .iter()
        .filter(|plan| str_field(plan, "visibility") == Some("public"))
    {
        let handle = str_field(plan, "unique_handle").unwrap_or_default();
        let candidates = variations
            .iter()
            .filter(|variation| str_field(variation, "plan_handle") == Some(handle));
        for variation in matching_variations(candidates, &context_ids, &dimensions) {
            result.push(EligiblePlan {
                handle: handle.to_string(),
                name: field(plan, "name"),
                tier_position: field(plan, "tier_position"),
                sort_order: field(plan, "sort_order"),
                variation_handle: str_field(variation, "handle")
                    .unwrap_or_default()
                    .to_string(),
                segment_handle: str_field(variation, "segment_handle").map(str::to_string),
                price: price_of(variation),
            });
        }
    }

    result.sort_by(|left, right| {
        number_key(&left.tier_position)
            .total_cmp(&number_key(&right.tier_position))
            .then_with(|| number_key(&left.sort_order).total_cmp(&number_key(&right.sort_order)))
            .then_with(|| left.handle.cmp(&right.handle))
            .then_with(|| left.variation_handle.cmp(&right.variation_handle))
    });
    result
}

/// Return the public, segment-eligible **add-on** variations, deterministically
/// ordered by `(sort_order, handle, variation_handle)`.
///
/// The add-on twin of [`get_eligible_plans`] — same visibility filter, same
/// specific-over-default precedence, no tier ladder.
///
/// Source: eligibility.ts `getEligibleAddons`; Python
/// `revturbine/core/plans.py` `get_eligible_addons`.
/// Parity: `tests/parity/fixtures/catalog_variation_eligibility.json`.
#[must_use]
pub fn get_eligible_addons(
    addons: &[Value],
    variations: &[Value],
    segment_ids: &[String],
    segment_dimensions: &HashMap<String, String>,
) -> Vec<EligibleAddon> {
    let (context_ids, dimensions) = eligibility_inputs(segment_ids, segment_dimensions);
    let mut result: Vec<EligibleAddon> = Vec::new();

    for addon in addons
        .iter()
        .filter(|addon| str_field(addon, "visibility") == Some("public"))
    {
        let handle = str_field(addon, "unique_handle").unwrap_or_default();
        let candidates = variations
            .iter()
            .filter(|variation| str_field(variation, "addon_handle") == Some(handle));
        for variation in matching_variations(candidates, &context_ids, &dimensions) {
            result.push(EligibleAddon {
                handle: handle.to_string(),
                name: field(addon, "name"),
                sort_order: field(addon, "sort_order"),
                variation_handle: str_field(variation, "handle")
                    .unwrap_or_default()
                    .to_string(),
                segment_handle: str_field(variation, "segment_handle").map(str::to_string),
                price: price_of(variation),
            });
        }
    }

    result.sort_by(|left, right| {
        number_key(&left.sort_order)
            .total_cmp(&number_key(&right.sort_order))
            .then_with(|| left.handle.cmp(&right.handle))
            .then_with(|| left.variation_handle.cmp(&right.variation_handle))
    });
    result
}

/// Group the integer part with `,` every three digits, the way `Intl` renders
/// `en-US` and Python's `format(x, ',')` both do.
fn group_thousands(digits: &str) -> String {
    // The leading group is the short one when the length is not a multiple of
    // three ("1" in "1,234"); every group after it is exactly three wide.
    let lead = match digits.len() % 3 {
        0 => 3.min(digits.len()),
        remainder => remainder,
    };
    let (head, rest) = digits.split_at(lead);
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    out.push_str(head);
    for chunk in rest.as_bytes().chunks(3) {
        out.push(',');
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
    }
    out
}

/// Format an integer **minor-unit** amount for Playbook-backed display tokens.
///
/// Deterministic by construction: a fixed symbol table and a fixed
/// zero-decimal set, never the host's ICU data — this is the exact
/// Number/String coercion boundary where ports silently diverge, so the corpus
/// drives it directly (`required-coverage.json` declares it).
///
/// `locale` of `None` means `en-US`. For `en-US` with a known currency the
/// output is symbol-first (`$29.00`); every other locale or currency renders
/// `USD 29.00`.
///
/// Source: `web-sdk/customer-side.ts` `formatCurrencyMinorUnits`; Python
/// `revturbine/core/plans.py` `format_currency_minor_units`.
/// Parity: `tests/parity/fixtures/catalog_variation_eligibility.json`
/// (`formatCurrencyMinorUnits` call).
#[must_use]
pub fn format_currency_minor_units(amount: i64, currency: &str, locale: Option<&str>) -> String {
    let normalized = currency.to_ascii_lowercase();
    let digits = if ZERO_DECIMAL_CURRENCIES.contains(&normalized.as_str()) {
        0
    } else {
        2
    };
    let negative = amount < 0;
    let magnitude = amount.unsigned_abs();
    let scale = 10_u64.pow(digits);
    let whole = magnitude / scale;
    let number = if digits == 0 {
        group_thousands(&whole.to_string())
    } else {
        format!(
            "{}.{:0width$}",
            group_thousands(&whole.to_string()),
            magnitude % scale,
            width = digits as usize
        )
    };
    let number = if negative {
        format!("-{number}")
    } else {
        number
    };

    let symbol = CURRENCY_SYMBOLS
        .iter()
        .find(|(code, _)| *code == normalized)
        .map(|(_, symbol)| *symbol);
    match (locale.unwrap_or(DEFAULT_LOCALE), symbol) {
        (DEFAULT_LOCALE, Some(symbol)) => format!("{symbol}{number}"),
        _ => format!("{} {number}", normalized.to_ascii_uppercase()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The parity fixture's own catalog, so the unit suite and the byte-diff
    /// assert the same shape.
    fn fixture_config() -> Value {
        json!({
            "plans": [
                { "unique_handle": "free", "name": "Free", "tier_position": 0, "sort_order": 0, "visibility": "public" },
                { "unique_handle": "pro", "name": "Pro", "tier_position": 1, "sort_order": 0, "visibility": "public" },
                { "unique_handle": "hidden", "name": "Hidden", "tier_position": 2, "sort_order": 0, "visibility": "unlisted" }
            ],
            "addons": [
                { "unique_handle": "support", "name": "Support", "sort_order": 0, "visibility": "public" }
            ],
            "plan_variations": [
                { "handle": "free_default", "plan_handle": "free", "billing_period": "monthly", "segment_handle": null, "price_amount": 0, "currency": "usd", "pricing_model": "flat", "visibility": "public" },
                { "handle": "pro_default", "plan_handle": "pro", "billing_period": "monthly", "segment_handle": null, "price_amount": 4900, "currency": "usd", "pricing_model": "flat", "visibility": "public" },
                { "handle": "pro_startup", "plan_handle": "pro", "billing_period": "monthly", "segment_handle": "startup", "price_amount": 2900, "currency": "usd", "pricing_model": "flat", "visibility": "public" },
                { "handle": "hidden_default", "plan_handle": "hidden", "billing_period": "monthly", "segment_handle": null, "price_amount": 9900, "currency": "usd", "pricing_model": "flat", "visibility": "public" }
            ],
            "addon_variations": [
                { "handle": "support_default", "addon_handle": "support", "billing_period": "monthly", "segment_handle": null, "price_amount": 1000, "currency": "usd", "pricing_model": "flat", "visibility": "public" }
            ]
        })
    }

    fn arr(config: &Value, key: &str) -> Vec<Value> {
        config
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    }

    fn dims(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(a, b)| ((*a).to_string(), (*b).to_string()))
            .collect()
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_string()).collect()
    }

    /// Mirrors `server-python`'s `test_plans.py` eligibility case: the
    /// `unlisted` plan never appears, and the startup-scoped variation
    /// SUPPRESSES `pro_default` rather than joining it.
    #[test]
    fn eligible_plans_apply_visibility_and_segment_specificity() {
        let config = fixture_config();
        let result = get_eligible_plans(
            &arr(&config, "plans"),
            &arr(&config, "plan_variations"),
            &ids(&["startup"]),
            &dims(&[("startup", "company_stage")]),
        );
        let handles: Vec<&str> = result
            .iter()
            .map(|item| item.variation_handle.as_str())
            .collect();
        assert_eq!(handles, vec!["free_default", "pro_startup"]);
        assert_eq!(result[1].price.price, json!(2900));
        assert_eq!(result[1].segment_handle.as_deref(), Some("startup"));
    }

    /// Without the segment, the default variation is the eligible one — the
    /// other half of the precedence rule.
    #[test]
    fn eligible_plans_fall_back_to_the_default_variation() {
        let config = fixture_config();
        let result = get_eligible_plans(
            &arr(&config, "plans"),
            &arr(&config, "plan_variations"),
            &[],
            &HashMap::new(),
        );
        let handles: Vec<&str> = result
            .iter()
            .map(|item| item.variation_handle.as_str())
            .collect();
        assert_eq!(handles, vec!["free_default", "pro_default"]);
    }

    /// Add-ons carry no tier ladder; the shape is otherwise the plan shape.
    #[test]
    fn eligible_addons_return_public_variations() {
        let config = fixture_config();
        let result = get_eligible_addons(
            &arr(&config, "addons"),
            &arr(&config, "addon_variations"),
            &ids(&["startup"]),
            &dims(&[("startup", "company_stage")]),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].handle, "support");
        assert_eq!(result[0].variation_handle, "support_default");
        assert_eq!(result[0].price.price, json!(1000));
    }

    /// Cross-dimension AND reaches the catalog path too: a variation scoped to
    /// a segment the user does not carry is not eligible.
    #[test]
    fn unmatched_segment_scope_is_not_eligible() {
        let config = fixture_config();
        let result = get_eligible_plans(
            &arr(&config, "plans"),
            &arr(&config, "plan_variations"),
            &ids(&["enterprise"]),
            &dims(&[
                ("startup", "company_stage"),
                ("enterprise", "company_stage"),
            ]),
        );
        let handles: Vec<&str> = result
            .iter()
            .map(|item| item.variation_handle.as_str())
            .collect();
        assert_eq!(handles, vec!["free_default", "pro_default"]);
    }

    /// Mirrors `server-python`'s `test_plans.py` formatter cases, including the
    /// zero-decimal currencies and the non-`en-US` fallback form.
    #[test]
    fn formats_minor_units_like_the_python_port() {
        assert_eq!(
            format_currency_minor_units(2900, "usd", Some("en-US")),
            "$29.00"
        );
        assert_eq!(format_currency_minor_units(0, "usd", None), "$0.00");
        assert_eq!(
            format_currency_minor_units(123_456, "usd", None),
            "$1,234.56"
        );
        assert_eq!(format_currency_minor_units(1_500, "jpy", None), "¥1,500");
        assert_eq!(format_currency_minor_units(1_500, "krw", None), "₩1,500");
        assert_eq!(format_currency_minor_units(2900, "eur", None), "€29.00");
        assert_eq!(format_currency_minor_units(2900, "gbp", None), "£29.00");
        // Unknown currency and non-en-US locale both take the code-first form.
        assert_eq!(format_currency_minor_units(2900, "cad", None), "CAD 29.00");
        assert_eq!(
            format_currency_minor_units(2900, "usd", Some("de-DE")),
            "USD 29.00"
        );
        // Grouping runs past the first comma, and the sign rides the number.
        assert_eq!(
            format_currency_minor_units(123_456_789, "usd", None),
            "$1,234,567.89"
        );
        assert_eq!(format_currency_minor_units(-2900, "usd", None), "$-29.00");
    }
}
