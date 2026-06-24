"""Crypto helpers — Python port of @revt-eng/core/crypto.ts.

Provides the injectable hash abstraction (``CryptoProvider``) and the
runtime-free FNV-1a fallback used for placement-ID generation and
decision-cache fingerprinting.

The fallback hash must be **bit-identical** to the TS implementation —
``decision_cache_key`` (TASK-5 batch 2b) feeds it cross-language, so a
divergence here silently splits the cache between a Python service and
its TS frontend. The translation therefore mirrors JavaScript integer
semantics exactly:

- ``charCodeAt`` → UTF-16 code units (not Unicode code points).
- bitwise ops coerce operands via ToInt32, result is ToInt32.
- ``+=`` does NOT wrap (JS doubles); only the next ``<<`` re-truncates.
- ``hash * 1103515245`` overflows 2^53 and is computed in lossy
  IEEE-754 before ``>>> 0`` — replicated with a real float multiply.
- ``DataView.setUint32`` defaults to big-endian.

Verified against node-generated golden values in
tests/test_crypto.py::TestFallbackHashGoldenCorpus.

Source: revturbine-scaffold/src/core/crypto.ts
"""

from __future__ import annotations

import base64
from typing import Protocol, runtime_checkable

__all__ = [
    "CryptoProvider",
    "FallbackCryptoProvider",
    "base64_url_from_bytes",
    "fallback_hash_base64url",
]


def _to_int32(value: int) -> int:
    """JS ToInt32: low 32 bits interpreted as signed."""
    value &= 0xFFFFFFFF
    return value - 0x100000000 if value >= 0x80000000 else value


def _utf16_code_units(text: str) -> list[int]:
    """Mirror JS ``String.prototype.charCodeAt`` — yields UTF-16 code
    units, so astral characters produce surrogate-pair halves exactly as
    the TS loop sees them. (The cache-key domain is ASCII identifiers +
    JSON, but parity must hold for any input.)
    """
    raw = text.encode("utf-16-le")
    return [raw[i] | (raw[i + 1] << 8) for i in range(0, len(raw), 2)]


def base64_url_from_bytes(data: bytes) -> str:
    """Standard base64 with URL-safe substitutions and stripped padding.

    Mirrors the TS ``btoa(...).replace(/\\+/g,'-').replace(/\\//g,'_')
    .replace(/=+$/,'')``.

    Source: crypto.ts:23-33
    """
    return base64.b64encode(data).decode("ascii").replace("+", "-").replace("/", "_").rstrip("=")


def fallback_hash_base64url(input_str: str) -> str:
    """FNV-1a-derived 8-byte hash → URL-safe base64. NOT cryptographically
    secure; used only for deterministic fingerprints.

    Source: crypto.ts:35-47
    """
    # JS: `let hash = 2166136261;` — a Number (> 2^31). Modeled as a
    # Python int that may exceed 32 bits between iterations, exactly as
    # the JS double does (all magnitudes stay < 2^53 → exact).
    hash_val = 2166136261
    for code in _utf16_code_units(input_str):
        # `hash ^= code` — ToInt32 both sides, XOR, result int32.
        h = _to_int32(_to_int32(hash_val) ^ code)
        # `hash += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)` — each shift is a
        # 32-bit op (ToInt32 in, ToInt32 out); the sum is a JS double
        # (no wrap); `hash` becomes that double.
        total = (
            _to_int32(h << 1)
            + _to_int32(h << 4)
            + _to_int32(h << 7)
            + _to_int32(h << 8)
            + _to_int32(h << 24)
        )
        hash_val = h + total

    buffer = bytearray(8)
    # `view.setUint32(0, hash >>> 0)` — ToUint32 of the integer-valued
    # double. int(hash) is exact (< 2^53); & 0xFFFFFFFF == ToUint32.
    lo = int(hash_val) & 0xFFFFFFFF
    # `view.setUint32(4, (hash * 1103515245) >>> 0)` — the product
    # overflows 2^53; JS computes it as a lossy IEEE-754 double, then
    # ToUint32. float(hash) is exact (< 2^53), so the float product is
    # the same IEEE double JS produces; int() reconstructs that double's
    # exact value; & 0xFFFFFFFF == ToUint32.
    hi = int(float(hash_val) * 1103515245.0) & 0xFFFFFFFF
    # DataView.setUint32 is big-endian by default.
    buffer[0:4] = lo.to_bytes(4, "big")
    buffer[4:8] = hi.to_bytes(4, "big")
    return base64_url_from_bytes(bytes(buffer))


@runtime_checkable
class CryptoProvider(Protocol):
    """Injectable hash abstraction. ``sha256_base64url`` is sync here
    (per Q-5 of plan 33); the TS interface returns a Promise because the
    browser ``crypto.subtle`` API is async. A real SHA-256 provider for
    HTTP-mode parity is a TASK-7 concern.

    Source: crypto.ts:12-17
    """

    def sha256_base64url(self, input_str: str) -> str: ...
    def random_hex(self, length: int) -> str: ...


class _FallbackCryptoProvider:
    """FNV-1a hashing + ``random``-based hex. NOT cryptographically
    secure — for environments without real crypto.

    Source: crypto.ts:54-66
    """

    def sha256_base64url(self, input_str: str) -> str:
        return fallback_hash_base64url(input_str)

    def random_hex(self, length: int) -> str:
        import random

        return "".join(random.choice("0123456789abcdef") for _ in range(length))


FallbackCryptoProvider: CryptoProvider = _FallbackCryptoProvider()
