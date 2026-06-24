"""Tests for ``revturbine.core.placements.placement_decision``.

Covers all 14 ported functions plus a pilot-corpus block extending the
TASK-5 entitlement + payload pilots into the decision-lifecycle surface.
Expected values traced from
revturbine-scaffold/src/placements/controllers/placement-decision.ts.
"""

from __future__ import annotations

from typing import Any

import pytest

from revturbine.core.placements.placement_decision import (
    DecisionCacheKeyInput,
    SlotDecision,
    apply_category_conflict_suppression,
    apply_milestone_supersession,
    apply_milestone_supersession_with_metadata,
    check_placement_caps,
    check_system_presentation_caps,
    decision_cache_key,
    extract_placement_cap_policies,
    filter_one_discretionary,
    local_placement_lookup_key,
    normalize_decision_from_response,
    resolve_local_placement_from_candidates,
)
from revturbine.core.state.types import PresentationCapState, SurfaceTypeCapRule


def _out(
    output_id: str,
    *,
    category: str = "upsell",
    template: str | None = "banner_tpl",
    surface_type: str = "banner",
    content: dict[str, Any] | None = None,
) -> dict[str, Any]:
    surface: dict[str, Any] = {"type": surface_type}
    if template is not None:
        surface["template"] = template
    return {
        "output_id": output_id,
        "category": category,
        "surface": surface,
        "content": content or {},
    }


# ── local_placement_lookup_key ──────────────────────────────────────────────


class TestLocalPlacementLookupKey:
    def test_full(self) -> None:
        assert (
            local_placement_lookup_key(
                {
                    "slot_id": "s",
                    "surface_type": "banner",
                    "entitlement_handle": "e",
                    "plan_handle": "pro",
                    "placement_handle": "ph",
                }
            )
            == "s::banner::e::pro::ph"
        )

    def test_empty_segments(self) -> None:
        assert local_placement_lookup_key({"slot_id": "s"}) == "s::::::::"

    def test_all_empty(self) -> None:
        assert local_placement_lookup_key({}) == "::::::::"


# ── decision_cache_key ──────────────────────────────────────────────────────


class TestDecisionCacheKey:
    def test_deterministic_and_prefixed(self) -> None:
        inp: DecisionCacheKeyInput = {
            "tenant_id": "t",
            "placement_id": "p",
            "user_id": "u",
            "route": "/dash/",
        }
        k1 = decision_cache_key(inp)
        k2 = decision_cache_key(inp)
        assert k1 == k2
        assert k1.startswith("t:p:u:")

    def test_route_normalized_into_key(self) -> None:
        x: DecisionCacheKeyInput = {
            "tenant_id": "t",
            "placement_id": "p",
            "user_id": "u",
            "route": "/X/",
        }
        y: DecisionCacheKeyInput = {
            "tenant_id": "t",
            "placement_id": "p",
            "user_id": "u",
            "route": "/x",
        }
        # normalized_route lowercases + strips trailing slash → same key.
        assert decision_cache_key(x) == decision_cache_key(y)

    def test_different_traits_differ(self) -> None:
        a: DecisionCacheKeyInput = {
            "tenant_id": "t",
            "placement_id": "p",
            "user_id": "u",
            "route": "/x",
            "traits": {"plan": "pro"},
        }
        b: DecisionCacheKeyInput = {**a, "traits": {"plan": "free"}}
        assert decision_cache_key(a) != decision_cache_key(b)

    def test_runtime_fingerprint_included_when_present(self) -> None:
        base: DecisionCacheKeyInput = {
            "tenant_id": "t",
            "placement_id": "p",
            "user_id": "u",
            "route": "/x",
        }
        a = decision_cache_key(base)
        b = decision_cache_key({**base, "runtime_context_fingerprint": "fp1"})
        assert a != b


# ── apply_milestone_supersession ────────────────────────────────────────────


