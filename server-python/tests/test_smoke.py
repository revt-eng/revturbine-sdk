"""Smoke tests — bootstrap acceptance for TASK-1 of plan 33."""

from __future__ import annotations


def test_package_imports() -> None:
    import revturbine

    # Single-sourced from installed metadata (plan 174 TASK-5); the exact
    # pyproject match is pinned by tests/test_version_single_source.py.
    assert revturbine.__version__
    assert revturbine.__version__ != "0.0.0+unknown"


def test_py_typed_marker_present() -> None:
    """PEP 561: downstream type-checkers must see ``py.typed`` in the package."""
    from importlib.resources import files

    marker = files("revturbine") / "py.typed"
    assert marker.is_file()
