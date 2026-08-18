//! Canonical JSON (RFC 8785 / JCS) — Rust port of the TS canonicalizer.
//!
//! Source: revturbine-scaffold/src/core/bundle/signing.ts
//! Mirrors: server-python/src/revturbine/core/canonical_json.py
//!
//! Plan 177 makes canonical JSON the Playbook payload format, so the sha256 of
//! this output is the **content address** every runtime verifies against. That
//! makes byte-for-byte agreement with TypeScript a correctness requirement, not
//! a nicety: if two ports disagree on a single character, the same Playbook
//! yields two different addresses and integrity checks fail intermittently on
//! data-dependent input — the worst failure shape, because whether it bites
//! depends on whether a tenant happens to price something at 9.99 or 10.
//!
//! Two Rust-specific traps, both of which the obvious code walks straight into:
//!
//! 1. **`f64::to_string` never uses scientific notation.** `1e21.to_string()`
//!    yields twenty-two digits where JS yields `1e+21`, and `1e300` yields a
//!    301-character string. There is no formatting flag that produces the JS
//!    layout, so [`js_number_to_string`] implements ECMAScript
//!    `Number::toString` (ECMA-262 §6.1.6.1.20) directly — which is what RFC
//!    8785 §3.2.2.3 defines number serialization to be.
//!
//! 2. **Rust sorts `str` by Unicode scalar value; RFC 8785 §3.2.3 sorts by
//!    UTF-16 code unit.** The two disagree for astral characters: U+1F600
//!    encodes to the surrogate pair 0xD83D 0xDE00, so it sorts *before*
//!    U+FF21 in UTF-16 but *after* it by scalar value. [`str::encode_utf16`]
//!    recovers JS order, the same primitive `crypto.rs` already uses for
//!    `charCodeAt` semantics.
//!
//! Follows the numeric-fidelity discipline set by `js_num.rs` and `crypto.rs`.

use std::cmp::Ordering;

use serde_json::Value;

use crate::js_num::is_integral;

/// Error returned for values JSON cannot represent losslessly.
///
/// Canonicalization fails loudly rather than coercing. A silent coercion is
/// worse than an error here: it yields a stable-looking hash over the wrong
/// bytes, which no downstream check can detect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalJsonError(pub String);

impl std::fmt::Display for CanonicalJsonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "canonical_json: {}", self.0)
    }
}

impl std::error::Error for CanonicalJsonError {}

type Result<T> = std::result::Result<T, CanonicalJsonError>;

/// Largest integer an `f64` represents exactly (2^53).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_992.0;

