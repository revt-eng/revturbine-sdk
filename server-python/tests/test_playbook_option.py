"""BL-0156 — ``exported_config`` is deprecated; ``playbook`` is canonical.

The Python counterpart of ``web-sdk/playbook-option.test.ts`` and scaffold's
``src/core/playbook-option.test.ts`` (PR #380). What is asserted:

  - the canonical keyword resolves and NEVER warns;
  - the deprecated keyword still resolves, so nothing breaks on upgrade;
  - the :class:`DeprecationWarning` fires **exactly once per process** across
    different read sites, names the canonical keyword and the removal version,
    and fires again only after the test-only reset;
  - a required read site with neither keyword raises;
  - every public read site accepts BOTH spellings and reaches the same
    Playbook: ``RevTurbineCustomerSdk``, ``LocalRuntime`` (including the
    deprecated ``get_exported_config()``), ``create_static_placement_resolver``
    and ``derive_local_entitlement_from_configured_rules``.

The per-process flag is why every test resets it in a fixture: without the
reset, whichever test ran first would be the only one that could ever observe a
warning, and the rest would pass vacuously.
"""

from __future__ import annotations

from typing import Any

import pytest

from revturbine import RevTurbineCustomerSdk, UserContext
from revturbine.core.adapters import create_static_providers
from revturbine.core.entitlements import derive_local_entitlement_from_configured_rules
from revturbine.core.helpers import (
    configured_plan_name_from_exported_config,
    configured_plan_name_from_playbook,
)
from revturbine.core.placements import (
    LocalPlacementDataset,
    create_static_placement_resolver,
)
from revturbine.core.runtime import LocalRuntime
from revturbine.playbook_option import (
    PLAYBOOK_ALIAS_REMOVAL_VERSION,
    require_playbook_option,
    reset_playbook_alias_warning,
    resolve_playbook_option,
)


@pytest.fixture(autouse=True)
def _reset_alias_warning() -> Any:
    reset_playbook_alias_warning()
    yield
    reset_playbook_alias_warning()


def _playbook(handle: str = "free") -> dict[str, Any]:
    return {
        "version": "1.0.0",
        "plans": [
            {
                "id": "cfg_a",
                "unique_handle": handle,
                "name": "Free",
                "tier_position": 0,
                "sort_order": 0,
            }
        ],
        "entitlements": [{"unique_handle": "feat_x", "unit": None}],
        "entitlement_rules": [],
        "segments": [],
        "content_ui_paths": [],
        "placements": [],
    }


def _ctx() -> UserContext:
    ctx: UserContext = {"tenant_id": "tenant_t", "user_id": "user_u"}
    return ctx


class TestResolver:
    def test_canonical_resolves_and_never_warns(self, recwarn: Any) -> None:
        pb = _playbook()
        assert resolve_playbook_option(pb, None, "X") is pb
        assert [w for w in recwarn if w.category is DeprecationWarning] == []

    def test_deprecated_still_resolves(self) -> None:
        pb = _playbook()
        with pytest.warns(DeprecationWarning):
            assert resolve_playbook_option(None, pb, "X") is pb

    def test_canonical_wins_when_both_supplied(self, recwarn: Any) -> None:
        canonical = _playbook("canonical")
        legacy = _playbook("legacy")
        assert resolve_playbook_option(canonical, legacy, "X") is canonical
        assert [w for w in recwarn if w.category is DeprecationWarning] == []

    def test_neither_returns_none_and_require_raises(self) -> None:
        assert resolve_playbook_option(None, None, "X") is None
        with pytest.raises(ValueError, match="LocalRuntime: 'playbook' is required"):
            require_playbook_option(None, None, "LocalRuntime")

    def test_warning_names_the_canonical_keyword_and_removal_version(self) -> None:
        with pytest.warns(DeprecationWarning) as rec:
            resolve_playbook_option(None, _playbook(), "LocalRuntime")
        message = str(rec[0].message)
        assert "`LocalRuntime(exported_config=...)` is deprecated" in message
        assert "`LocalRuntime(playbook=...)`" in message
        assert PLAYBOOK_ALIAS_REMOVAL_VERSION in message

    def test_warns_exactly_once_across_read_sites_then_again_after_reset(
        self, recwarn: Any
    ) -> None:
        # Three different read sites, three deprecated spellings, one warning.
        resolve_playbook_option(None, _playbook(), "LocalRuntime")
        resolve_playbook_option(None, _playbook(), "RevTurbineCustomerSdk")
        resolve_playbook_option(None, _playbook(), "create_static_placement_resolver")
        assert len([w for w in recwarn if w.category is DeprecationWarning]) == 1

        reset_playbook_alias_warning()
        resolve_playbook_option(None, _playbook(), "LocalEvaluationServer")
        assert len([w for w in recwarn if w.category is DeprecationWarning]) == 2