class TestApplyMilestoneSupersession:
    def test_single_unchanged(self) -> None:
        outs = [_out("a")]
        assert apply_milestone_supersession(outs) == outs

    def test_version_supersession(self) -> None:
        newer = _out("new", content={"supersedes_template_version": ["v1"]})
        older = _out("old", content={"template_version": "v1"})
        survivors = apply_milestone_supersession([newer, older])
        ids = {o["output_id"] for o in survivors}
        assert ids == {"new"}

    def test_no_supersession_when_template_differs(self) -> None:
        newer = _out(
            "new",
            template="tpl_a",
            content={"supersedes_template_version": ["v1"]},
        )
        older = _out("old", template="tpl_b", content={"template_version": "v1"})
        survivors = apply_milestone_supersession([newer, older])
        assert {o["output_id"] for o in survivors} == {"new", "old"}

    def test_milestone_order_keeps_highest(self) -> None:
        a = _out("a", content={"milestone_order": 1})
        b = _out("b", content={"milestone_order": 3})
        c = _out("c", content={"milestone_order": 2})
        survivors = apply_milestone_supersession([a, b, c])
        assert {o["output_id"] for o in survivors} == {"b"}

    def test_outputs_without_template_skipped(self) -> None:
        a = _out("a", template=None, content={"milestone_order": 1})
        b = _out("b", template=None, content={"milestone_order": 9})
        # No template → not grouped → both survive.
        survivors = apply_milestone_supersession([a, b])
        assert {o["output_id"] for o in survivors} == {"a", "b"}


# ── apply_category_conflict_suppression ─────────────────────────────────────


class TestApplyCategoryConflictSuppression:
    def test_single_unchanged(self) -> None:
        outs = [_out("a")]
        assert apply_category_conflict_suppression(outs) == outs

    def test_lower_bucket_wins(self) -> None:
        gated = _out("g", category="gated")  # bucket 0
        upsell = _out("u", category="upsell")  # bucket 4
        survivors = apply_category_conflict_suppression([gated, upsell])
        assert {o["output_id"] for o in survivors} == {"g"}

    def test_same_bucket_both_survive(self) -> None:
        a = _out("a", category="upsell")
        b = _out("b", category="conversion")  # also bucket 4
        survivors = apply_category_conflict_suppression([a, b])
        assert {o["output_id"] for o in survivors} == {"a", "b"}

    def test_different_surface_type_not_in_conflict(self) -> None:
        a = _out("a", category="gated", surface_type="banner")
        b = _out("b", category="upsell", surface_type="modal")
        survivors = apply_category_conflict_suppression([a, b])
        assert {o["output_id"] for o in survivors} == {"a", "b"}

    def test_right_lower_suppresses_left(self) -> None:
        # left=upsell(4), right=gated(0) → left suppressed.
        left = _out("L", category="upsell")
        right = _out("R", category="gated")
        survivors = apply_category_conflict_suppression([left, right])
        assert {o["output_id"] for o in survivors} == {"R"}


# ── resolve_local_placement_from_candidates ─────────────────────────────────


class TestResolveLocalPlacement:
    def test_empty_returns_none(self) -> None:
        assert resolve_local_placement_from_candidates([]) is None

    def test_fixed_only_filter(self) -> None:
        fixed = _out("f", category="fixed")  # bucket 1
        other = _out("o", category="upsell")
        result = resolve_local_placement_from_candidates(
            [fixed, other], options={"fixed_only": True}
        )
        assert result is not None and result["output_id"] == "f"

    def test_fixed_only_none_match(self) -> None:
        assert (
            resolve_local_placement_from_candidates(
                [_out("o", category="upsell")], options={"fixed_only": True}
            )
            is None
        )

    def test_category_bucket_orders_winner(self) -> None:
        gated = _out("g", category="gated")
        upsell = _out("u", category="upsell")
        winner = resolve_local_placement_from_candidates([upsell, gated])
        assert winner is not None and winner["output_id"] == "g"

    def test_server_order_wins_when_present(self) -> None:
        a = _out("a", category="upsell", content={"server_order": 5})
        b = _out("b", category="gated", content={"server_order": 1})
        # explicit server_order present → ordered by it, ignoring buckets.
        winner = resolve_local_placement_from_candidates([a, b])
        assert winner is not None and winner["output_id"] == "b"

    def test_score_tiebreak_within_bucket(self) -> None:
        a = _out("a", category="upsell", content={"score": 10})
        b = _out("b", category="upsell", content={"score": 99})
        winner = resolve_local_placement_from_candidates([a, b])
        assert winner is not None and winner["output_id"] == "b"

    def test_output_id_localecompare_final_tiebreak(self) -> None:
        a = _out("zzz", category="upsell")
        b = _out("aaa", category="upsell")
        # All scores equal → lexicographic output_id ascending.
        winner = resolve_local_placement_from_candidates([a, b])
        assert winner is not None and winner["output_id"] == "aaa"

    def test_proximity_score_priority_tier(self) -> None:
        # bucket 2 (usage) → proximity ranks.
        a = _out("a", category="usage", content={"usage_percent": 50})
        b = _out("b", category="usage", content={"usage_percent": 90})
        winner = resolve_local_placement_from_candidates([a, b])
        assert winner is not None and winner["output_id"] == "b"

    def test_server_order_present_vs_absent_orders_present_first(self) -> None:
        # One candidate has server_order, the other doesn't → the one
        # with server_order sorts first (comparator: lo not None, ro None).
        a = _out("a", category="upsell", content={"server_order": 7})
        b = _out("b", category="upsell")  # no server_order
        winner = resolve_local_placement_from_candidates([b, a])
        assert winner is not None and winner["output_id"] == "a"

    def test_equal_server_order_falls_through_to_bucket(self) -> None:
        # Both have the same server_order → tie → fall through to
        # category-bucket ordering (gated bucket 0 wins).
        a = _out("a", category="upsell", content={"server_order": 1})
        b = _out("b", category="gated", content={"server_order": 1})
        winner = resolve_local_placement_from_candidates([a, b])
        assert winner is not None and winner["output_id"] == "b"

    def test_priority_tiebreak_after_equal_score(self) -> None:
        # Same bucket, same score → placement_priority breaks the tie
        # (higher priority wins; comparator's priority branch).
        a = _out("a", category="upsell", content={"score": 5, "priority": 1})
        b = _out("b", category="upsell", content={"score": 5, "priority": 9})
        winner = resolve_local_placement_from_candidates([a, b])
        assert winner is not None and winner["output_id"] == "b"


