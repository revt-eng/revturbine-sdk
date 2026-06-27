"""Plan 108 TASK-1: ``revturbine_server.RevTurbineServer`` exposes a public
``get_placement`` that resolves a single placement decision — mirroring the
server-node ``getPlacement`` and reconciling the canonical server surface that
plan 107 Q-6 deferred.

Uses dynamic import (like ``test_public_api``) because ``revturbine_server`` is
intentionally outside mypy ``--strict`` / CI ruff scope (legacy surface).
"""

from __future__ import annotations

import importlib
from typing import Any

import pytest


def _server() -> Any:
    mod = importlib.import_module("revturbine_server")
    return mod.RevTurbineServer(
        tenant_id="tenant_t",
        api_key="sk_test",
        endpoint="https://edge.example.com",
    )


def test_get_placement_is_public_and_delegates_to_single_placement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = _server()
    assert callable(server.get_placement)

    captured: dict[str, Any] = {}

    def fake_single(rid: str, user_id: str, placement: Any, traits: Any) -> str:
        captured["user_id"] = user_id
        captured["placement"] = placement
        captured["traits"] = traits
        return "decision"

    monkeypatch.setattr(server, "_evaluate_single_placement", fake_single)

    placement = {"slot_id": "hero", "placement_handle": "pl_x"}
    out = server.get_placement("user_1", placement, {"plan": "pro"})

    assert out == "decision"
    assert captured["user_id"] == "user_1"
    assert captured["placement"] == placement
    assert captured["traits"] == {"plan": "pro"}
