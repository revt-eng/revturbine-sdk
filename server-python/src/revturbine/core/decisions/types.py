"""Decision-engine value types — Python port of @revt-eng/core/decisions/models/types.ts.

Engine inputs, outputs, and configuration. The
``RevTurbinePlacementDecisionInput`` / ``...Decision`` /
``...Record`` shapes mirror the TS surface with snake-case field
names (per the project-wide naming convention) and the looser
JSON-shaped ``content``/``output`` slots that match the runtime
flow through the resolver pipeline.

Source: revturbine-scaffold/src/decisions/models/types.ts
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal, TypedDict

from revturbine.core.providers.types import ResolvedProviderContext

__all__ = [
    "DecisionContent",
    "DecisionEngineOptions",
    "EntitlementCheckResult",
    "EvaluationContext",
    "PlacementDecision",
    "PlacementDecisionInput",
    "PlacementRecord",
    "PlacementResolver",
]


# ── Engine options ──────────────────────────────────────────────────────────


class DecisionEngineOptions(TypedDict, total=False):
    """Behavior flags tuning ``DecisionEngine``.

    Source: types.ts:20-27
    """

    enable_caps_enforcement: bool
    enable_category_pipeline_local_mode: bool
    default_entitlement_policy: Literal["allow", "deny"]


# ── Entitlement check result ────────────────────────────────────────────────


class _EntitlementCheckResultRequired(TypedDict):
    status: Literal["allowed", "limited", "denied"]
    allowed: bool


class EntitlementCheckResult(_EntitlementCheckResultRequired, total=False):
    """Returned by ``DecisionEngine.check_entitlement``.

    Source: types.ts:33-41
    """

    reason: str
    limit: float
    used: float
    # plan 33 TASK-13: the ported entitlement-rule evaluator's
    # capability_tier branch emits `current_tier` (faithful to TS
    # entitlement-check.ts:199-208). Additive, total=False.
    current_tier: str
    remaining: float
    tier: str


# ── Placement input / output / decision ─────────────────────────────────────


class _PlacementDecisionInputRequired(TypedDict):
    placement_id: str
    user_id: str


class PlacementDecisionInput(_PlacementDecisionInputRequired, total=False):
    """Input to ``DecisionEngine.evaluate``.

    Source: core/types.ts ``RevTurbinePlacementDecisionInput``
    """

    traits: dict[str, Any]
    account_id: str
    product_instance_id: str
    overrides: dict[str, Any]


class _PlacementRecordRequired(TypedDict):
    placement_id: str
    name: str


class PlacementRecord(_PlacementRecordRequired, total=False):
    """Registered placement metadata used by the resolver to look up
    surface templates, entitlement handles, etc. Looser shape on the
    Python side — the strongly-typed Pydantic model would couple this
    module to the generated ``revturbine_types`` package, which
    server-python doesn't yet vendor (TASK-7).

    Source: core/types.ts ``RevTurbinePlacementRecord``
    """

    surface_template_ids: list[str]
    entitlement_handle: str


class _PlacementDecisionRequired(TypedDict):
    placement_id: str
    request_id: str
    visible: bool
    decision_source: Literal["cache", "fallback", "computed", "remote"]
    reason_codes: list[str]


class PlacementDecision(_PlacementDecisionRequired, total=False):
    """Output of ``DecisionEngine.evaluate``.

    The ``output`` and ``content`` slots stay loosely-typed
    (``dict[str, Any]``) — they're built up by the resolver pipeline
    in batch 2.

    Source: core/types.ts ``RevTurbinePlacementDecision``
    """

    suppression_reason: str
    output: dict[str, Any]
    content: DecisionContent


class DecisionContent(TypedDict, total=False):
    """Header / body / cta fields mirrored across both legacy and
    canonical naming. The TS engine emits both forms in its synthetic
    fallback content (``decisionContent`` helper).

    Source: engine.ts:37-39
    """

    header: str
    body: str
    cta_label: str
    title: str
    cta: str


# ── Evaluation context ──────────────────────────────────────────────────────


class _EvaluationContextRequired(TypedDict):
    providers: ResolvedProviderContext
    segment_ids: list[str]
    traits: dict[str, Any]


class EvaluationContext(_EvaluationContextRequired, total=False):
    """Intermediate context passed to the placement resolver. Built
    fresh per ``evaluate()`` call from provider state + input traits.

    Source: types.ts:47-56
    """

    plan_handle: str


# ── Placement resolver protocol ─────────────────────────────────────────────


PlacementResolver = Callable[
    [PlacementDecisionInput, "PlacementRecord | None", dict[str, Any]],
    PlacementDecision,
]
"""Sync callable that produces a ``PlacementDecision`` from input +
registered record + context. The TS-side resolver returns
``PlacementDecision | Promise<PlacementDecision>``; per Q-5 the
Python port stays sync (HTTP-mode resolvers would need an async
variant in TASK-7).

Source: core/types.ts ``PlacementResolver``
"""