# ── normalize_decision_from_response ────────────────────────────────────────


class TestNormalizeDecisionFromResponse:
    def test_defaults_when_empty(self) -> None:
        d = normalize_decision_from_response("p", "rid", "Name", {})
        assert d["placement_id"] == "p"
        assert d["request_id"] == "rid"
        assert d["visible"] is True
        assert d["decision_source"] == "remote"
        assert d["reason_codes"] == []
        assert d["content"]["title"] == "Name recommendation"
        assert d["content"]["cta"] == "Continue"

    def test_visible_from_decision(self) -> None:
        d = normalize_decision_from_response("p", "rid", "N", {"decision": {"visible": False}})
        assert d["visible"] is False

    def test_visible_from_root_when_decision_absent(self) -> None:
        d = normalize_decision_from_response("p", "rid", "N", {"visible": False})
        assert d["visible"] is False

    def test_request_id_from_payload(self) -> None:
        d = normalize_decision_from_response("p", "fallback", "N", {"request_id": "server-rid"})
        assert d["request_id"] == "server-rid"

    def test_reason_codes_filtered_to_strings(self) -> None:
        d = normalize_decision_from_response(
            "p", "rid", "N", {"reason_codes": ["ok", 1, None, "two"]}
        )
        assert d["reason_codes"] == ["ok", "two"]

    def test_content_from_root_over_decision(self) -> None:
        d = normalize_decision_from_response(
            "p",
            "rid",
            "N",
            {
                "content": {"title": "RootTitle", "body": "B", "cta": "C"},
                "decision": {"content": {"title": "DecTitle"}},
            },
        )
        assert d["content"]["title"] == "RootTitle"

    def test_content_falls_back_to_decision_content(self) -> None:
        d = normalize_decision_from_response(
            "p", "rid", "N", {"decision": {"content": {"title": "DecTitle"}}}
        )
        assert d["content"]["title"] == "DecTitle"

    def test_non_dict_payload(self) -> None:
        d = normalize_decision_from_response("p", "rid", "Name", "garbage")
        assert d["visible"] is True
        assert d["content"]["title"] == "Name recommendation"


# ── extract_placement_cap_policies ──────────────────────────────────────────


