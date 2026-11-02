"""ST-1418: the ``exported_config`` aliases were removed in 0.13.0.

This module used to pin the alias machinery; it now pins the removal.
"""

from __future__ import annotations

import importlib
import inspect
from typing import Any

import pytest

from revturbine import RevTurbineCustomerSdk
from revturbine.core import helpers
from revturbine.core.entitlements.entitlement_check import (
    derive_local_entitlement_from_configured_rules,
)
from revturbine.core.placements.local_resolver import create_static_placement_resolver
from revturbine.core.runtime.local_runtime import LocalRuntime


def test_alias_module_is_gone() -> None:
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("revturbine.playbook_option")


def test_exported_config_keyword_is_gone() -> None:
    for fn in (
        RevTurbineCustomerSdk,
        LocalRuntime,
        create_static_placement_resolver,
        derive_local_entitlement_from_configured_rules,
    ):
        assert "exported_config" not in inspect.signature(fn).parameters


def test_deprecated_helpers_and_methods_are_gone() -> None:
    assert not hasattr(helpers, "configured_plan_name_from_exported_config")
    assert not hasattr(helpers, "parse_exported_config_or_throw")
    assert not hasattr(LocalRuntime, "get_exported_config")


def test_playbook_is_required() -> None:
    bad: Any = {"tenant_id": "t", "user_id": "u"}
    with pytest.raises(ValueError, match="playbook"):
        RevTurbineCustomerSdk(user_context=bad)