/// ECMAScript `Number::toString` for a finite double.
///
/// RFC 8785 §3.2.2.3 defines JSON number serialization as exactly this
/// algorithm, so this is the canonical form rather than an approximation.
///
/// The spec picks integers `s`, `k`, `n` where `k` is the digit count of `s`,
/// `s` carries no trailing zero, and `s * 10^(n - k) == value` with `k`
/// minimal. Rust's `{:e}` formatting already yields the shortest
/// round-tripping mantissa, so `s` and `n` are recovered from it and the
/// spec's five layout cases do the rest.
///
/// # Errors
/// Returns an error for `NaN` and the infinities, which JSON cannot express.
pub fn js_number_to_string(value: f64) -> Result<String> {
    if !value.is_finite() {
        return Err(CanonicalJsonError(format!(
            "{value} is not representable in JSON"
        )));
    }

    // Covers both +0.0 and -0.0 — the spec normalizes negative zero to "0".
    if value == 0.0 {
        return Ok("0".to_string());
    }

    if value < 0.0 {
        return Ok(format!("-{}", js_number_to_string(-value)?));
    }

    // Integral values inside the exactly-representable range format as plain
    // integers. Handles the common case (limits, counts, percentages) without
    // touching the exponent machinery, and guarantees "1" rather than "1.0".
    if is_integral(value) && value < MAX_SAFE_INTEGER {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        return Ok((value as u64).to_string());
    }

    // `{:e}` gives "<mantissa>e<exp>" with the shortest round-tripping
    // mantissa, e.g. 0.30000000000000004 -> "3.0000000000000004e-1".
    let formatted = format!("{value:e}");
    let (mantissa, exp_str) = formatted
        .split_once('e')
        .ok_or_else(|| CanonicalJsonError(format!("unexpected float formatting for {value}")))?;
    let exp: i32 = exp_str
        .parse()
        .map_err(|_| CanonicalJsonError(format!("unparseable exponent in {formatted}")))?;

    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let s = digits.trim_end_matches('0');
    let s = if s.is_empty() { "0" } else { s };
    let k =
        i32::try_from(s.len()).map_err(|_| CanonicalJsonError("mantissa too long".to_string()))?;

    // `{:e}` normalizes to one digit before the point, so value = s * 10^(exp - (k-1)),
    // and the spec's s * 10^(n-k) gives n = exp + 1.
    let n = exp + 1;

    Ok(if k <= n && n <= 21 {
        // Integer with trailing zeros.
        let mut out = String::from(s);
        out.push_str(&"0".repeat(usize::try_from(n - k).unwrap_or(0)));
        out
    } else if 0 < n && n <= 21 {
        // Decimal point inside the digits.
        let split = usize::try_from(n).unwrap_or(0);
        format!("{}.{}", &s[..split], &s[split..])
    } else if -6 < n && n <= 0 {
        // Leading "0." plus padding zeros.
        format!("0.{}{}", "0".repeat(usize::try_from(-n).unwrap_or(0)), s)
    } else {
        // Exponent form. Positive exponents carry an explicit "+".
        let e = n - 1;
        let mantissa = if k == 1 {
            s.to_string()
        } else {
            format!("{}.{}", &s[..1], &s[1..])
        };
        let sign = if e >= 0 { "+" } else { "-" };
        format!("{mantissa}e{sign}{}", e.abs())
    })
}

/// Compare two strings by UTF-16 code unit, reproducing JS string ordering.
///
/// Rust's `Ord for str` compares Unicode scalar values, which disagrees with
/// UTF-16 order for astral characters. RFC 8785 §3.2.3 requires the latter.
fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn encode_string(value: &str, out: &mut String) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{9}' => out.push_str("\\t"),
            '\u{a}' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\u{d}' => out.push_str("\\r"),
            // Remaining C0 controls have no short escape; lowercase hex,
            // matching JS. Uppercase would hash differently.
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            // Everything else literal — including "/" and DEL, which JS does
            // not escape, and all non-ASCII. A Rust `str` cannot hold a lone
            // surrogate, so the escape branch Python and TS need is
            // unreachable here.
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Serialize `value` to canonical JSON (RFC 8785).
///
/// # Errors
/// Returns an error for non-finite numbers and for integers outside the
/// exactly-representable `f64` range, which cannot round-trip through a JS
/// number — the two languages must refuse rather than disagree.
pub fn canonicalize_json(value: &Value) -> Result<String> {
    let mut out = String::new();
    write_value(value, &mut out)?;
    Ok(out)
}

