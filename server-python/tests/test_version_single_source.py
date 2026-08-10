"""Plan 174 TASK-5 / REQ-8: the package version is single-sourced.

``revturbine.__version__`` derives from the installed package metadata, whose
only source is ``pyproject.toml`` — the hand-kept literal previously drifted
to 0.2.2 while pyproject moved on (spec-check F-63). This check fails the
build if the two ever disagree again.

Local nuance: after bumping ``pyproject.toml`` in an editable checkout, re-run
``pip install -e .`` so the installed metadata refreshes — CI installs fresh
every run, so this only affects stale local venvs.
"""

from __future__ import annotations

import re
from pathlib import Path

import revturbine


def _pyproject_version() -> str:
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    match = re.search(r'^version = "([^"]+)"', pyproject.read_text(encoding="utf-8"), re.M)
    assert match, "pyproject.toml has no version line"
    return match.group(1)


def test_dunder_version_matches_pyproject() -> None:
    assert revturbine.__version__ == _pyproject_version()