class TestExtractPlacementCapPolicies:
    def test_no_caps(self) -> None:
        assert extract_placement_cap_policies(_out("a")) == []

    def test_caps_at_root(self) -> None:
        out = _out("a")
        out["caps"] = {"max_per_period": {"count": 2, "period": "day"}}
        policies = extract_placement_cap_policies(out)
        assert len(policies) == 1
        assert policies[0]["rules"][0]["count"] == 2

    def test_caps_at_content_payload_with_cooldown(self) -> None:
        out = _out(
            "a",
            content={
                "payload": {
                    "caps": {
                        "max_per_period": {"count": 1, "period": "week"},
                        "cooldown_days": 3,
                    },
                },
            },
        )
        policies = extract_placement_cap_policies(out)
        assert len(policies) == 1
        assert policies[0]["cooldown_ms"] == 3 * 24 * 60 * 60 * 1000

    def test_invalid_cap_rule_yields_empty_rules(self) -> None:
        out = _out("a")
        out["caps"] = {"max_per_period": {"count": 0, "period": "day"}}
        policies = extract_placement_cap_policies(out)
        assert policies == [{"rules": []}]

    def test_zero_cooldown_days_not_set(self) -> None:
        out = _out("a")
        out["caps"] = {"cooldown_days": 0}
        policies = extract_placement_cap_policies(out)
        assert "cooldown_ms" not in policies[0]


# ── check_placement_caps ────────────────────────────────────────────────────


class TestCheckPlacementCaps:
    def _capped(self, count: int = 2) -> dict[str, Any]:
        out = _out("a")
        out["caps"] = {"max_per_period": {"count": count, "period": "day"}}
        return out

    def test_no_policies_allowed(self) -> None:
        assert check_placement_caps(_out("a"), "k", None, 1000) == {"allowed": True}

    def test_within_cap_records_seen_at(self) -> None:
        r = check_placement_caps(self._capped(), "k", None, 1000)
        assert r["allowed"] is True
        assert r["updated_state"]["seen_at"] == [1000]

    def test_cap_exceeded(self) -> None:
        state: PresentationCapState = {"seen_at": [1, 2]}
        r = check_placement_caps(self._capped(count=2), "k", state, 1000)
        assert r["allowed"] is False
        assert r["reason"] == "suppressed_by_payload_cap_day"

    def test_active_cooldown_denies(self) -> None:
        state: PresentationCapState = {"seen_at": [], "cooldown_until": 5000}
        r = check_placement_caps(self._capped(), "k", state, 1000)
        assert r["allowed"] is False
        assert r["reason"] == "suppressed_by_payload_cooldown"

    def test_cooldown_only_applied_on_dismiss(self) -> None:
        out = _out("a")
        out["caps"] = {
            "max_per_period": {"count": 9, "period": "day"},
            "cooldown_days": 1,
        }
        # impression → no cooldown set
        imp = check_placement_caps(out, "k", None, 1000, "impression")
        assert "cooldown_until" not in imp["updated_state"]
        # dismiss → cooldown set
        dis = check_placement_caps(out, "k", None, 1000, "dismiss")
        assert dis["updated_state"]["cooldown_until"] == 1000 + 24 * 60 * 60 * 1000

    def test_malformed_seen_at_filtered(self) -> None:
        # Deliberately malformed seen_at (mixed types) — exercises the
        # defensive filter; typed loosely on purpose.
        state: Any = {"seen_at": [-1, 0, "x", 500]}
        r = check_placement_caps(self._capped(count=5), "k", state, 1000)
        # only 500 is valid; new now appended.
        assert r["updated_state"]["seen_at"] == [500, 1000]

    def test_cap_exceeded_trimmed_state_preserves_cooldown(self) -> None:
        # When the cap is hit, the returned trimmed state must carry an
        # existing (future) cooldown_until forward — not silently drop it.
        state: PresentationCapState = {"seen_at": [1, 2], "cooldown_until": 999}
        r = check_placement_caps(self._capped(count=2), "k", state, 1000)
        assert r["allowed"] is False
        assert r["reason"] == "suppressed_by_payload_cap_day"
        assert r["updated_state"]["cooldown_until"] == 999


# ── check_system_presentation_caps ──────────────────────────────────────────


