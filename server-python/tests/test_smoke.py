"""Smoke tests — bootstrap acceptance for TASK-1 of plan 33."""

from __future__ import annotations


def test_package_imports() -> None:
    import revturbine

    assert revturbine.__version__ == "0.2.2"


def test_py_typed_marker_present() -> None:
    """PEP 561: downstream type-checkers must see ``py.typed`` in the package."""
    from importlib.resources import files

    marker = files("revturbine") / "py.typed"
    assert marker.is_file()
