"""Segment evaluation in the headless port (plan 233).

Mirrors ``server-rust/src/segments/mod.rs`` tests case for case. Parity is
asserted byte-for-byte by ``tests/parity/fixtures/segment_evaluation.json``;
these cover the same ground at unit level so a divergence is diagnosable
without running three runtimes.

Weighted toward JS coercion, because that is where byte-identical parity
actually breaks rather than where the logic is hard.
"""

from __future__ import annotations

from revturbine.core.segments import (
    activity_level_satisfies,
    evaluate_predicate,
    evaluate_segments,
    experiment_by_segment_handle,
)


class TestEvaluateSegments:
    def test_matches_when_every_predicate_holds(self) -> None:
        segments = [
            {
                "handle": "power_users",
                "predicates": [{"field": "plan", "operator": "eq", "value": "pro"}],
            }
        ]
        assert evaluate_segments(segments, {"plan": "pro"}) == ["power_users"]

    def test_and_across_predicates(self) -> None:
        segments = [
            {
                "handle": "both",
                "predicates": [
                    {"field": "plan", "operator": "eq", "value": "pro"},
                    {"field": "seats", "operator": "gte", "value": "5"},
                ],
            }
        ]
        assert evaluate_segments(segments, {"plan": "pro", "seats": 5}) == ["both"]
        assert evaluate_segments(segments, {"plan": "pro", "seats": 4}) == []

    def test_segment_without_predicates_is_skipped(self) -> None:
        # It would otherwise match everybody.
        assert evaluate_segments([{"handle": "empty"}], {}) == []

    def test_returns_handles_not_ids(self) -> None:
        segments = [
            {
                "handle": "power_users",
                "id": "seg_01H8XK",
                "predicates": [{"field": "plan", "operator": "eq", "value": "pro"}],
            }
        ]
        assert evaluate_segments(segments, {"plan": "pro"}) == ["power_users"]

    def test_experiment_segment_is_fail_closed(self) -> None:
        segments = [{"handle": "exp_seg", "experiment_handle": "exp_a"}]
        assert evaluate_segments(segments, {}, {}) == []
        assert evaluate_segments(segments, {}, {"exp_a": "variant_b"}) == ["exp_seg"]

    def test_experiment_segment_still_applies_its_predicates(self) -> None:
        segments = [
            {
                "handle": "exp_and_pred",
                "experiment_handle": "exp_a",
                "predicates": [{"field": "plan", "operator": "eq", "value": "pro"}],
            }
        ]
        assignments = {"exp_a": "variant_b"}
        assert evaluate_segments(segments, {"plan": "free"}, assignments) == []
        assert evaluate_segments(segments, {"plan": "pro"}, assignments) == ["exp_and_pred"]


class TestEvaluatePredicate:
    def test_missing_trait_fails_closed(self) -> None:
        assert not evaluate_predicate({"field": "absent", "operator": "eq", "value": "x"}, {})

    def test_boolean_coerces_like_js(self) -> None:
        # Python's str(True) is "True"; JS String(true) is "true".
        assert evaluate_predicate({"field": "b", "operator": "eq", "value": "true"}, {"b": True})
        assert evaluate_predicate({"field": "b", "operator": "eq", "value": "false"}, {"b": False})

    def test_integral_float_renders_without_a_decimal(self) -> None:
        # Python's str(3.0) is "3.0"; JS String(3) is "3".
        assert evaluate_predicate({"field": "n", "operator": "eq", "value": "3"}, {"n": 3.0})

    def test_empty_string_is_zero(self) -> None:
        assert evaluate_predicate({"field": "n", "operator": "gte", "value": ""}, {"n": 0})

    def test_hex_parses_like_js(self) -> None:
        assert evaluate_predicate({"field": "n", "operator": "gte", "value": "0x10"}, {"n": 16})

    def test_unparseable_number_never_compares_true(self) -> None:
        for op in ("gt", "lt", "gte", "lte"):
            assert not evaluate_predicate(
                {"field": "n", "operator": op, "value": "5"}, {"n": "abc"}
            ), op

    def test_underscore_separator_is_not_a_number(self) -> None:
        # Python float("1_000") is 1000; JS Number("1_000") is NaN.
        assert not evaluate_predicate(
            {"field": "n", "operator": "gte", "value": "1_000"}, {"n": 1000}
        )

    def test_contains_and_in(self) -> None:
        assert evaluate_predicate(
            {"field": "email", "operator": "contains", "value": "@acme"},
            {"email": "jo@acme.test"},
        )
        assert evaluate_predicate(
            {"field": "tier", "operator": "in", "value": "gold, silver ,bronze"},
            {"tier": "silver"},
        )

    def test_unknown_operator_fails_closed(self) -> None:
        assert not evaluate_predicate(
            {"field": "plan", "operator": "startsWith", "value": "p"}, {"plan": "pro"}
        )


class TestActivityLevel:
    def test_active_matches_the_union(self) -> None:
        for level in ("high", "medium", "low"):
            assert activity_level_satisfies("active", level)
        assert not activity_level_satisfies("active", "inactive")

    def test_non_active_matches_exactly(self) -> None:
        assert activity_level_satisfies("high", "high")
        assert not activity_level_satisfies("high", "medium")

    def test_predicate_routes_through_the_union(self) -> None:
        p = {"field": "activity_level", "operator": "eq", "value": "active"}
        assert evaluate_predicate(p, {"activity_level": "low"})
        assert not evaluate_predicate(p, {"activity_level": "inactive"})

    def test_in_operator_honours_the_union(self) -> None:
        p = {"field": "activity_level", "operator": "in", "value": "active,dormant"}
        assert evaluate_predicate(p, {"activity_level": "high"})


class TestExperimentBySegmentHandle:
    def test_maps_only_experiment_segments(self) -> None:
        segments = [
            {"handle": "a", "experiment_handle": "exp_1"},
            {"handle": "b"},
        ]
        assert experiment_by_segment_handle(segments) == {"a": "exp_1"}