class TestCheckSystemPresentationCaps:
    def test_no_rules_allowed(self) -> None:
        assert check_system_presentation_caps(_out("a", category="upsell"), "banner") == {
            "allowed": True
        }

    def test_deterministic_category_exempt(self) -> None:
        rules: list[SurfaceTypeCapRule] = [
            {"surface_type": "banner", "rules": [{"count": 1, "period": "day"}]}
        ]
        # gated = bucket 0 ≤ 3 → exempt.
        assert check_system_presentation_caps(
            _out("a", category="gated"), "banner", rules, now_ms=1000
        ) == {"allowed": True}

    def test_no_matching_surface_rule(self) -> None:
        rules: list[SurfaceTypeCapRule] = [
            {"surface_type": "modal", "rules": [{"count": 1, "period": "day"}]}
        ]
        assert check_system_presentation_caps(
            _out("a", category="upsell"), "banner", rules, now_ms=1000
        ) == {"allowed": True}

    def test_period_cap_exceeded(self) -> None:
        rules: list[SurfaceTypeCapRule] = [
            {"surface_type": "banner", "rules": [{"count": 1, "period": "day"}]}
        ]
        hist: PresentationCapState = {"seen_at": [500]}
        r = check_system_presentation_caps(
            _out("a", category="upsell"),
            "banner",
            rules,
            presentation_history=hist,
            now_ms=1000,
        )
        assert r == {"allowed": False, "reason": "suppressed_by_system_cap_day"}

    def test_session_cooldown(self) -> None:
        rules: list[SurfaceTypeCapRule] = [
            {"surface_type": "banner", "rules": [{"count": 9, "period": "day"}]}
        ]
        hist: PresentationCapState = {"seen_at": [900]}
        r = check_system_presentation_caps(
            _out("a", category="upsell"),
            "banner",
            rules,
            session_cooldown_ms=500,
            presentation_history=hist,
            now_ms=1000,
        )
        assert r == {"allowed": False, "reason": "suppressed_by_system_cooldown"}

    def test_rule_level_cooldown(self) -> None:
        rules: list[SurfaceTypeCapRule] = [
            {
                "surface_type": "banner",
                "rules": [{"count": 9, "period": "day"}],
                "cooldown_ms": 500,
            }
        ]
        hist: PresentationCapState = {"seen_at": [900]}
        r = check_system_presentation_caps(
            _out("a", category="upsell"),
            "banner",
            rules,
            presentation_history=hist,
            now_ms=1000,
        )
        assert r == {"allowed": False, "reason": "suppressed_by_system_cooldown"}

    def test_surface_type_match_case_insensitive(self) -> None:
        rules: list[SurfaceTypeCapRule] = [
            {"surface_type": "BANNER", "rules": [{"count": 1, "period": "day"}]}
        ]
        hist: PresentationCapState = {"seen_at": [500]}
        r = check_system_presentation_caps(
            _out("a", category="upsell"),
            "banner",
            rules,
            presentation_history=hist,
            now_ms=1000,
        )
        assert r["allowed"] is False

    def test_allowed_when_under_cap(self) -> None:
        rules: list[SurfaceTypeCapRule] = [
            {"surface_type": "banner", "rules": [{"count": 5, "period": "day"}]}
        ]
        r = check_system_presentation_caps(
            _out("a", category="upsell"), "banner", rules, now_ms=1000
        )
        assert r == {"allowed": True}


# ── apply_milestone_supersession_with_metadata ──────────────────────────────


class TestSupersessionWithMetadata:
    def test_single_no_metadata(self) -> None:
        outs = [_out("a")]
        result = apply_milestone_supersession_with_metadata(outs)
        assert result["survivors"] == outs
        assert result["superseded"] == []

    def test_version_metadata_recorded(self) -> None:
        newer = _out("new", content={"supersedes_template_version": ["v1"]})
        older = _out("old", content={"template_version": "v1"})
        result = apply_milestone_supersession_with_metadata([newer, older])
        assert {o["output_id"] for o in result["survivors"]} == {"new"}
        rec = result["superseded"][0]
        assert rec["superseded_output_id"] == "old"
        assert rec["superseded_by"] == "new"
        assert rec["reason"] == "milestone_version"

    def test_order_metadata_recorded(self) -> None:
        a = _out("a", content={"milestone_order": 1})
        b = _out("b", content={"milestone_order": 5})
        result = apply_milestone_supersession_with_metadata([a, b])
        assert {o["output_id"] for o in result["survivors"]} == {"b"}
        assert result["superseded"][0]["reason"] == "milestone_order"
        assert result["superseded"][0]["superseded_by"] == "b"


# ── filter_one_discretionary ────────────────────────────────────────────────


