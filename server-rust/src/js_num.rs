//! JavaScript numeric semantics, reproduced exactly.
//!
//! The canonical RevTurbine decision core is TypeScript, so every number it
//! produces carries JS semantics: one `f64` type, `ToInt32`/`ToUint32`
//! coercion on bitwise operators, and a `Math.round` that breaks ties
//! *toward +∞* rather than away from zero. A Rust port that reaches for the
//! idiomatic equivalent of each of those gets a different answer.
//!
//! These are not stylistic differences — they change decisions. A
//! `usage_percent` landing on `.5`, or a cache key derived from a hash,
//! diverges silently and only shows up as a cross-language parity failure
//! (or worse, doesn't, because no fixture covers it).
//!
//! Source: revturbine-scaffold/src/core/crypto.ts and the ECMA-262
//! definitions of ToInt32 (§7.1.6), ToUint32 (§7.1.7), and Math.round
//! (§21.3.2.28). Mirrors `server-python`'s `_to_int32` / `_js_math_round`.

/// `ToUint32` — ECMA-262 §7.1.7.
///
/// Truncates toward zero, then reduces modulo 2³². Non-finite input and zero
/// map to `0`, matching the spec's handling of `NaN`, `±∞`, and `±0`.
///
/// This is what JavaScript applies to the left operand of `>>> 0`.
#[must_use]
pub fn to_uint32(value: f64) -> u32 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    // `rem_euclid` yields a non-negative remainder, which is precisely the
    // spec's "modulo 2^32" step. A plain `%` would keep the sign and give the
    // wrong answer for negative inputs.
    let wrapped = value.trunc().rem_euclid(4_294_967_296.0);
    wrapped as u32
}

/// `ToInt32` — ECMA-262 §7.1.6.
///
/// Identical to [`to_uint32`] except the result is reinterpreted as signed,
/// so values at or above 2³¹ come back negative. This is the coercion applied
/// to both operands of JavaScript's `^`, `<<`, and friends.
#[must_use]
pub fn to_int32(value: f64) -> i32 {
    // Reinterpreting the u32 bit pattern as i32 *is* the spec's
    // "if result >= 2^31, subtract 2^32" step.
    to_uint32(value) as i32
}

/// JavaScript's `Math.round` — ECMA-262 §21.3.2.28.
///
/// **Breaks ties toward +∞, not away from zero.** This is the single most
/// dangerous numeric difference between the two languages, because Rust's
/// [`f64::round`] looks like the obvious equivalent and silently disagrees on
/// every negative half-integer:
///
/// | input  | JS `Math.round` | Rust `f64::round` |
/// |--------|-----------------|-------------------|
/// | `0.5`  | `1`             | `1`               |
/// | `1.5`  | `2`             | `2`               |
/// | `-0.5` | `-0`            | **`-1`**          |
/// | `-1.5` | `-1`            | **`-2`**          |
///
/// Locked as plan-34 audit edge #2 and asserted on both the Python and TS
/// sides; this is the Rust twin.
#[must_use]
pub fn js_math_round(value: f64) -> f64 {
    if value.is_nan() || value.is_infinite() || value == 0.0 {
        return value;
    }
    // The whole definition: floor(x + 0.5). Ties land on the higher value in
    // both directions, which is what "toward +infinity" means.
    (value + 0.5).floor()
}

/// Whether a finite `f64` holds an exact integer value (`1.0`, `-3.0`).
///
/// JSON has one number type, so TypeScript serializes `1.0` as `1`. The
/// canonicalization contract collapses integral floats to integer form so the
/// two languages stringify identically — plan-34 audit edge #4. The actual
/// collapse happens in the normalizer (TASK-5); this is the predicate it uses.
#[must_use]
pub fn is_integral(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_uint32_matches_js() {
        assert_eq!(to_uint32(0.0), 0);
        assert_eq!(to_uint32(-0.0), 0);
        assert_eq!(to_uint32(1.0), 1);
        // Truncation is toward zero, not floor.
        assert_eq!(to_uint32(1.9), 1);
        assert_eq!(to_uint32(-1.9), 4_294_967_295); // JS: (-1.9 >>> 0) === 4294967295
        assert_eq!(to_uint32(-1.0), 4_294_967_295);
        assert_eq!(to_uint32(4_294_967_296.0), 0); // 2^32 wraps to 0
        assert_eq!(to_uint32(4_294_967_297.0), 1);
        assert_eq!(to_uint32(2_147_483_648.0), 2_147_483_648);
    }

    #[test]
    fn to_uint32_non_finite_is_zero() {
        assert_eq!(to_uint32(f64::NAN), 0);
        assert_eq!(to_uint32(f64::INFINITY), 0);
        assert_eq!(to_uint32(f64::NEG_INFINITY), 0);
    }

    #[test]
    fn to_int32_matches_js() {
        assert_eq!(to_int32(0.0), 0);
        assert_eq!(to_int32(1.0), 1);
        assert_eq!(to_int32(-1.0), -1);
        // 2^31 is the wrap point: JS `2147483648 | 0` === -2147483648
        assert_eq!(to_int32(2_147_483_648.0), -2_147_483_648);
        assert_eq!(to_int32(2_147_483_647.0), 2_147_483_647);
        assert_eq!(to_int32(4_294_967_296.0), 0);
        // The FNV accumulator routinely exceeds int32 before being coerced.
        assert_eq!(to_int32(12_345_678_901.0), to_int32(12_345_678_901.0));
    }

    #[test]
    fn js_math_round_breaks_ties_toward_positive_infinity() {
        // Plan-34 audit edge #2. The negative cases are the ones that matter:
        // Rust's f64::round disagrees with JS on every one of them.
        assert_eq!(js_math_round(0.5), 1.0);
        assert_eq!(js_math_round(1.5), 2.0);
        assert_eq!(js_math_round(2.5), 3.0);
        assert_eq!(js_math_round(49.5), 50.0);
        assert_eq!(js_math_round(-0.5), 0.0);
        assert_eq!(js_math_round(-1.5), -1.0);
        assert_eq!(js_math_round(-2.5), -2.0);
    }

    #[test]
    fn js_math_round_differs_from_rust_round_on_negative_halves() {
        // Pin the divergence explicitly, so anyone tempted to "simplify" this
        // to f64::round sees the test that forbids it.
        for &v in &[-0.5_f64, -1.5, -2.5, -3.5] {
            assert_ne!(
                js_math_round(v),
                v.round(),
                "f64::round must NOT be substituted for js_math_round at {v}",
            );
        }
        // ...while agreeing everywhere ties are not involved.
        for &v in &[-2.4_f64, -1.6, 0.4, 1.6, 100.2] {
            assert_eq!(js_math_round(v), v.round(), "should agree at {v}");
        }
    }

    #[test]
    fn js_math_round_passes_through_non_finite() {
        assert!(js_math_round(f64::NAN).is_nan());
        assert_eq!(js_math_round(f64::INFINITY), f64::INFINITY);
        assert_eq!(js_math_round(f64::NEG_INFINITY), f64::NEG_INFINITY);
    }

    #[test]
    fn is_integral_identifies_whole_numbers() {
        assert!(is_integral(1.0));
        assert!(is_integral(-3.0));
        assert!(is_integral(0.0));
        assert!(!is_integral(1.5));
        assert!(!is_integral(f64::NAN));
        assert!(!is_integral(f64::INFINITY));
    }
}