fn write_value(value: &Value, out: &mut String) -> Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::String(s) => encode_string(s, out),
        Value::Number(n) => {
            let f = n.as_f64().ok_or_else(|| {
                CanonicalJsonError(format!("number {n} is not representable as f64"))
            })?;
            // serde_json parses integers exactly, so an integer that a double
            // cannot hold would serialize differently here than in JS. The
            // test is EXACT ROUND-TRIP, not magnitude: 10^20 sits far past
            // 2^53 yet is exactly representable, so refusing it would diverge
            // from TS on a document TS handles fine, while 2^53 + 1 is smaller
            // and must be refused. Integers too large for i64/u64 were already
            // parsed as f64 by serde_json — the same precision loss JS takes —
            // so they need no check.
            #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
            {
                if let Some(i) = n.as_i64() {
                    if (i as f64) as i64 != i {
                        return Err(CanonicalJsonError(format!(
                            "integer {i} cannot round-trip through a JS number without loss"
                        )));
                    }
                } else if let Some(u) = n.as_u64() {
                    if (u as f64) as u64 != u {
                        return Err(CanonicalJsonError(format!(
                            "integer {u} cannot round-trip through a JS number without loss"
                        )));
                    }
                }
            }
            out.push_str(&js_number_to_string(f)?);
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| utf16_cmp(a, b));
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                encode_string(key, out);
                out.push(':');
                write_value(&map[*key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// RFC 8785 conformance vectors — the cross-language contract.
    ///
    /// Mirrors the TS `it.each` table in scaffold's `manifest.test.ts` and the
    /// Python `TestNumberConformance` table case for case. Every entry is a
    /// case where a naive port produces a *different* string; keep all three
    /// in lockstep.
    #[test]
    fn number_conformance_vectors() {
        let cases: &[(f64, &str, &str)] = &[
            (0.0, "0", "plain zero"),
            (-0.0, "0", "negative zero normalizes to 0"),
            (1.0, "1", "integral double drops the fraction"),
            (-1.0, "-1", "negative integral double"),
            (1.5, "1.5", "simple fraction"),
            (9.99, "9.99", "a real price"),
            (0.1 + 0.2, "0.30000000000000004", "shortest round-trip"),
            (1e21, "1e+21", "exponent threshold with + sign"),
            (1e-7, "1e-7", "small-exponent threshold"),
            (
                1e-6,
                "0.000001",
                "just above the threshold stays positional",
            ),
            (1e20, "100000000000000000000", "just below stays positional"),
            (9_007_199_254_740_992.0, "9007199254740992", "2^53"),
            (-9.99, "-9.99", "negative price"),
            (100.0, "100", "percentage bound"),
        ];
        for (input, expected, trap) in cases {
            assert_eq!(
                js_number_to_string(*input).unwrap(),
                *expected,
                "{trap} (input {input})"
            );
        }
    }

    #[test]
    fn rejects_non_finite() {
        assert!(js_number_to_string(f64::NAN).is_err());
        assert!(js_number_to_string(f64::INFINITY).is_err());
        assert!(js_number_to_string(f64::NEG_INFINITY).is_err());
    }

    /// The criterion is exact round-trip, not magnitude.
    ///
    /// Regression guard for a divergence the golden corpus caught and three
    /// hand-written test tables all missed: a magnitude bound at 2^53 rejects
    /// 10^20, which is *far* larger yet exactly representable (10^20 =
    /// 5^20 * 2^20, and 5^20 fits in 53 bits). TS serializes it losslessly, so
    /// refusing it here would be the port diverging, not protecting.
    #[test]
    fn integer_acceptance_is_round_trip_not_magnitude() {
        // Not representable: 2^53 + 1 collapses onto 2^53 as a double.
        let lossy: Value = serde_json::from_str("9007199254740993").unwrap();
        let err = canonicalize_json(&lossy).unwrap_err();
        assert!(
            err.0.contains("round-trip"),
            "unexpected message: {}",
            err.0
        );

        // Representable despite being ~11,000x larger.
        let big: Value = serde_json::from_str("100000000000000000000").unwrap();
        assert_eq!(
            canonicalize_json(&big).unwrap(),
            "100000000000000000000",
            "10^20 is exactly representable and must not be refused"
        );

        // And the boundary itself is fine.
        let boundary: Value = serde_json::from_str("9007199254740992").unwrap();
        assert_eq!(canonicalize_json(&boundary).unwrap(), "9007199254740992");
    }

    /// The divergence Rust's default `str` ordering would introduce.
    ///
    /// U+1F600 encodes to the surrogate pair 0xD83D 0xDE00, so it sorts BEFORE
    /// U+FF21 (0xFF21) in UTF-16 but AFTER it by scalar value.
    #[test]
    fn sorts_keys_by_utf16_code_unit_not_scalar_value() {
        let v = json!({ "\u{1F600}": 1, "\u{FF21}": 2 });
        assert_eq!(
            canonicalize_json(&v).unwrap(),
            "{\"\u{1F600}\":1,\"\u{FF21}\":2}"
        );

        // Prove the naive ordering really does disagree, so this fails loudly
        // if someone "simplifies" utf16_cmp to a plain sort.
        let mut naive = vec!["\u{1F600}", "\u{FF21}"];
        naive.sort_unstable();
        assert_eq!(naive, vec!["\u{FF21}", "\u{1F600}"]);
    }

    #[test]
    fn sorts_ascii_keys_by_code_unit() {
        let v = json!({ "b": 1, "A": 2, "a": 3, "B": 4 });
        assert_eq!(
            canonicalize_json(&v).unwrap(),
            r#"{"A":2,"B":4,"a":3,"b":1}"#
        );
        assert_eq!(
            canonicalize_json(&json!({ "\u{e4}": 1, "z": 2 })).unwrap(),
            "{\"z\":2,\"\u{e4}\":1}"
        );
    }

    #[test]
    fn escapes_strings_to_shortest_form() {
        assert_eq!(canonicalize_json(&json!("a\"b")).unwrap(), r#""a\"b""#);
        // Input is a literal backslash then 'b'; JSON escapes the backslash.
        assert_eq!(canonicalize_json(&json!("a\\b")).unwrap(), r#""a\\b""#);
        assert_eq!(
            canonicalize_json(&json!("\n\t\r\u{8}\u{c}")).unwrap(),
            r#""\n\t\r\b\f""#
        );
        // Controls with no short escape become lowercase \u00XX. Asserted
        // structurally rather than against a literal, so the fixture itself
        // cannot be silently broken by backslash-escaping mishaps.
        // Expect: quote + two 6-char escapes + quote = 14 chars.
        let ctrl = canonicalize_json(&json!("\u{0}\u{1f}")).unwrap();
        assert_eq!(ctrl.len(), 14, "unexpected escape length: {ctrl}");
        assert_eq!(ctrl.matches('\\').count(), 2, "{ctrl}");
        assert!(ctrl.contains("u0000") && ctrl.contains("u001f"), "{ctrl}");
        assert!(!ctrl.contains("u001F"), "hex must be lowercase: {ctrl}");
        // Forward slash and DEL are NOT escaped; non-ASCII stays literal.
        assert_eq!(canonicalize_json(&json!("/")).unwrap(), "\"/\"");
        assert_eq!(canonicalize_json(&json!("\u{7f}")).unwrap(), "\"\u{7f}\"");
        assert_eq!(
            canonicalize_json(&json!("\u{e9}\u{2603}")).unwrap(),
            "\"\u{e9}\u{2603}\""
        );
    }

    #[test]
    fn sorts_at_every_level_and_preserves_array_order() {
        assert_eq!(
            canonicalize_json(&json!({ "b": 1, "a": { "d": 2, "c": 3 } })).unwrap(),
            r#"{"a":{"c":3,"d":2},"b":1}"#
        );
        assert_eq!(canonicalize_json(&json!([3, 1, 2])).unwrap(), "[3,1,2]");
    }

    #[test]
    fn booleans_and_null_are_not_numbers() {
        assert_eq!(
            canonicalize_json(&json!({ "enabled": true, "hidden": false, "x": null })).unwrap(),
            r#"{"enabled":true,"hidden":false,"x":null}"#
        );
    }

    #[test]
    fn realistic_pricing_fragment() {
        let v = json!({
            "price_amount": 9.99,
            "soft_limit_percent": 80,
            "max_balance": null,
            "rate_value": 0.5,
        });
        assert_eq!(
            canonicalize_json(&v).unwrap(),
            r#"{"max_balance":null,"price_amount":9.99,"rate_value":0.5,"soft_limit_percent":80}"#
        );
    }

    /// Any string the formatter produces must parse back to the same double.
    /// Catches digit-layout bugs the fixed vector table would miss.
    #[test]
    fn number_output_round_trips() {
        let values = [
            0.1,
            0.2,
            0.3,
            1.0 / 3.0,
            2.0 / 3.0,
            1e-5,
            1e-4,
            123.456,
            1e15,
            1e16,
            1e19,
            f64::MAX,
            f64::MIN_POSITIVE,
            4.9,
            0.5,
            1_234_567_890.123_45,
            1e22,
            5e-324,
        ];
        for v in values {
            let s = js_number_to_string(v).unwrap();
            let parsed: f64 = s
                .parse()
                .unwrap_or_else(|e| panic!("{s} did not parse: {e}"));
            assert!(
                (parsed - v).abs() <= f64::EPSILON * v.abs(),
                "{v} -> {s} -> {parsed}"
            );
        }
    }
}
