"""Plan 234 TASK-14 — the cap/cooldown maths move onto ONE primitive.

Two files:

- ``TestCharacterization`` pins the behaviour that was ALREADY identical
  across ports (the plan-233 #351 9-case matrix's surface). It passed
  before the refactor and must pass unchanged after it — that is the
  acceptance's "characterization test that passes before and after".
- ``TestAlignedWithCanonical`` pins the two behaviours the refactor
  ALIGNS to the TS canonical, found by reading both bodies side by side
  (REQ-1): (1) ``check_placement_caps`` exempts Fixed/Access-Gate
  categories (bucket <= 1) from per-payload caps — TS has done so since
  plan 167, this port never did; (2) the cap-deny path persists the
  UNFILTERED state — this port trimmed ``seen_at`` to the tripping
  window, silently shrinking future month/week windows. These tests were
  run RED against the pre-refactor body before the delegation landed.

Mutation proof (recorded in the PR): breaking ``evaluate_caps``'s window
arithmetic fails the characterization — the shared maths is actually
reached, not shadowed by a leftover local copy.
"""

from __future__ import annotations

from typing import Any, cast

from revturbine.core.helpers import PlacementOutput
from revturbine.core.placements.cap_rules import evaluate_caps
from revturbine.core.placements.placement_decision import (
    check_placement_caps,
    check_system_presentation_caps,
)
from revturbine.core.state.types import PresentationCapState, SurfaceTypeCapRule

DAY_MS = 24 * 60 * 60 * 1000
NOW = 1_700_000_000_000


def _output(category: str = "conversion", caps: dict[str, Any] | None = None) -> PlacementOutput:
    out: dict[str, Any] = {"output_id": "o1", "category": category, "content": {}}
    if caps is not None:
        out["caps"] = caps
    return out


def _sys_rule(
    period: str = "day", count: int = 2, cooldown_ms: int | None = None
) -> SurfaceTypeCapRule:
    rule: dict[str, Any] = {"surface_type": "banner", "rules": [{"period": period, "count": count}]}
    if cooldown_ms is not None:
        rule["cooldown_ms"] = cooldown_ms
    return cast("SurfaceTypeCapRule", rule)


class TestCharacterization:
    """The agreed surface — identical answers before and after delegation."""

    def test_no_policies_allows(self) -> None:
        assert check_placement_caps(_output(), "k", None, NOW)["allowed"] is True

    def test_payload_cap_hit_denies_with_period_reason(self) -> None:
        caps = {"max_per_period": {"period": "day", "count": 2}}
        state = PresentationCapState(seen_at=[NOW - 1000, NOW - 2000])
        result = check_placement_caps(_output(caps=caps), "k", state, NOW)
        assert result["allowed"] is False
        assert result["reason"] == "suppressed_by_payload_cap_day"

    def test_payload_under_cap_allows_and_appends_seen_at(self) -> None:
        caps = {"max_per_period": {"period": "day", "count": 2}}
        state = PresentationCapState(seen_at=[NOW - 1000])
        result = check_placement_caps(_output(caps=caps), "k", state, NOW)
        assert result["allowed"] is True
        assert result["updated_state"]["seen_at"] == [NOW - 1000, NOW]

    def test_stale_seen_at_outside_window_does_not_count(self) -> None:
        caps = {"max_per_period": {"period": "day", "count": 2}}
        state = PresentationCapState(seen_at=[NOW - 2 * DAY_MS, NOW - 1000])
        assert check_placement_caps(_output(caps=caps), "k", state, NOW)["allowed"] is True

    def test_active_payload_cooldown_denies(self) -> None:
        caps = {"max_per_period": {"period": "day", "count": 5}}
        state = PresentationCapState(seen_at=[], cooldown_until=NOW + 1000)
        result = check_placement_caps(_output(caps=caps), "k", state, NOW)
        assert result["allowed"] is False
        assert result["reason"] == "suppressed_by_payload_cooldown"

    def test_dismiss_sets_cooldown_until_from_max_policy(self) -> None:
        caps = {"max_per_period": {"period": "day", "count": 5}, "cooldown_days": 2}
        result = check_placement_caps(_output(caps=caps), "k", None, NOW, "dismiss")
        assert result["allowed"] is True
        assert result["updated_state"]["cooldown_until"] == NOW + 2 * DAY_MS

    def test_system_no_rules_allows(self) -> None:
        assert (
            check_system_presentation_caps(_output(), "banner", None, None, None, NOW)["allowed"]
            is True
        )

    def test_system_exempts_priority_categories(self) -> None:
        state = PresentationCapState(seen_at=[NOW - 1000, NOW - 2000])
        for category in ("gated", "fixed", "usage_limit", "trial"):
            result = check_system_presentation_caps(
                _output(category=category), "banner", [_sys_rule()], None, state, NOW
            )
            assert result["allowed"] is True, category

    def test_system_period_cap_denies_with_system_vocabulary(self) -> None:
        state = PresentationCapState(seen_at=[NOW - 1000, NOW - 2000])
        result = check_system_presentation_caps(
            _output(), "banner", [_sys_rule()], None, state, NOW
        )
        assert result["allowed"] is False
        assert result["reason"] == "suppressed_by_system_cap_day"

    def test_system_session_cooldown_denies_before_caps(self) -> None:
        state = PresentationCapState(seen_at=[NOW - 1000, NOW - 2000])
        result = check_system_presentation_caps(
            _output(), "banner", [_sys_rule()], 60_000, state, NOW
        )
        assert result["allowed"] is False
        assert result["reason"] == "suppressed_by_system_cooldown"

    def test_system_rule_cooldown_denies_after_caps_pass(self) -> None:
        state = PresentationCapState(seen_at=[NOW - 1000])
        result = check_system_presentation_caps(
            _output(), "banner", [_sys_rule(count=5, cooldown_ms=60_000)], None, state, NOW
        )
        assert result["allowed"] is False
        assert result["reason"] == "suppressed_by_system_cooldown"

    def test_system_unmatched_surface_type_allows(self) -> None:
        state = PresentationCapState(seen_at=[NOW - 1000, NOW - 2000])
        result = check_system_presentation_caps(_output(), "modal", [_sys_rule()], None, state, NOW)
        assert result["allowed"] is True


