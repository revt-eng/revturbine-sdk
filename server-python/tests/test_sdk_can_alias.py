"""Plan 174 TASK-5 / REQ-7: ``RevTurbineCustomerSdk`` exposes the ``can``
alias of ``check_entitlement`` — the server-surface hero verb declared in the
scaffold SDK function-surface manifest (canonical ``checkEntitlement``, alias
``can``), mirroring the server-node port and the legacy
``revturbine_server.RevTurbineServer`` client (which gained the alias in plan
107 TASK-4). The modern headless SDK was the one port still missing it
(spec-check F-64).
"""

from __future__ import annotations

from typing import Any

import pytest

from revturbine import RevTurbineCustomerSdk


def _sdk() -> RevTurbineCustomerSdk:
    return RevTurbineCustomerSdk(
        user_context={"tenant_id": "t", "user_id": "u"},
        exported_config={
            "version": "1.0.0",
            "plans": [],
            "entitlements": [],
            "entitlement_rules": [],
            "segments": [],
            "content_ui_paths": [],
        },
    )


def test_can_is_public_and_delegates_to_check_entitlement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sdk = _sdk()
    assert callable(sdk.can)

    captured: dict[str, Any] = {}
    sentinel: Any = {"allowed": True}

    def fake_check(handle: str, context: dict[str, Any] | None = None) -> Any:
        captured["handle"] = handle
        captured["context"] = context
        return sentinel

    monkeypatch.setattr(sdk, "check_entitlement", fake_check)

    out = sdk.can("generate_image", {"used": 1})

    assert out is sentinel
    assert captured["handle"] == "generate_image"
    assert captured["context"] == {"used": 1}


def test_can_matches_check_entitlement_result_shape() -> None:
    sdk = _sdk()
    via_alias = sdk.can("some_handle")
    via_canonical = sdk.check_entitlement("some_handle")
    assert via_alias == via_canonical
