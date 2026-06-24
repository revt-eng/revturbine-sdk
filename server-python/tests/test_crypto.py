"""Tests for ``revturbine.core.crypto``.

The golden corpus is generated from the **exact TS algorithm** in
revturbine-scaffold/src/core/crypto.ts (run via node). These are the
load-bearing parity assertions for the decision-cache key — a
divergence here splits the cache between a Python service and its TS
frontend.
"""

from __future__ import annotations

import pytest

from revturbine.core.crypto import (
    FallbackCryptoProvider,
    base64_url_from_bytes,
    fallback_hash_base64url,
)


class TestFallbackHashGoldenCorpus:
    """**Plan-34 REQ-7 audit edge #5 — the FNV-1a hash golden vector.**

    Authoritative cross-language lock for FNV-1a: the expected values
    were captured from the exact TS algorithm via node, so a passing
    assertion *is* TS↔Python byte parity for the fallback hash. Named
    here (not duplicated as a corpus fixture) because the hash is not on
    the headless decision output — it feeds the decision-cache key; a
    golden vector is the precise instrument. The other five plan-34
    audit edges live in tests/parity_contract/test_normalize.py +
    tests/parity/parity.test.ts (plan 33 TASK-11).
    """

    # input -> output, captured from the TS fallbackHashBase64Url via node.
    _GOLDEN: dict[str, str] = {
        "": "gRydxbyfMgA",
        "a": "5AwpLNHA8AA",
        "abc": "GkfpCyMhlAA",
        "hello world": "1Ys_p_vY_AA",
        "tenant_1:pl_x:user_42": "Uy6TyjQYegA",
        '{"a":1,"b":[2,3]}': "LFcb5OHuWAA",
        "éèê": "jdCeamITvwA",
        "0123456789" * 10: "k_-G3UrRwgA",
        "::::": "c2q6pentvgA",
        "slot_banner::banner::feat_export::pro::placement_handle": "YV_-Qh5jXgA",
    }

    @pytest.mark.parametrize(
        ("input_str", "expected"),
        list(_GOLDEN.items()),
        ids=[repr(k)[:24] for k in _GOLDEN],
    )
    def test_matches_ts_golden(self, input_str: str, expected: str) -> None:
        assert fallback_hash_base64url(input_str) == expected

    def test_deterministic(self) -> None:
        assert fallback_hash_base64url("repeat") == fallback_hash_base64url("repeat")

    def test_distinct_inputs_distinct_hashes(self) -> None:
        assert fallback_hash_base64url("aaa") != fallback_hash_base64url("aab")

    def test_output_is_url_safe(self) -> None:
        for value in self._GOLDEN.values():
            assert "+" not in value
            assert "/" not in value
            assert "=" not in value


class TestBase64UrlFromBytes:
    def test_basic(self) -> None:
        # Standard base64 of b"\xff\xff" is "//8="; url-safe + stripped.
        assert base64_url_from_bytes(b"\xff\xff") == "__8"

    def test_plus_becomes_dash(self) -> None:
        # b"\xfb" -> base64 "+w==" -> "-w"
        assert base64_url_from_bytes(b"\xfb") == "-w"

    def test_empty(self) -> None:
        assert base64_url_from_bytes(b"") == ""

    def test_no_padding(self) -> None:
        assert not base64_url_from_bytes(b"abc").endswith("=")
        assert not base64_url_from_bytes(b"ab").endswith("=")


class TestFallbackCryptoProvider:
    def test_sha256_base64url_delegates_to_fallback(self) -> None:
        assert FallbackCryptoProvider.sha256_base64url("abc") == fallback_hash_base64url("abc")

    def test_random_hex_length_and_charset(self) -> None:
        out = FallbackCryptoProvider.random_hex(40)
        assert len(out) == 40
        assert all(c in "0123456789abcdef" for c in out)

    def test_random_hex_zero_length(self) -> None:
        assert FallbackCryptoProvider.random_hex(0) == ""
