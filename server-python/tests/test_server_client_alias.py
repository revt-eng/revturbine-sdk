"""Plan 107 TASK-4: the ``revturbine_server.RevTurbineServer`` HTTP client
exposes the ``can`` alias of ``check_entitlement`` — the server-surface hero
verb declared in the scaffold SDK function-surface manifest, mirroring the
server-node port — so the python and node server ports stay consistent with the
contract.

Uses dynamic import (like ``test_public_api``) because ``revturbine_server`` is
intentionally outside mypy ``--strict`` scope (legacy surface).
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


def test_can_is_public_and_delegates_to_check_entitlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = _server()
    assert callable(server.can)

    captured: dict[str, Any] = {}

    def fake_check(user_id: str, handle: str, **kwargs: Any) -> str:
        captured["args"] = (user_id, handle)
        captured["kwargs"] = kwargs
        return "sentinel"

    monkeypatch.setattr(server, "check_entitlement", fake_check)

    out = server.can("user_1", "generate_image", used=1.0)

    assert out == "sentinel"
    assert captured["args"] == ("user_1", "generate_image")
    assert captured["kwargs"] == {"used": 1.0, "balance": None, "required_tier": None}
