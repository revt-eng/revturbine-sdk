"""Python-side contract test for canonical JSON — plan 177 TASK-1.

Mirrors the "canonicalizeJson — RFC 8785 conformance" block in
``revturbine-scaffold/src/core/bundle/manifest.test.ts`` case for case, so
both canonicalizers are independently asserted to produce identical bytes.
This follows the same pattern as ``test_normalize.py``.

Why this file carries more weight than a normal unit test: plan 177 makes
canonical JSON the Playbook payload, so its sha256 is the content address
every runtime verifies. A divergence between TS and Python here does not
surface as a test failure — it surfaces in production as an intermittent
integrity rejection that depends on whether a tenant priced something at
9.99 or 10.
"""

from __future__ import annotations

import math

import pytest

from revturbine.core.canonical_json import canonicalize_json, js_number_to_string


class TestNumberConformance:
    """The vectors that a naive port gets wrong.

    Every case here is one where Python's own ``json.dumps`` or ``repr``
    disagrees with JavaScript. Keep in lockstep with the TS ``it.each`` table.
    """

    @pytest.mark.parametrize(
        ("value", "expected", "trap"),
        [
            (0, "0", "plain zero"),
            (-0.0, "0", "negative zero normalizes to 0 — json.dumps gives -0.0"),
            (1.0, "1", "integral double drops the fraction — json.dumps gives 1.0"),
            (-1.0, "-1", "negative integral double"),
            (1.5, "1.5", "simple fraction"),
            (9.99, "9.99", "a real price"),
            (0.1 + 0.2, "0.30000000000000004", "shortest round-trip, not a rounded form"),
            (1e21, "1e+21", "exponent threshold — note the + sign"),
            (1e-7, "1e-7", "small-exponent threshold"),
            (1e-6, "0.000001", "just above the threshold stays positional"),
            (1e20, "100000000000000000000", "just below the threshold stays positional"),
            (9007199254740992, "9007199254740992", "2**53, still exact"),
            (-9.99, "-9.99", "negative price"),
            (100, "100", "percentage bound"),
        ],
    )
    def test_matches_ecmascript_number_to_string(
        self, value: float, expected: str, trap: str
    ) -> None:
        assert canonicalize_json(value) == expected, trap

    def test_rejects_non_finite(self) -> None:
        for bad in (math.nan, math.inf, -math.inf):
            with pytest.raises(ValueError):
                canonicalize_json(bad)

    def test_integer_acceptance_is_round_trip_not_magnitude(self) -> None:
        """The criterion is exact round-trip, not size.

        Regression guard for a divergence the golden corpus caught and the
        hand-written tables all missed: a magnitude bound at 2**53 rejects
        10**20, which is ~11,000x larger yet exactly representable
        (10**20 == 5**20 * 2**20, and 5**20 fits in 53 bits). TS serializes it
        losslessly, so refusing it would be the port diverging, not protecting.
        """
        # Not representable — 2**53 + 1 collapses onto 2**53 as a double.
        with pytest.raises(ValueError, match="round-trip"):
            canonicalize_json(2**53 + 1)

        # Representable despite being far larger.
        assert canonicalize_json(10**20) == "100000000000000000000"
        # And the boundary itself is fine.
        assert canonicalize_json(2**53) == "9007199254740992"


