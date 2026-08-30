"""Canonical JSON (RFC 8785 / JCS) — Python port of the TS canonicalizer.

Source: revturbine-scaffold/src/core/bundle/signing.ts

Plan 177 makes canonical JSON the Playbook payload format, so the sha256
of this output is the **content address** every runtime verifies against.
That makes byte-for-byte agreement with the TypeScript implementation a
correctness requirement, not a nicety: if TS and Python disagree on a
single character, the same Playbook yields two different addresses and
integrity checks fail intermittently on data-dependent input — the worst
failure shape, because it depends on whether a tenant happens to price
something at 9.99 or 10.

Every divergence risk is in numbers, and Python's defaults are wrong on
all three counts:

- ``json.dumps(-0.0)`` gives ``-0.0``; JS gives ``0``.
- ``json.dumps(1.0)`` gives ``1.0``; JS gives ``1``.
- Python switches to exponent form at different thresholds than JS, and
  writes ``1e+21`` where the digit layout may still differ.

So numbers do NOT go through ``json.dumps``. :func:`js_number_to_string`
reimplements ECMAScript ``Number::toString`` (ECMA-262 §6.1.6.1.20),
which is what RFC 8785 §3.2.2.3 defines number serialization to be.

Key ordering is the second trap. RFC 8785 §3.2.3 sorts by **UTF-16 code
unit**, which is what JS ``Array.prototype.sort`` does natively. Python's
``sorted()`` compares by Unicode *code point*, and the two disagree for
anything above the BMP (astral characters sort before U+E000–U+FFFF in
UTF-16 but after them by code point). Sorting on the UTF-16-BE encoding
recovers JS order exactly.

Mirrors the numeric-fidelity discipline already established in
``core/crypto.py`` and ``server-rust``'s ``js_num.rs``.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

__all__ = ["canonical_hash_key", "canonicalize_json", "js_number_to_string"]

# JSON short escapes, per RFC 8785 §3.2.2.2 (identical to JS JSON.stringify).
_SHORT_ESCAPES = {
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
    0x22: '\\"',
    0x5C: "\\\\",
}


def js_number_to_string(value: float) -> str:
    """ECMAScript ``Number::toString`` for a finite double.

    RFC 8785 §3.2.2.3 defines JSON number serialization as exactly this
    algorithm, so this is the canonical form — not an approximation of it.

    The spec picks integers ``s``, ``k``, ``n`` where ``k`` is the number of
    decimal digits in ``s``, ``s`` has no trailing zero, and
    ``s * 10**(n - k) == value`` with ``k`` minimal. ``repr()`` already
    yields the shortest round-tripping digits, so we recover ``s`` and ``n``
    from it and then apply the spec's five layout cases.
    """
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError(f"js_number_to_string: {value!r} is not representable in JSON")

    # Covers both +0.0 and -0.0 — the spec normalizes negative zero to "0".
    if value == 0:
        return "0"

    if value < 0:
        return "-" + js_number_to_string(-value)

    # An integral value below the 1e21 exponent threshold formats as a plain
    # integer. Handling it up front avoids Decimal churn on the common case
    # (limits, percentages, counts) and guarantees "1" rather than "1.0".
    if value.is_integer() and value < 1e21:
        return str(int(value))

    sign, digits, exponent = Decimal(repr(value)).as_tuple()
    assert sign == 0 and isinstance(exponent, int)

    digit_str = "".join(str(d) for d in digits)
    # Strip trailing zeros, compensating the exponent so the value is
    # unchanged. This is the spec's "k is as small as possible".
    stripped = digit_str.rstrip("0")
    exponent += len(digit_str) - len(stripped)
    s = stripped or "0"
    k = len(s)
    n = exponent + k

    if k <= n <= 21:
        return s + "0" * (n - k)
    if 0 < n <= 21:
        return s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + s

    # Exponent form. Positive exponents carry an explicit "+".
    e = n - 1
    mantissa = s if k == 1 else s[0] + "." + s[1:]
    return f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"


def _encode_string(value: str) -> str:
    out = ['"']
    for ch in value:
        code = ord(ch)
        short = _SHORT_ESCAPES.get(code)
        if short is not None:
            out.append(short)
        elif code < 0x20:
            # Lowercase hex, matching JS. Uppercase would hash differently.
            out.append(f"\\u{code:04x}")
        elif 0xD800 <= code <= 0xDFFF:
            # Lone surrogate. ES2019 well-formed JSON.stringify escapes these
            # rather than emitting invalid UTF-8; Python would happily encode
            # a surrogate and produce bytes TS never would.
            out.append(f"\\u{code:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _utf16_sort_key(key: str) -> bytes:
    """Sort key reproducing JS string comparison (UTF-16 code unit order).

    Big-endian so a plain byte comparison is a code-unit comparison.
    ``surrogatepass`` keeps lone surrogates encodable rather than raising.
    """
    return key.encode("utf-16-be", errors="surrogatepass")


def canonicalize_json(value: Any) -> str:
    """Serialize ``value`` to canonical JSON (RFC 8785).

    Raises on anything JSON cannot represent losslessly. Silent coercion
    would be worse than failing: it produces a stable-looking hash over the
    wrong bytes.
    """
    if value is None:
        return "null"

    # bool before int — in Python ``bool`` IS an ``int`` subclass, so the
    # numeric branch would otherwise render True as "1".
    if value is True:
        return "true"
    if value is False:
        return "false"

    if isinstance(value, str):
        return _encode_string(value)

    if isinstance(value, int):
        # Python ints are arbitrary precision; JS has only doubles. The test
        # that matters is EXACT ROUND-TRIP, not magnitude: 10**20 is far past
        # 2**53 yet is exactly representable (it factors to 5**20 * 2**20, and
        # 5**20 fits in 53 bits), so JS prints it losslessly and refusing it
        # would diverge from TS on a document TS handles fine. 2**53 + 1 is
        # smaller but NOT representable, and there Python must refuse rather
        # than emit different bytes than JS.
        #
        # Found by the cross-language golden corpus, which is exactly the class
        # of bug three independently-written test tables all missed.
        try:
            as_float = float(value)
        except OverflowError as exc:  # beyond double range entirely
            raise ValueError(
                f"canonicalize_json: integer {value} exceeds the double range"
            ) from exc
        if int(as_float) != value:
            raise ValueError(
                f"canonicalize_json: integer {value} cannot round-trip through a "
                "JS number without loss"
            )
        return js_number_to_string(as_float)

    if isinstance(value, float):
        return js_number_to_string(value)

    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize_json(item) for item in value) + "]"

    if isinstance(value, dict):
        # Validate before sorting — the sort key calls str.encode, so a
        # non-string key would surface as an AttributeError from inside the
        # comparator rather than as a diagnosable error here.
        for key in value:
            if not isinstance(key, str):
                raise ValueError(
                    f"canonicalize_json: non-string object key {key!r} has no JSON encoding"
                )
        parts = [
            _encode_string(key) + ":" + canonicalize_json(value[key])
            for key in sorted(value.keys(), key=_utf16_sort_key)
        ]
        return "{" + ",".join(parts) + "}"

    raise ValueError(f"canonicalize_json: unsupported type {type(value).__name__}")


def canonical_hash_key(value: Any) -> str:
    """Serialize JSON-compatible input beneath a hash or cache key.

    This semantic boundary mirrors TypeScript ``canonicalHashKey`` and uses
    the same RFC 8785 bytes, including UTF-16 code-unit key ordering.
    """
    return canonicalize_json(value)
