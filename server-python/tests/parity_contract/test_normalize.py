"""Python-side contract test for ``tests/parity/normalize.py`` — plan
33 TASK-11.

Fills a real gap: the TS normalizer was contract-tested in
``tests/parity/parity.test.ts`` but the **Python** ``normalize.py`` had
no direct test (only exercised indirectly via the cross-language
orchestrator). This mirrors the TS "Q-4 cross-language contract" block
so both normalizers are independently asserted to behave identically,
**and individually names the six plan-34 audit edges (REQ-7)**.

The parity ``normalize.py`` lives in ``revturbine-sdk-internal/tests/parity/``
(outside the ``server-python`` tree); imported via ``sys.path`` exactly
as ``py_runner.py`` does. (Formal lint/type CI for ``tests/parity/*.py``
remains the TASK-10 reusable-workflow follow-up.)
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import pytest

# revturbine-sdk-internal/server-python/tests/parity_contract/<f> → parents[3] = sdk root
_PARITY = Path(__file__).resolve().parents[3] / "tests" / "parity"
sys.path.insert(0, str(_PARITY))

from normalize import (  # type: ignore[import-not-found]  # noqa: E402
    NONDETERMINISTIC_KEYS,
    canonical_json,
    normalize_value,
)

from revturbine.core.crypto import fallback_hash_base64url  # noqa: E402
from revturbine.core.placements.local_resolver import _js_math_round  # noqa: E402


class TestQ4Contract:
    """Mirror of parity.test.ts "normalize.ts — the Q-4 cross-language
    contract". Any change must stay in lockstep with the TS block.
    """

    def test_strips_every_nondeterministic_key_at_any_depth(self) -> None:
        out = normalize_value(
            {
                "keep": 1,
                "requestId": "r1",
                "nested": {"decision_source": "cache", "value": 2, "updatedAt": "t"},
                "list": [{"ts": 9, "ok": True}],
            }
        )
        assert out == {"keep": 1, "list": [{"ok": True}], "nested": {"value": 2}}

    def test_nondeterministic_keys_in_sync_with_documented_set(self) -> None:
        for k in ("requestId", "request_id", "decisionSource", "timestamp", "updatedAt"):
            assert k in NONDETERMINISTIC_KEYS

    def test_canonicalizes_keys_to_snake_case(self) -> None:
        assert normalize_value({"placementId": 1, "reasonCodes": ["a"]}) == {
            "placement_id": 1,
            "reason_codes": ["a"],
        }
        assert normalize_value({"already_snake": 1, "header": 2, "someXMLValue": 3}) == {
            "already_snake": 1,
            "header": 2,
            "some_xml_value": 3,
        }

    def test_uuid_and_datetime_placeholders(self) -> None:
        assert normalize_value(
            {
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "planId": "starter",
                "endsAt": "2026-05-15T12:34:56.789Z",
                "day": "2026-05-15",
            }
        ) == {
            "day": "2026-05-15",
            "ends_at": "<datetime>",
            "id": "<uuid>",
            "plan_id": "starter",
        }

    def test_array_order_preserved(self) -> None:
        assert normalize_value(["z", "a", "m"]) == ["z", "a", "m"]


class TestPlan34AuditEdges:
    """The six plan-34 REQ-7 audit edges — individually present + named.
    Each is the exact cross-language divergence risk the parity scheme
    exists to catch; the orchestrator's byte-diff enforces them
    end-to-end, these pin each one in isolation.
    """

    def test_edge1_output_id_mixed_case_and_non_ascii_ordering(self) -> None:
        # Recursive codepoint key sort — neutralized only after the
        # snake_case canon; non-ASCII keys sort by codepoint, stable
        # across languages.
        out = canonical_json({"Zebra": 1, "apple": 2, "Ähnlich": 3, "_x": 4})
        keys = [ln.strip().split('"')[1] for ln in out.splitlines() if ln.strip().startswith('"')]
        assert keys == sorted(keys)

    def test_edge2_math_round_half_toward_positive_infinity(self) -> None:
        # JS Math.round(.5) rounds toward +Inf; Python's builtin round()
        # is banker's and would diverge. _js_math_round is the faithful
        # port feeding placement usage_percent.
        assert _js_math_round(0.5) == 1
        assert _js_math_round(-0.5) == 0
        assert _js_math_round(2.5) == 3
        assert _js_math_round(49.5) == 50
        assert round(0.5) == 0  # contrast: stdlib would diverge

    def test_edge3_nan_and_infinity(self) -> None:
        assert normalize_value(math.nan) == "<nan>"
        assert normalize_value(math.inf) == "<inf>"
        assert normalize_value(-math.inf) == "<-inf>"

    def test_edge4_integral_float_stringify(self) -> None:
        assert normalize_value(1.0) == 1
        assert normalize_value(-0.0) == 0
        assert normalize_value(1.5) == 1.5
        assert canonical_json({"limit": 10.0}) == '{\n  "limit": 10\n}\n'

    def test_edge5_fnv1a_hash_golden_vector(self) -> None:
        # FNV-1a fallback hash — full TS-generated golden corpus lives in
        # tests/test_crypto.py::TestFallbackHashGoldenCorpus. This pins a
        # representative vector here as the named plan-34 audit edge.
        assert fallback_hash_base64url("hello world") == "1Ys_p_vY_AA"
        assert fallback_hash_base64url("éèê") == "jdCeamITvwA"

    def test_edge6_undefined_key_omission(self) -> None:
        # Precise cross-language contract (the audit subtlety):
        #   * Python ``None`` is a genuine JSON ``null`` — PRESERVED,
        #     exactly as TS preserves ``null`` (TS normalizeValue(null)
        #     → null). It is NOT JS ``undefined``.
        #   * The undefined-EQUIVALENT (TS ``undefined`` / function ↔
        #     Python ``_OMIT``: callables / unsupported) is OMITTED in
        #     both languages.
        #   * The port emits *absent* keys where TS emits ``undefined``
        #     (e.g. feature-enabled omits ``reason``); the corpus
        #     byte-diff enforces that end-to-end.
        assert canonical_json({"a": None, "b": 1}) == '{\n  "a": null,\n  "b": 1\n}\n'
        assert normalize_value({"keep_null": None}) == {"keep_null": None}
        # undefined-equivalent (callable) → key omitted, parity with TS
        # omitting function/undefined-valued keys.
        assert normalize_value({"keep": 1, "fn": (lambda: 0)}) == {"keep": 1}


class TestCanonicalJson:
    def test_sorts_keys_recursively_and_omits_undefined_equivalent(self) -> None:
        # Mirrors parity.test.ts intent (recursive snake+sort +
        # undefined-omit) using Python's undefined-equivalent (callable
        # → _OMIT); ``None`` (genuine null) is preserved, distinct from
        # the TS test's JS ``undefined``.
        assert canonical_json({"bKey": 1, "aKey": {"dKey": (lambda: 0), "cKey": 2}}) == (
            '{\n  "a_key": {\n    "c_key": 2\n  },\n  "b_key": 1\n}\n'
        )

    def test_trailing_newline_and_two_space_indent(self) -> None:
        out = canonical_json({"x": [1, 2]})
        assert out.endswith("\n")
        assert out == '{\n  "x": [\n    1,\n    2\n  ]\n}\n'


@pytest.mark.parametrize(
    ("value", "expected"),
    [(0, 0), (-0.0, 0), (2.0, 2), (2.5, 2.5), (math.nan, "<nan>")],
)
def test_number_canonicalization_matrix(value: float, expected: object) -> None:
    assert normalize_value(value) == expected