class TestStructuralConformance:
    def test_sorts_keys_by_utf16_code_unit_not_code_point(self) -> None:
        assert canonicalize_json({"b": 1, "A": 2, "a": 3, "B": 4}) == '{"A":2,"B":4,"a":3,"b":1}'
        assert canonicalize_json({"ä": 1, "z": 2}) == '{"z":2,"ä":1}'
        assert canonicalize_json({"é": 1, "Ａ": 2}) == '{"é":1,"Ａ":2}'

    def test_astral_characters_sort_by_utf16_not_code_point(self) -> None:
        # The divergence Python's default sorted() would introduce: U+1F600
        # (astral, encoded as a surrogate pair starting 0xD83D) sorts BEFORE
        # U+FF21 in UTF-16 order, but AFTER it by code point.
        result = canonicalize_json({"\U0001f600": 1, "Ａ": 2})
        assert result == '{"\U0001f600":1,"Ａ":2}'
        assert sorted(["\U0001f600", "Ａ"]) == ["Ａ", "\U0001f600"]

    def test_escapes_strings_to_shortest_form(self) -> None:
        assert canonicalize_json('a"b') == '"a\\"b"'
        assert canonicalize_json("a\\b") == '"a\\\\b"'
        assert canonicalize_json("\n\t\r\b\f") == '"\\n\\t\\r\\b\\f"'
        assert canonicalize_json("\u0000\u001f") == '"\\u0000\\u001f"'
        # Forward slash and DEL are NOT escaped.
        assert canonicalize_json("/") == '"/"'
        assert canonicalize_json("") == '""'
        # Non-ASCII emitted literally, not \u-escaped.
        assert canonicalize_json("é☃") == '"é☃"'

    def test_booleans_are_not_treated_as_integers(self) -> None:
        # bool subclasses int in Python; a naive numeric branch renders True
        # as "1" and silently corrupts every boolean in the Playbook.
        assert (
            canonicalize_json({"enabled": True, "hidden": False})
            == '{"enabled":true,"hidden":false}'
        )

    def test_sorts_keys_at_every_level_and_preserves_array_order(self) -> None:
        assert canonicalize_json({"b": 1, "a": {"d": 2, "c": 3}}) == '{"a":{"c":3,"d":2},"b":1}'
        assert canonicalize_json([3, 1, 2]) == "[3,1,2]"

    def test_identical_output_regardless_of_insertion_order(self) -> None:
        a = {"active": {"sha256": "x", "url": "/u"}, "tenant_id": "t"}
        b = {"tenant_id": "t", "active": {"url": "/u", "sha256": "x"}}
        assert canonicalize_json(a) == canonicalize_json(b)

    def test_rejects_unsupported_types(self) -> None:
        with pytest.raises(ValueError, match="unsupported type"):
            canonicalize_json({1, 2})
        with pytest.raises(ValueError, match="non-string object key"):
            canonicalize_json({1: "a"})

    def test_realistic_pricing_fragment(self) -> None:
        expected = (
            '{"max_balance":null,"price_amount":9.99,"rate_value":0.5,"soft_limit_percent":80}'
        )
        assert (
            canonicalize_json(
                {
                    "price_amount": 9.99,
                    "soft_limit_percent": 80,
                    "max_balance": None,
                    "rate_value": 0.5,
                }
            )
            == expected
        )


class TestJsNumberToStringDirectly:
    """Fuzz the number formatter against its own round-trip property.

    Any string this produces must parse back to the same double. That
    catches digit-layout bugs the fixed vector table would miss.
    """

    @pytest.mark.parametrize(
        "value",
        [
            0.1,
            0.2,
            0.3,
            1 / 3,
            2 / 3,
            1e-5,
            1e-4,
            123.456,
            1e15,
            1e16,
            1.7976931348623157e308,
            5e-324,
            4.9,
            0.5,
            1234567890.12345,
        ],
    )
    def test_round_trips(self, value: float) -> None:
        assert float(js_number_to_string(value)) == value

    def test_shortest_representation_matches_repr_digits(self) -> None:
        # repr() is Python's shortest round-trip; the digits must agree even
        # when the layout does not.
        for v in (0.1 + 0.2, 1 / 3, 1e-7, 1e21):
            digits_out = js_number_to_string(v).replace("-", "").replace(".", "")
            digits_out = digits_out.split("e")[0].rstrip("0") or "0"
            digits_repr = repr(v).replace("-", "").replace(".", "")
            digits_repr = digits_repr.split("e")[0].rstrip("0") or "0"
            assert digits_out == digits_repr
