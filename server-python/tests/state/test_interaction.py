"""Tests for ``revturbine.core.state.interaction`` (pure helpers)."""

from __future__ import annotations

from revturbine.core.state.interaction import (
    interaction_state_key,
    suppression_for_state,
)
from revturbine.core.state.types import InteractionState


class TestInteractionStateKey:
    def test_full_key(self) -> None:
        key = interaction_state_key(
            tenant_id="t1",
            user_id="u1",
            placement_id="p1",
            treatment_id="tr1",
        )
        assert key == "t1:u1:p1:tr1"

    def test_omitted_treatment_uses_default(self) -> None:
        key = interaction_state_key(tenant_id="t1", user_id="u1", placement_id="p1")
        assert key == "t1:u1:p1:default"

    def test_empty_treatment_uses_default(self) -> None:
        key = interaction_state_key(
            tenant_id="t1",
            user_id="u1",
            placement_id="p1",
            treatment_id="",
        )
        assert key == "t1:u1:p1:default"

    def test_keys_differ_per_dimension(self) -> None:
        a = interaction_state_key(tenant_id="t1", user_id="u1", placement_id="p1")
        b = interaction_state_key(tenant_id="t2", user_id="u1", placement_id="p1")
        c = interaction_state_key(tenant_id="t1", user_id="u2", placement_id="p1")
        d = interaction_state_key(tenant_id="t1", user_id="u1", placement_id="p2")
        e = interaction_state_key(
            tenant_id="t1",
            user_id="u1",
            placement_id="p1",
            treatment_id="x",
        )
        assert len({a, b, c, d, e}) == 5


class TestSuppressionForState:
    def test_none_state_not_suppressed(self) -> None:
        assert suppression_for_state(None, now_ms=1000) == {"suppressed": False}

    def test_state_without_suppressed_until(self) -> None:
        state: InteractionState = InteractionState(updated_at="2026-05-14T00:00:00Z")
        assert suppression_for_state(state, now_ms=1000) == {"suppressed": False}

    def test_expired_suppression(self) -> None:
        state: InteractionState = InteractionState(
            updated_at="2026-05-14T00:00:00Z",
            suppressed_until=500,
        )
        assert suppression_for_state(state, now_ms=1000) == {"suppressed": False}

    def test_boundary_equal_not_suppressed(self) -> None:
        # `<=` semantics: when suppressed_until == now, the suppression
        # has expired (mirrors TS).
        state: InteractionState = InteractionState(
            updated_at="2026-05-14T00:00:00Z",
            suppressed_until=1000,
        )
        assert suppression_for_state(state, now_ms=1000) == {"suppressed": False}

    def test_active_dismiss_suppression(self) -> None:
        state: InteractionState = InteractionState(
            updated_at="2026-05-14T00:00:00Z",
            suppressed_until=2000,
            last_interaction_type="dismiss",
        )
        result = suppression_for_state(state, now_ms=1000)
        assert result == {"suppressed": True, "reason": "suppressed_by_dismiss_cooldown"}

    def test_active_remind_later_suppression(self) -> None:
        state: InteractionState = InteractionState(
            updated_at="2026-05-14T00:00:00Z",
            suppressed_until=2000,
            last_interaction_type="remind_me_later",
        )
        result = suppression_for_state(state, now_ms=1000)
        assert result == {"suppressed": True, "reason": "suppressed_until_remind_window"}

    def test_no_last_interaction_falls_back_to_dismiss_reason(self) -> None:
        state: InteractionState = InteractionState(
            updated_at="2026-05-14T00:00:00Z",
            suppressed_until=2000,
        )
        result = suppression_for_state(state, now_ms=1000)
        assert result["reason"] == "suppressed_by_dismiss_cooldown"

    def test_default_now_ms_uses_real_clock(self) -> None:
        # Smoke: passing no now_ms should not error and should treat a
        # past suppressed_until as expired.
        state: InteractionState = InteractionState(
            updated_at="2026-05-14T00:00:00Z",
            suppressed_until=0,
        )
        assert suppression_for_state(state) == {"suppressed": False}
