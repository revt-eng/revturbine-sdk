"""Public-API tests for ``revturbine.RevTurbineCustomerSdk`` (plan 33
TASK-7, narrowed headless-server scope).

The load-bearing property is **output-transparency**: the SDK adds zero
decision logic, so for the same ``(user_context, exported_config)`` it
must return results byte-equal to the parity-locked substrate it wraps
(``create_static_providers`` + ``LocalRuntime``). That equality is
exactly why ``tests/parity/py_runner.py`` can drive this public class
and keep the cross-language gate green; these tests assert it directly
in-tree so a wrapper regression fails here before the parity gate.

Also asserts the narrowed-scope contract: the only required identity is
``tenant_id`` / ``user_id``; there is no storage injection point
(stateless, in-memory by construction); and the new SDK is independent
of the legacy ``revturbine_server`` thin-RPC client — a *separate*
top-level package, left unchanged, not folded in (supersedes the
original AC-11 dual-mode framing). Plan 33 REQ-4 / TASK-2 has since
landed: the scaffold-generated Pydantic models are vendored as
``revturbine.types``, so ``revturbine_server`` now imports cleanly —
the prior "out-of-scope canary" assertion is replaced by asserting that
resolved state.
"""

from __future__ import annotations

import importlib
import inspect
from collections.abc import Mapping, Sequence
from typing import Any

import pytest

from revturbine import RevTurbineCustomerSdk, UserContext
from revturbine.core.adapters import create_static_providers
from revturbine.core.decisions import PlacementDecisionInput
from revturbine.core.runtime import LocalRuntime


def _config() -> dict[str, Any]:
    """A minimal in-process ExportedConfig: two entitlements + one
    placement. No network, no persistence — the headless model.
    """
    return {
        "version": "1.0.0",
        "plans": [],
        "entitlements": [
            {"unique_handle": "feat_x", "unit": None},
            {"unique_handle": "credits", "unit": "credit"},
        ],
        "entitlement_rules": [],
        "segments": [],
        "content_ui_paths": [],
        "placements": [{"placement_id": "pl_known", "name": "Known"}],
    }


def _user_ctx(**overrides: Any) -> UserContext:
    ctx: UserContext = {"tenant_id": "tenant_t", "user_id": "user_u"}
    ctx.update(overrides)  # type: ignore[typeddict-item]
    return ctx


def _strip_request_id(decision: Mapping[str, Any]) -> dict[str, Any]:
    """``request_id`` is the only non-deterministic field on a
    PlacementDecision: the local resolver computes it from
    ``time.time() * 1000`` per item, so two equivalent SDK instances
    invoked sequentially can land on different millisecond boundaries
    and produce non-identical decisions even when every other field
    matches. Output-transparency cares about the decision content, not
    the opaque correlation id — strip it before comparing.

    Accepts ``Mapping`` so TypedDict subclasses (PlacementDecision)
    satisfy the parameter without an explicit cast.
    """
    return {k: v for k, v in decision.items() if k != "request_id"}


