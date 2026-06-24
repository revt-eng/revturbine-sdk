"""Tests for ``revturbine.core.runtime.local_runtime``.

Covers the ``LocalRuntime`` composition (TASK-6): a placement decision
served entirely in-process against a hand-built ``ExportedConfig`` with
zero network calls, storage/provider/identity wiring, and the
*deferred-leaf contract* — the segments/targeting/token methods whose
helpers are not ported MUST raise ``NotImplementedError`` naming the
scope boundary (out of headless-server scope — plan 33 REQ-14 non-goal)
rather than silently mis-deciding.
The entitlement-config fallback is no longer deferred — plan 33
TASK-13 wired the ported evaluator; it is asserted here instead.

Expected behavior traced from
revturbine-scaffold/src/core/runtime/local-runtime.ts and the engine
semantics asserted in tests/decisions/test_engine.py.
"""

from __future__ import annotations

from typing import Any

import pytest

from revturbine.core.decisions.types import (
    PlacementDecision,
    PlacementDecisionInput,
    PlacementRecord,
)
from revturbine.core.runtime import LocalRuntime
from revturbine.core.state import InMemoryStorage, InteractionTracker

EXPORTED_CONFIG: dict[str, Any] = {"placements": []}


def _stub_resolver_visible(
    input_data: PlacementDecisionInput,
    placement: PlacementRecord | None,
    context: dict[str, Any],
) -> PlacementDecision:
    """A resolver that always returns a visible decision — isolates the
    LocalRuntime wiring from the static-resolver candidate logic
    (TASK-5's tested surface). Mirrors test_engine.py's stub.
    """
    return PlacementDecision(
        placement_id=input_data["placement_id"],
        request_id="resolver-rid",
        visible=True,
        decision_source="computed",
        reason_codes=[],
        output={
            "output_id": "out_1",
            "surface": {"type": "banner"},
            "content": {"header": "Upgrade!"},
        },
        content={
            "header": "Upgrade!",
            "body": "",
            "cta_label": "Go",
            "title": "Upgrade!",
            "cta": "Go",
        },
    )


def _make_runtime(**overrides: Any) -> LocalRuntime:
    kwargs: dict[str, Any] = {
        "tenant_id": "tenant_abc",
        "user_id": "u1",
        "exported_config": EXPORTED_CONFIG,
        "providers": [],
    }
    kwargs.update(overrides)
    return LocalRuntime(**kwargs)


class TestLocalPlacementDecision:
    def test_serves_visible_decision_locally(self) -> None:
        runtime = _make_runtime(custom_resolver=_stub_resolver_visible)
        decision = runtime.get_placement_decision({"placement_id": "p1", "user_id": "u1"})
        assert decision["visible"] is True
        assert decision["placement_id"] == "p1"
        assert decision["content"]["header"] == "Upgrade!"

    def test_default_static_resolver_built_from_exported_config(self) -> None:
        # No custom resolver → _build_placement_resolver derives the
        # static resolver from exported_config["placements"]. An unknown
        # placement yields a structured invisible decision — proof the
        # default path constructs and decides with no error / no network.
        runtime = _make_runtime()
        decision = runtime.get_placement_decision(
            {"placement_id": "not_in_config", "user_id": "u1"}
        )
        assert decision["visible"] is False
        assert decision["placement_id"] == "not_in_config"

    def test_custom_resolver_takes_precedence_over_config(self) -> None:
        runtime = _make_runtime(
            exported_config={"placements": [{"placement_id": "p1"}]},
            custom_resolver=_stub_resolver_visible,
        )
        decision = runtime.get_placement_decision({"placement_id": "p1", "user_id": "u1"})
        assert decision["visible"] is True

    def test_batch_decisions_preserve_order(self) -> None:
        runtime = _make_runtime(custom_resolver=_stub_resolver_visible)
        decisions = runtime.get_placement_decisions(
            [
                {"placement_id": "a", "user_id": "u1"},
                {"placement_id": "b", "user_id": "u1"},
            ]
        )
        assert [d["placement_id"] for d in decisions] == ["a", "b"]


