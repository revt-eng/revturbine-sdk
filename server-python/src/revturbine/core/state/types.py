"""State value types — Python port of @revt-eng/core/state/types.ts.

Mirrors the TS interfaces / type aliases used by ``InteractionTracker`` and
``CapEnforcer``. The cap-period vocabulary is shared with the helpers
module via ``revturbine.core.helpers.CapPeriod``.

Source: revturbine-scaffold/src/core/state/types.ts
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from revturbine.core.helpers import CapPeriod, PlacementCapRule

__all__ = [
    "CapEnforcementResult",
    "InteractionState",
    "PlacementCapPolicy",
    "PresentationCapState",
    "RevTurbineTreatmentInteractionInput",
    "RevTurbineTreatmentInteractionType",
    "SuppressionResult",
    "SurfaceTypeCapRule",
    # Re-exports for parity with the TS module shape — the TS-side
    # `parseCapRule` lives in helpers.ts, so the Python port keeps the
    # type aliases there too. Re-exporting from `state.types` lets
    # callers depend on a single import path mirroring the TS surface.
    "CapPeriod",
    "PlacementCapRule",
]


# ── Treatment interaction types ─────────────────────────────────────────────


RevTurbineTreatmentInteractionType = Literal[
    "impression",
    "dismiss",
    "remind_me_later",
    "cta_clicked",
    "cta_completed",
    "suppress",
]


class _TreatmentInteractionRequired(TypedDict):
    user_id: str
    placement_id: str
    interaction_type: RevTurbineTreatmentInteractionType


class RevTurbineTreatmentInteractionInput(_TreatmentInteractionRequired, total=False):
    """Input shape for ``InteractionTracker.track``.

    Source: types.ts:21-30
    """

    treatment_id: str
    interaction_at: str
    metadata: dict[str, Any]


# ── Interaction state (dismissal tracking) ──────────────────────────────────


class _InteractionStateRequired(TypedDict):
    updated_at: str


class InteractionState(_InteractionStateRequired, total=False):
    """Per-(tenant, user, placement, treatment) suppression state.

    Source: types.ts:36-43
    """

    suppressed_until: int
    last_interaction_type: RevTurbineTreatmentInteractionType


# ── Presentation cap types ──────────────────────────────────────────────────


class _PlacementCapPolicyRequired(TypedDict):
    rules: list[PlacementCapRule]


class PlacementCapPolicy(_PlacementCapPolicyRequired, total=False):
    """A bundle of cap rules + an optional cooldown for one placement output.

    Source: types.ts:56-59
    """

    cooldown_ms: int


class _PresentationCapStateRequired(TypedDict):
    seen_at: list[int]


class PresentationCapState(_PresentationCapStateRequired, total=False):
    """Per-(tenant, user, surface, output) presentation history.

    Source: types.ts:61-66
    """

    cooldown_until: int


class _SurfaceTypeCapRuleRequired(TypedDict):
    surface_type: str
    rules: list[PlacementCapRule]


class SurfaceTypeCapRule(_SurfaceTypeCapRuleRequired, total=False):
    """System-level cap rule for a surface type — applied to discretionary
    placements only.

    Source: types.ts:77-81
    """

    cooldown_ms: int


# ── Suppression / enforcement results ───────────────────────────────────────


class _SuppressionResultRequired(TypedDict):
    suppressed: bool


class SuppressionResult(_SuppressionResultRequired, total=False):
    """Returned from ``InteractionTracker.check_suppression``.

    Source: types.ts:87-90
    """

    reason: str


class _CapEnforcementResultRequired(TypedDict):
    allowed: bool


class CapEnforcementResult(_CapEnforcementResultRequired, total=False):
    """Returned from ``CapEnforcer.enforce``.

    Source: types.ts:96-99
    """

    reason: str