def _strip_request_ids(decisions: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [_strip_request_id(d) for d in decisions]


def _reference_runtime(ctx: UserContext, cfg: dict[str, Any]) -> LocalRuntime:
    """Compose the substrate exactly as ``RevTurbineCustomerSdk`` does —
    the oracle the wrapper must be byte-equal to.
    """
    providers = create_static_providers(
        config=cfg,
        plan_handle=ctx.get("plan_handle"),
        plan_name=ctx.get("plan_name"),
        usage=ctx.get("usage"),
    )
    return LocalRuntime(
        tenant_id=ctx["tenant_id"],
        user_id=ctx["user_id"],
        exported_config=cfg,
        providers=providers,
    )


class TestPublicSurface:
    def test_exports_and_methods_present(self) -> None:
        sdk = RevTurbineCustomerSdk(user_context=_user_ctx(), exported_config=_config())
        for name in (
            "check_entitlement",
            "get_placement_decision",
            "get_placement_decisions",
        ):
            assert callable(getattr(sdk, name))

    def test_construct_requires_tenant_and_user(self) -> None:
        cfg = _config()
        for bad in ({"user_id": "u"}, {"tenant_id": "t"}, {"tenant_id": "", "user_id": "u"}):
            with pytest.raises(ValueError, match="tenant_id.*user_id"):
                RevTurbineCustomerSdk(
                    user_context=bad,  # type: ignore[arg-type]
                    exported_config=cfg,
                )

    def test_no_storage_injection_point(self) -> None:
        # The stateless / in-memory contract is enforced by the absence
        # of any persistence parameter: the constructor takes exactly
        # the two server-supplied inputs, keyword-only.
        params = inspect.signature(RevTurbineCustomerSdk).parameters
        assert set(params) == {"user_context", "exported_config"}
        for p in params.values():
            assert p.kind is inspect.Parameter.KEYWORD_ONLY
        assert "storage" not in params and "impression_store" not in params

    def test_future_playbook_format_rejects_before_evaluation(self) -> None:
        cfg = _config()
        cfg.update(
            {
                "artifact_type": "playbook",
                "format_version": "2.0.0",
                "playbook_handle": "default",
                "playbook_version_id": None,
                "tenant_id": "tenant_t",
                "environment_id": "default",
            }
        )
        with pytest.raises(ValueError, match='unsupported "format_version"'):
            RevTurbineCustomerSdk(user_context=_user_ctx(), exported_config=cfg)


class TestOutputTransparency:
    """Every method == the wrapped ``LocalRuntime`` for the same inputs."""

    def test_check_entitlement_matches_localruntime(self) -> None:
        cfg = _config()
        ctx = _user_ctx(usage={"credits": {"used": 3.0, "limit": 10.0}})
        sdk = RevTurbineCustomerSdk(user_context=ctx, exported_config=cfg)
        ref = _reference_runtime(ctx, cfg)
        for handle in ("feat_x", "credits", "not_configured"):
            assert sdk.check_entitlement(handle) == ref.check_entitlement(handle)

    def test_get_placement_decision_matches_localruntime(self) -> None:
        cfg = _config()
        ctx = _user_ctx()
        sdk = RevTurbineCustomerSdk(user_context=ctx, exported_config=cfg)
        ref = _reference_runtime(ctx, cfg)
        for pid in ("pl_known", "does_not_exist"):
            inp: PlacementDecisionInput = {"placement_id": pid, "user_id": "user_u"}
            assert _strip_request_id(sdk.get_placement_decision(inp)) == _strip_request_id(
                ref.get_placement_decision(inp),
            )

    def test_get_placement_decisions_batch_order_and_transparency(self) -> None:
        cfg = _config()
        ctx = _user_ctx()
        sdk = RevTurbineCustomerSdk(user_context=ctx, exported_config=cfg)
        ref = _reference_runtime(ctx, cfg)
        inputs: list[PlacementDecisionInput] = [
            {"placement_id": "pl_known", "user_id": "user_u"},
            {"placement_id": "does_not_exist", "user_id": "user_u"},
        ]
        got = sdk.get_placement_decisions(inputs)
        assert _strip_request_ids(got) == _strip_request_ids(ref.get_placement_decisions(inputs))
        assert [d["placement_id"] for d in got] == ["pl_known", "does_not_exist"]

    def test_two_instances_decide_identically(self) -> None:
        # Stateless: independent instances over equal inputs agree.
        cfg = _config()
        ctx = _user_ctx()
        a = RevTurbineCustomerSdk(user_context=ctx, exported_config=cfg)
        b = RevTurbineCustomerSdk(user_context=ctx, exported_config=cfg)
        assert a.check_entitlement("feat_x") == b.check_entitlement("feat_x")


class TestLegacyClientCoexistence:
    def test_revturbine_types_vendored_and_legacy_client_imports(self) -> None:
        # plan 33 REQ-4 / TASK-2 landed: the scaffold-generated Pydantic
        # models are vendored as `revturbine.types`, so the legacy
        # `revturbine_server` (`from revturbine.types import
        # ServerEvaluationPayload, ...`) now imports cleanly. Replaces
        # the prior canary that pinned the pre-TASK-2 breakage.
        from revturbine.types import (
            ServerEvaluationPayload,
            ServerEvaluationPayloadDecisionsItem,
            ServerEvaluationPayloadEntitlementsValue,
            ServerEvaluationPayloadTrialStatus,
            ServerEvaluationPayloadUser,
            ServerEvaluationPayloadUserContext,
        )

        for cls in (
            ServerEvaluationPayload,
            ServerEvaluationPayloadDecisionsItem,
            ServerEvaluationPayloadEntitlementsValue,
            ServerEvaluationPayloadTrialStatus,
            ServerEvaluationPayloadUser,
            ServerEvaluationPayloadUserContext,
        ):
            assert isinstance(cls, type)

        legacy = importlib.import_module("revturbine_server")
        assert legacy.__name__ == "revturbine_server"
        assert hasattr(legacy, "RevTurbineServer")

        # Still independent: distinct top-level package; the headless SDK
        # does not require the legacy client.
        revturbine = importlib.import_module("revturbine")
        assert legacy is not revturbine
        assert hasattr(revturbine, "RevTurbineCustomerSdk")