class TestComposition:
    def test_default_storage_is_in_memory(self) -> None:
        runtime = _make_runtime()
        assert isinstance(runtime.interaction_tracker, InteractionTracker)

    def test_injected_storage_flows_through_suppression(self) -> None:
        storage = InMemoryStorage()
        runtime = _make_runtime(storage=storage, custom_resolver=_stub_resolver_visible)
        # Without the dismiss the stub makes p1 visible …
        assert (
            runtime.get_placement_decision({"placement_id": "p1", "user_id": "u1"})["visible"]
            is True
        )
        # … a dismiss recorded through the injected storage suppresses it.
        runtime.track_interaction(
            {"user_id": "u1", "placement_id": "p1", "interaction_type": "dismiss"}
        )
        assert (
            runtime.get_placement_decision({"placement_id": "p1", "user_id": "u1"})["visible"]
            is False
        )

    def test_register_placement_keyed_by_placement_id(self) -> None:
        runtime = _make_runtime()
        record: PlacementRecord = PlacementRecord(placement_id="p1", name="Upgrade Banner")
        runtime.register_placement(record)
        # Locks the TS .id → Python .placement_id key rename: the engine
        # shares this exact dict object for its lookups.
        assert runtime._registered_placements["p1"]["name"] == "Upgrade Banner"

    def test_interaction_options_reach_tracker(self) -> None:
        runtime = _make_runtime(interaction_options={"default_dismiss_cooldown_ms": 99999})
        assert runtime.interaction_tracker._default_dismiss_cooldown_ms == 99999

    def test_hydrate_is_safe(self) -> None:
        runtime = _make_runtime()
        runtime.hydrate()  # No raise with the default InMemoryImpressionStore.

    def test_resolve_providers_empty_is_dict(self) -> None:
        runtime = _make_runtime()
        assert runtime.resolve_providers() == {}
        runtime.update_providers([])
        assert runtime.resolve_providers() == {}


class TestIdentityAndConfig:
    def test_user_identity_switch(self) -> None:
        runtime = _make_runtime()
        assert runtime.get_user_id() == "u1"
        runtime.set_user_id("u2")
        assert runtime.get_user_id() == "u2"

    def test_get_exported_config_returns_snapshot(self) -> None:
        cfg: dict[str, Any] = {"placements": []}
        runtime = _make_runtime(exported_config=cfg)
        assert runtime.get_exported_config() is cfg

    def test_clear_suppression_defaults_to_current_user(self) -> None:
        runtime = _make_runtime(custom_resolver=_stub_resolver_visible)
        runtime.track_interaction(
            {"user_id": "u1", "placement_id": "p1", "interaction_type": "dismiss"}
        )
        runtime.clear_suppression("p1")  # user_id defaults to self._user_id
        assert (
            runtime.get_placement_decision({"placement_id": "p1", "user_id": "u1"})["visible"]
            is True
        )


class TestDeferredLeafContract:
    """The still-deferred leaves (segments / targeting / tokens) must
    fail loudly naming the scope boundary (out of headless-server scope
    — plan 33 REQ-14 non-goal) — a silent default would mis-decide. The
    entitlement-config fallback is NO LONGER deferred: plan 33 TASK-13
    wired the ported evaluator.
    """

    def test_check_entitlement_no_provider_runs_config_fallback(self) -> None:
        # No entitlements provider → engine returns no_entitlement_provider
        # → LocalRuntime fallback runs the ported reconciled evaluator.
        # Empty config ⇒ no matching rule ⇒ denied (fail closed; TASK-13,
        # faithful to deriveLocalEntitlementFromConfiguredRules).
        runtime = _make_runtime()
        assert runtime.check_entitlement("feature_x") == {
            "status": "denied",
            "allowed": False,
            "reason": "no_matching_entitlement_rule",
        }

    @pytest.mark.parametrize(
        "call",
        [
            lambda r: r.evaluate_segments({"plan": "pro"}),
            lambda r: r.build_targeting_state({}),
            lambda r: r.derive_personalization_tokens(),
        ],
    )
    def test_segment_targeting_token_leaves_are_headless_non_goals(self, call: Any) -> None:
        runtime = _make_runtime()
        with pytest.raises(NotImplementedError, match="headless server SDK scope"):
            call(runtime)
