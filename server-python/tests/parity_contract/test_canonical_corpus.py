"""Cross-language canonical-JSON golden corpus — plan 177 TASK-1 / AC-1.

Asserts the Python canonicalizer reproduces, byte for byte, what the
TypeScript reference implementation produced for every document in
``tests/parity/canonical/``. TypeScript is canonical per
``tests/parity/sides.json``; a mismatch here is a **Python port bug**, never
a golden to regenerate.

This is the assertion that actually closes AC-1. ``test_canonical_json.py``
proves the cases someone thought to write; this proves agreement on 10 real
tenant configs nobody curated for the purpose — which is where fractional
prices, unicode content, and unusual key orderings actually live.

The corpus lives outside the ``server-python`` tree and is imported by path,
exactly as ``test_normalize.py`` reaches ``tests/parity/normalize.py``.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from revturbine.core.canonical_json import canonicalize_json

# server-python/tests/parity_contract/<f> -> parents[3] = sdk-internal root
_CANONICAL_DIR = Path(__file__).resolve().parents[3] / "tests" / "parity" / "canonical"
_DOCUMENTS = _CANONICAL_DIR / "documents.json"
_GOLDEN = _CANONICAL_DIR / "golden.json"


def _load() -> list[tuple[str, object, str]]:
    if not _DOCUMENTS.exists() or not _GOLDEN.exists():
        pytest.fail(
            f"canonical corpus missing at {_CANONICAL_DIR}. "
            "Run: node tests/parity/canonical/generate.mjs"
        )
    documents = json.loads(_DOCUMENTS.read_text(encoding="utf-8"))["documents"]
    golden = json.loads(_GOLDEN.read_text(encoding="utf-8"))["documents"]

    by_name = {entry["name"]: entry["sha256"] for entry in golden}
    # A document with no golden entry would otherwise pass silently by simply
    # not being asserted — the exact way a corpus gate stops proving anything.
    missing = [d["name"] for d in documents if d["name"] not in by_name]
    assert not missing, f"documents with no golden entry: {missing}"
    assert len(documents) == len(golden), "corpus and golden are different sizes"

    return [(d["name"], d["doc"], by_name[d["name"]]) for d in documents]


_CORPUS = _load()


@pytest.mark.parametrize(
    ("name", "doc", "expected_sha"),
    _CORPUS,
    ids=[name for name, _, _ in _CORPUS],
)
def test_matches_typescript_reference(name: str, doc: object, expected_sha: str) -> None:
    canonical = canonicalize_json(doc)
    actual = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    assert actual == expected_sha, (
        f"canonicalization diverged from the TypeScript reference for {name!r}.\n"
        f"  expected sha256: {expected_sha}\n"
        f"  actual sha256:   {actual}\n"
        f"  produced: {canonical[:400]}\n"
        "This is a Python port bug. Do NOT regenerate the golden to make it pass."
    )


def test_corpus_covers_both_edge_cases_and_real_configs() -> None:
    """Guard the corpus's own shape.

    Real-config coverage is the half that catches what nobody curated, so a
    regeneration on a machine without revturbine-demo-data — which would
    silently drop it — must fail here rather than quietly weaken the gate.
    """
    names = [name for name, _, _ in _CORPUS]
    assert sum(n.startswith("config__") for n in names) >= 5, names
    assert sum(n.startswith("number__") for n in names) >= 5, names
    assert any(n.startswith("sort__") for n in names), names
    assert any(n.startswith("string__") for n in names), names


def test_canonicalization_is_idempotent() -> None:
    """Re-canonicalizing canonical output must be a no-op.

    Catches a class the sha comparison cannot: a canonicalizer that is stable
    against the reference but not against itself would still corrupt any
    pipeline that canonicalizes twice.
    """
    for name, doc, _ in _CORPUS:
        once = canonicalize_json(doc)
        twice = canonicalize_json(json.loads(once))
        assert once == twice, f"not idempotent for {name}"
