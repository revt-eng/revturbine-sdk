//! Hash helpers — the runtime-free FNV-1a fallback and its base64url encoding.
//!
//! Used for placement-ID generation and decision-cache fingerprinting. **Not**
//! cryptographically secure; it exists so a deterministic fingerprint is
//! available in environments with no crypto runtime.
//!
//! The fallback hash must be **bit-identical** to the TypeScript
//! implementation: a Rust service and a TypeScript frontend derive cache keys
//! from it, so a divergence silently splits the cache rather than failing.
//! That makes this one of the few places where a faithful port means
//! reproducing JavaScript's arithmetic *quirks*, not its intent.
//!
//! Source: revturbine-scaffold/src/core/crypto.ts:24-47. Mirrors
//! `server-python/src/revturbine/core/crypto.py`.

use base64::Engine as _;

use crate::js_num::{to_int32, to_uint32};

/// Standard base64 with URL-safe substitutions and stripped padding.
///
/// Mirrors the TS `btoa(...).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')`,
/// which is exactly the `URL_SAFE_NO_PAD` alphabet.
///
/// Source: crypto.ts:24-33
#[must_use]
pub fn base64_url_from_bytes(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

/// FNV-1a-derived 8-byte hash → URL-safe base64. NOT cryptographically secure.
///
/// # Why the accumulator is `f64`
///
/// The TypeScript reads:
///
/// ```js
/// let hash = 2166136261;
/// for (...) {
///   hash ^= input.charCodeAt(index);
///   hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
/// }
/// view.setUint32(0, hash >>> 0);
/// view.setUint32(4, (hash * 1103515245) >>> 0);
/// ```
///
/// `hash` is a JS `Number` — an `f64`. Each `^` and `<<` coerces through
/// `ToInt32` and yields an `i32`, but the `+=` does **not** wrap: it
/// accumulates in the float. Between iterations `hash` therefore holds a value
/// that exceeds `i32` before the next `^` truncates it back.
///
/// The accumulator itself stays under 2⁵³ (each round re-truncates to `i32`,
/// so the running value is bounded by roughly 2³⁴), which means an `i64` would
/// in fact be exact *there*. The trap is the **final multiply**:
/// `hash * 1103515245` reaches ~2⁶³, and JavaScript computes it as a **lossy**
/// `f64` before `>>> 0` takes the low 32 bits. Doing that product exactly — in
/// `i64`, `i128`, or with wrapping arithmetic — produces *different* low bits
/// than JavaScript and silently breaks the hash.
///
/// Modelling `hash` as `f64` end to end makes both behaviours fall out for
/// free, which is why this reads unidiomatically on purpose.
///
/// # Why UTF-16
///
/// `charCodeAt` yields UTF-16 **code units**, so an astral character
/// contributes its two surrogate halves separately. [`str::encode_utf16`] is
/// the exact equivalent — iterating `chars()` (Unicode scalar values) would
/// diverge on any non-BMP input.
///
/// Source: crypto.ts:35-47
#[must_use]
pub fn fallback_hash_base64url(input: &str) -> String {
    // JS: `let hash = 2166136261;` — a Number greater than i32::MAX.
    let mut hash: f64 = 2_166_136_261.0;

    for code in input.encode_utf16() {
        // `hash ^= code` — ToInt32 both sides, XOR, result i32.
        let h = to_int32(hash) ^ i32::from(code);

        // `(h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24)` — each shift is a
        // 32-bit op (ToInt32 in, ToInt32 out); the SUM is a JS double and does
        // not wrap. `wrapping_shl` reproduces the per-shift truncation; the
        // widening to f64 reproduces the non-wrapping addition.
        let total = f64::from(h.wrapping_shl(1))
            + f64::from(h.wrapping_shl(4))
            + f64::from(h.wrapping_shl(7))
            + f64::from(h.wrapping_shl(8))
            + f64::from(h.wrapping_shl(24));

        hash = f64::from(h) + total;
    }

    let mut buffer = [0u8; 8];

    // `view.setUint32(0, hash >>> 0)` — ToUint32 of the accumulator.
    let lo = to_uint32(hash);

    // `view.setUint32(4, (hash * 1103515245) >>> 0)` — the product overflows
    // 2^53, so JS computes a LOSSY f64 and then takes its low 32 bits. The
    // multiply must therefore happen in f64; an exact integer product here
    // would produce different bits. See the section above.
    let hi = to_uint32(hash * 1_103_515_245.0);

    // DataView.setUint32 is big-endian by default.
    buffer[0..4].copy_from_slice(&lo.to_be_bytes());
    buffer[4..8].copy_from_slice(&hi.to_be_bytes());

    base64_url_from_bytes(&buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **Plan-34 REQ-7 audit edge #5 — the FNV-1a golden vector.**
    ///
    /// Ported verbatim from
    /// `server-python/tests/test_crypto.py::TestFallbackHashGoldenCorpus`.
    /// These expected values were captured from the *TypeScript*
    /// `fallbackHashBase64Url` via node, so a passing assertion here **is**
    /// TS↔Rust byte parity for the fallback hash — it is not a Rust-authored
    /// snapshot of Rust's own behaviour.
    ///
    /// The hash does not appear on the headless decision output (it feeds the
    /// decision-cache key), so a golden vector is the right instrument rather
    /// than a parity-corpus fixture.
    const GOLDEN: &[(&str, &str)] = &[
        ("", "gRydxbyfMgA"),
        ("a", "5AwpLNHA8AA"),
        ("abc", "GkfpCyMhlAA"),
        ("hello world", "1Ys_p_vY_AA"),
        ("tenant_1:pl_x:user_42", "Uy6TyjQYegA"),
        (r#"{"a":1,"b":[2,3]}"#, "LFcb5OHuWAA"),
        ("éèê", "jdCeamITvwA"),
        ("::::", "c2q6pentvgA"),
        (
            "slot_banner::banner::feat_export::pro::placement_handle",
            "YV_-Qh5jXgA",
        ),
    ];

    #[test]
    fn matches_the_typescript_golden_corpus() {
        for (input, expected) in GOLDEN {
            assert_eq!(
                &fallback_hash_base64url(input),
                expected,
                "FNV-1a diverged from the TS golden for {input:?}",
            );
        }
    }

    #[test]
    fn matches_golden_for_long_repeated_input() {
        // The corpus' `"0123456789" * 10` case — exercises many accumulator
        // rounds, where a wrapping-vs-float mistake compounds.
        let input = "0123456789".repeat(10);
        assert_eq!(fallback_hash_base64url(&input), "k_-G3UrRwgA");
    }

    #[test]
    fn is_deterministic() {
        assert_eq!(
            fallback_hash_base64url("repeat"),
            fallback_hash_base64url("repeat")
        );
    }

    #[test]
    fn distinct_inputs_give_distinct_hashes() {
        assert_ne!(
            fallback_hash_base64url("aaa"),
            fallback_hash_base64url("aab")
        );
    }

    #[test]
    fn output_is_url_safe() {
        for (_, expected) in GOLDEN {
            assert!(!expected.contains('+'), "{expected} contains '+'");
            assert!(!expected.contains('/'), "{expected} contains '/'");
            assert!(!expected.contains('='), "{expected} contains '='");
        }
    }

    /// The same FNV-1a loop, but fed Unicode **scalar values** instead of
    /// UTF-16 code units — i.e. the natural Rust translation of the TS,
    /// iterating `chars()` where JS iterates `charCodeAt`.
    ///
    /// Exists solely to be compared against and found different. Keeping the
    /// wrong implementation next to the right one is what makes the test below
    /// discriminating rather than tautological.
    fn hash_by_scalar_values(input: &str) -> String {
        let mut hash: f64 = 2_166_136_261.0;
        for ch in input.chars() {
            let h = to_int32(hash) ^ (ch as u32 as i32);
            let total = f64::from(h.wrapping_shl(1))
                + f64::from(h.wrapping_shl(4))
                + f64::from(h.wrapping_shl(7))
                + f64::from(h.wrapping_shl(8))
                + f64::from(h.wrapping_shl(24));
            hash = f64::from(h) + total;
        }
        let mut buffer = [0u8; 8];
        buffer[0..4].copy_from_slice(&to_uint32(hash).to_be_bytes());
        buffer[4..8].copy_from_slice(&to_uint32(hash * 1_103_515_245.0).to_be_bytes());
        base64_url_from_bytes(&buffer)
    }

    #[test]
    fn hashes_utf16_code_units_not_scalar_values() {
        // An astral character is ONE scalar value but TWO UTF-16 code units,
        // so the two iteration strategies genuinely disagree there. The golden
        // corpus is all BMP and cannot catch this, which is exactly why it
        // needs its own assertion.
        let astral = "\u{1F600}"; // U+1F600 GRINNING FACE
        assert_eq!(astral.chars().count(), 1);
        assert_eq!(astral.encode_utf16().count(), 2);

        assert_ne!(
            fallback_hash_base64url(astral),
            hash_by_scalar_values(astral),
            "code-unit and scalar-value iteration must differ on astral input — \
             if these ever match, this test has stopped proving anything",
        );

        // ...and the two agree across the BMP, which is why every golden
        // vector passes either way and none of them pin this behaviour.
        for (input, _) in GOLDEN {
            assert_eq!(
                fallback_hash_base64url(input),
                hash_by_scalar_values(input),
                "BMP input {input:?} should be identical under both strategies",
            );
        }
    }

    #[test]
    fn base64_url_from_bytes_is_url_safe_and_unpadded() {
        // 0xFB 0xFF exercises both '+' -> '-' and '/' -> '_' substitutions.
        assert_eq!(base64_url_from_bytes(&[0xFB, 0xFF]), "-_8");
        assert_eq!(base64_url_from_bytes(&[]), "");
    }
}