class TestFilterOneDiscretionary:
    def test_deterministic_always_pass(self) -> None:
        decisions: list[SlotDecision] = [
            {"output": _out("a", category="gated"), "slot_id": "s1"},
            {"output": _out("b", category="fixed"), "slot_id": "s2"},
        ]
        result = filter_one_discretionary(decisions)
        assert all("suppressed" not in d for d in result)

    def test_first_discretionary_passes_second_suppressed(self) -> None:
        decisions: list[SlotDecision] = [
            {"output": _out("a", category="upsell"), "slot_id": "s1"},
            {"output": _out("b", category="retention"), "slot_id": "s2"},
        ]
        result = filter_one_discretionary(decisions)
        assert "suppressed" not in result[0]
        assert result[1]["suppressed"] is True
        assert result[1]["suppression_reason"] == "one_discretionary_per_cycle"

    def test_already_fired_suppresses_first(self) -> None:
        decisions: list[SlotDecision] = [{"output": _out("a", category="upsell"), "slot_id": "s1"}]
        result = filter_one_discretionary(decisions, already_fired_discretionary=True)
        assert result[0]["suppressed"] is True

    def test_mixed_priority_then_discretionary(self) -> None:
        decisions: list[SlotDecision] = [
            {"output": _out("p", category="gated"), "slot_id": "s0"},
            {"output": _out("d1", category="upsell"), "slot_id": "s1"},
            {"output": _out("d2", category="conversion"), "slot_id": "s2"},
        ]
        result = filter_one_discretionary(decisions)
        assert "suppressed" not in result[0]  # priority
        assert "suppressed" not in result[1]  # first discretionary
        assert result[2]["suppressed"] is True  # second discretionary


# ── Pilot corpus (decision-lifecycle surface) ───────────────────────────────


class TestDecisionPilotCorpus:
    """10 hand-derived fixtures for the decision-lifecycle surface,
    extending the TASK-5 batch-1 (entitlement) and batch-2a (payload)
    pilots. Each expected value traced from placement-decision.ts.
    """

    _FIXTURES: list[tuple[str, Any]] = [
        ("lookup_full", local_placement_lookup_key({"slot_id": "x"}) == "x::::::::"),
        (
            "category_gated_beats_upsell",
            {
                o["output_id"]
                for o in apply_category_conflict_suppression(
                    [_out("g", category="gated"), _out("u", category="upsell")]
                )
            }
            == {"g"},
        ),
        (
            "milestone_version_supersedes",
            {
                o["output_id"]
                for o in apply_milestone_supersession(
                    [
                        _out("new", content={"supersedes_template_version": ["v1"]}),
                        _out("old", content={"template_version": "v1"}),
                    ]
                )
            }
            == {"new"},
        ),
        (
            "milestone_order_highest_wins",
            {
                o["output_id"]
                for o in apply_milestone_supersession(
                    [
                        _out("a", content={"milestone_order": 1}),
                        _out("b", content={"milestone_order": 9}),
                    ]
                )
            }
            == {"b"},
        ),
        (
            "resolve_bucket_order",
            (
                resolve_local_placement_from_candidates(
                    [_out("u", category="upsell"), _out("g", category="gated")]
                )
                or {}
            ).get("output_id")
            == "g",
        ),
        (
            "no_caps_allowed",
            check_placement_caps(_out("a"), "k", None, 1000) == {"allowed": True},
        ),
        (
            "system_caps_deterministic_exempt",
            check_system_presentation_caps(
                _out("a", category="gated"),
                "banner",
                [{"surface_type": "banner", "rules": [{"count": 1, "period": "day"}]}],
                now_ms=1,
            )
            == {"allowed": True},
        ),
        (
            "normalize_defaults_visible_true",
            normalize_decision_from_response("p", "r", "N", {})["visible"] is True,
        ),
        (
            "one_discretionary_suppresses_second",
            filter_one_discretionary(
                [
                    {"output": _out("d1", category="upsell"), "slot_id": "a"},
                    {"output": _out("d2", category="retention"), "slot_id": "b"},
                ]
            )[1]["suppressed"]
            is True,
        ),
        (
            "extract_caps_cooldown_ms",
            extract_placement_cap_policies(
                {
                    **_out("a"),
                    "caps": {"cooldown_days": 2},
                }
            )[0]["cooldown_ms"]
            == 2 * 24 * 60 * 60 * 1000,
        ),
    ]

    @pytest.mark.parametrize(
        "assertion",
        [t[1] for t in _FIXTURES],
        ids=[t[0] for t in _FIXTURES],
    )
    def test_pilot(self, assertion: bool) -> None:
        assert assertion is True

    def test_corpus_has_ten_fixtures(self) -> None:
        assert len(self._FIXTURES) == 10