class TestPublicReadSites:
    def test_sdk_accepts_both_spellings_and_reaches_the_same_playbook(self) -> None:
        pb = _playbook("starter")
        canonical = RevTurbineCustomerSdk(user_context=_ctx(), playbook=pb)
        with pytest.warns(DeprecationWarning):
            legacy = RevTurbineCustomerSdk(user_context=_ctx(), exported_config=pb)
        assert canonical._playbook == legacy._playbook

    def test_sdk_with_neither_spelling_raises(self) -> None:
        with pytest.raises(ValueError, match="'playbook' is required"):
            RevTurbineCustomerSdk(user_context=_ctx())

    def test_local_runtime_accepts_both_spellings(self) -> None:
        pb = _playbook()
        providers = create_static_providers(config=pb, plan_handle="free")
        canonical = LocalRuntime(
            tenant_id="tenant_t", user_id="user_u", playbook=pb, providers=providers
        )
        with pytest.warns(DeprecationWarning):
            legacy = LocalRuntime(
                tenant_id="tenant_t",
                user_id="user_u",
                exported_config=pb,
                providers=providers,
            )
        assert canonical.get_playbook() is legacy.get_playbook()

    def test_local_runtime_get_exported_config_is_a_deprecated_alias(self) -> None:
        pb = _playbook()
        providers = create_static_providers(config=pb, plan_handle="free")
        runtime = LocalRuntime(
            tenant_id="tenant_t", user_id="user_u", playbook=pb, providers=providers
        )
        with pytest.warns(DeprecationWarning, match="get_exported_config"):
            assert runtime.get_exported_config() is runtime.get_playbook()

    def test_static_placement_resolver_accepts_both_spellings(self) -> None:
        pb = _playbook()
        dataset: LocalPlacementDataset = {"placements": []}
        assert create_static_placement_resolver(dataset, pb) is not None
        with pytest.warns(DeprecationWarning):
            assert create_static_placement_resolver(dataset, exported_config=pb) is not None

    def test_entitlement_fallback_accepts_both_spellings(self) -> None:
        pb = _playbook()
        kwargs: dict[str, Any] = {
            "handle": "feat_x",
            "current_plan_handle": "free",
            "segment_ids": set(),
            "usage_balances": {},
        }
        canonical = derive_local_entitlement_from_configured_rules(playbook=pb, **kwargs)
        with pytest.warns(DeprecationWarning):
            legacy = derive_local_entitlement_from_configured_rules(exported_config=pb, **kwargs)
        assert canonical == legacy

    def test_entitlement_fallback_with_neither_returns_none(self) -> None:
        assert (
            derive_local_entitlement_from_configured_rules(
                handle="feat_x",
                current_plan_handle="free",
                segment_ids=set(),
                usage_balances={},
            )
            is None
        )


class TestHelperAlias:
    def test_configured_plan_name_alias_delegates_and_warns(self) -> None:
        pb = _playbook("pro")
        pb["plans"][0]["name"] = "Pro"
        assert configured_plan_name_from_playbook(pb, "pro") == "Pro"
        with pytest.warns(DeprecationWarning, match="configured_plan_name_from_exported_config"):
            assert configured_plan_name_from_exported_config(pb, "pro") == "Pro"
