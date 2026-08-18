"""Cross-language payload version-refusal matrix — plan 177 TASK-3 / AC-3.

Drives the Python ``assert_playbook_payload_readable`` over the shared
matrix at ``tests/parity/canonical/version-refusal.json`` and asserts the
exact outcome — ``accepted`` or the refusal reason. The TypeScript reference
(scaffold ``src/core/bundle/json-payload.ts``) must produce the same outcome
for the same envelope; a mismatch here is a Python port bug, never a fixture
to loosen.

Reader windows come from the fixture, not from this build's constants, so
the matrix stays valid across ``BUNDLE_SCHEMA_VERSION`` bumps. The
live-constant defaults are covered by ``tests/test_config_payload.py``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from revturbine.config import (
    PlaybookPayloadVersionError,
    assert_playbook_payload_readable,
)

# server-python/tests/parity_contract/<f> -> parents[3] = sdk-internal root
_MATRIX = (
    Path(__file__).resolve().parents[3] / "tests" / "parity" / "canonical" / "version-refusal.json"
)


def _load() -> tuple[dict[str, int], list[dict[str, Any]]]:
    if not _MATRIX.exists():
        pytest.fail(f"version-refusal matrix missing at {_MATRIX}")
    doc = json.loads(_MATRIX.read_text(encoding="utf-8"))
    return doc["reader"], doc["cases"]


_DEFAULT_READER, _CASES = _load()


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_refusal_matrix(case: dict[str, Any]) -> None:
    reader = case.get("reader", _DEFAULT_READER)
    expect = case["expect"]
    try:
        assert_playbook_payload_readable(
            case["payload"],
            schema_version=reader["schema_version"],
            min_readable_schema_version=reader["min_readable_schema_version"],
        )
        outcome = "accepted"
    except PlaybookPayloadVersionError as err:
        outcome = err.reason
    assert outcome == expect, f"{case['name']}: expected {expect}, got {outcome}"


def test_matrix_is_not_vacuous() -> None:
    outcomes = {c["expect"] for c in _CASES}
    # Every refusal reason and the accept path must be exercised, or a port
    # could diverge on an outcome this matrix never checks.
    assert outcomes == {
        "accepted",
        "malformed_envelope",
        "missing_schema_version",
        "schema_version_too_new",
        "schema_version_too_old",
        "requires_newer_reader",
    }
