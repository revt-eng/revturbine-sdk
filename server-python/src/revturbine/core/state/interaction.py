"""Pure interaction helpers — Python port of @revt-eng/core/state/interaction.ts.

Standalone functions that complement the stateful ``InteractionTracker``
class. Used directly by callers that want to compute keys or evaluate
suppression without instantiating the tracker.

Source: revturbine-scaffold/src/core/state/interaction.ts
"""

from __future__ import annotations

import time

from revturbine.core.state.types import InteractionState, SuppressionResult

__all__ = ["interaction_state_key", "suppression_for_state"]


def interaction_state_key(
    *,
    tenant_id: str,
    user_id: str,
    placement_id: str,
    treatment_id: str | None = None,
) -> str:
    """Generate the deterministic per-(tenant, user, placement, treatment) key
    used by ``InteractionTracker`` to look up suppression state.

    Source: interaction.ts:14-26
    """
    return ":".join([tenant_id, user_id, placement_id, treatment_id or "default"])


def suppression_for_state(
    state: InteractionState | None,
    now_ms: int | None = None,
) -> SuppressionResult:
    """Evaluate whether ``state`` indicates the user should be suppressed
    right now.

    ``now_ms`` defaults to the current epoch (ms). Passing it explicitly
    lets callers (and tests) freeze the clock.

    Source: interaction.ts:29-41
    """
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    if state is None or "suppressed_until" not in state:
        return SuppressionResult(suppressed=False)
    if state["suppressed_until"] <= now:
        return SuppressionResult(suppressed=False)
    reason = (
        "suppressed_until_remind_window"
        if state.get("last_interaction_type") == "remind_me_later"
        else "suppressed_by_dismiss_cooldown"
    )
    return SuppressionResult(suppressed=True, reason=reason)