class TestAlignedWithCanonical:
    """Behaviours the delegation ALIGNS to TS — run red pre-refactor."""

    def test_fixed_and_gated_categories_exempt_from_payload_caps(self) -> None:
        # TS: checkPlacementCaps bucket <= 1 exemption (plan 167, spec
        # placement-prioritization-logic.md §5). The old py body capped them.
        caps = {"max_per_period": {"period": "day", "count": 1}}
        state = PresentationCapState(seen_at=[NOW - 1000])
        for category in ("fixed", "gated"):
            result = check_placement_caps(_output(category=category, caps=caps), "k", state, NOW)
            assert result["allowed"] is True, category

    def test_cap_deny_persists_unfiltered_state(self) -> None:
        # TS returns the whole (finite-filtered) state on a cap deny; the old
        # py body trimmed seen_at to the tripping window, silently shrinking
        # future week/month windows.
        caps = {"max_per_period": {"period": "day", "count": 2}}
        old = NOW - 20 * DAY_MS  # outside the day window, inside a month one
        state = PresentationCapState(seen_at=[old, NOW - 1000, NOW - 2000])
        result = check_placement_caps(_output(caps=caps), "k", state, NOW)
        assert result["allowed"] is False
        assert result["updated_state"]["seen_at"] == [old, NOW - 1000, NOW - 2000]


class TestEvaluateCapsPrimitive:
    """The ported primitive's own branches (mirrors cap-rules.ts cases)."""

    def test_session_cooldown(self) -> None:
        r = evaluate_caps(
            now=NOW, session_cooldown_minutes=5, last_session_presentation_at=NOW - 60_000
        )
        assert r == {"allowed": False, "reason": "session_cooldown"}

    def test_rule_lane_cap_hit_by_template(self) -> None:
        r = evaluate_caps(
            now=NOW,
            rules=[
                {
                    "id": "modals_per_day",
                    "group": [{"kind": "template", "id": "modal"}],
                    "cap": {"count": 3, "period": "day"},
                }
            ],
            candidate={"template_id": "modal"},
            counters={"modals_per_day:day": 3},
        )
        assert r["allowed"] is False and r["reason"] == "cap_hit"
        assert r["matched_rule_id"] == "modals_per_day"

    def test_rule_lane_non_matching_group_allows(self) -> None:
        r = evaluate_caps(
            now=NOW,
            rules=[
                {
                    "id": "modals_per_day",
                    "group": [{"kind": "slot", "id": "other"}],
                    "cap": {"count": 0, "period": "day"},
                }
            ],
            candidate={"template_id": "modal"},
            counters={},
        )
        assert r["allowed"] is True

    def test_per_payload_cooldown_before_caps(self) -> None:
        r = evaluate_caps(
            now=NOW,
            per_payload={
                "policies": [{"rules": [{"period": "day", "count": 0}]}],
                "seen_at": [],
                "cooldown_until": NOW + 1,
            },
        )
        assert r["reason"] == "suppressed_by_payload_cooldown"

    def test_per_payload_window_boundary_is_inclusive(self) -> None:
        r = evaluate_caps(
            now=NOW,
            per_payload={
                "policies": [{"rules": [{"period": "day", "count": 1}]}],
                "seen_at": [NOW - DAY_MS],  # exactly at the window start
            },
        )
        assert r["reason"] == "suppressed_by_payload_cap_day"
