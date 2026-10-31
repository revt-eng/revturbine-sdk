"""Segment mode + dimension inference in the headless port (ST-1391, BUG-1389).

Mirrors ``server-rust/src/segments/segment_mode.rs`` and the scaffold
``segment-mode`` tests. Byte parity is additionally locked by the
``segment_evaluation`` and ``entitlement_segment_derived_dimensions`` parity
fixtures; these cover the same ground at unit level.
"""

from __future__ import annotations

from typing import Any

from revturbine.core.entitlements.entitlement_check import (
    derive_local_entitlement_from_configured_rules,
)
from revturbine.core.segments import evaluate_segments
from revturbine.core.segments.segment_mode import (
    basic_mode_violations,
    canonicalize_segment_predicates,
    classify_segment,
    dimension_key_for_field,
    infer_segment_mode,
    segment_dimension_keys,
)


def _eq(field: str, value: str) -> dict[str, str]:
    return {"field": field, "operator": "eq", "value": value}


class TestClassify:
    def test_single_field_basic_derives_key_over_declared_id(self) -> None:
        seg = {
            "handle": "pro",
            "dimension_id": "dim_imported_t",
            "predicates": [_eq("plan", "pro")],
        }
        c = classify_segment(seg)
        assert c.mode == "basic" and c.mode_inferred is True
        assert c.dimension_key == "plan" and c.dimension_derived is True
        assert c.declared_dimension_id == "dim_imported_t"
        assert c.dimension_mismatch is True

    def test_declared_id_matching_derived_key_is_not_a_mismatch(self) -> None:
        seg = {"handle": "e", "dimension_id": "rt.region", "predicates": [_eq("rt_region", "emea")]}
        c = classify_segment(seg)
        assert c.dimension_key == "rt.region" and c.dimension_mismatch is False

    def test_builtin_trait_maps_to_rt_dimension(self) -> None:
        assert dimension_key_for_field("rt_region") == "rt.region"
        assert dimension_key_for_field("rt_") == "rt_"
        assert dimension_key_for_field("plan") == "plan"

    def test_multi_field_basic_uses_declared_id(self) -> None:
        seg = {"handle": "m", "dimension_id": "d1", "predicates": [_eq("a", "1"), _eq("b", "2")]}
        c = classify_segment(seg)
        assert c.mode == "basic" and c.dimension_derived is False
        assert c.dimension_key == "d1" and c.fields == ["a", "b"]

    def test_advanced_uses_declared_id_or_none(self) -> None:
        rng = [{"field": "seats", "operator": "gte", "value": "10"}]
        assert (
            classify_segment(
                {"handle": "a", "dimension_id": "size", "predicates": rng}
            ).dimension_key
            == "size"
        )
        c = classify_segment({"handle": "b", "predicates": rng})
        assert c.mode == "advanced" and c.dimension_key is None

    def test_explicit_mode_wins_over_inference(self) -> None:
        seg = {"handle": "x", "mode": "advanced", "predicates": [_eq("plan", "pro")]}
        c = classify_segment(seg)
        assert c.mode == "advanced" and c.mode_inferred is False and c.dimension_key is None

    def test_empty_segment_is_basic_without_key(self) -> None:
        c = classify_segment({"handle": "e", "predicates": []})
        assert c.mode == "basic" and c.dimension_key is None
        assert infer_segment_mode({}) == "basic"

    def test_segment_dimension_keys_omits_keyless(self) -> None:
        keys = segment_dimension_keys(
            [
                {"handle": "pro", "predicates": [_eq("plan", "pro")]},
                {"handle": "empty", "predicates": []},
                {"predicates": [_eq("plan", "pro")]},
                "not-a-dict",
            ]
        )
        assert keys == {"pro": "plan"}

    def test_basic_mode_violations(self) -> None:
        seg = {
            "mode": "basic",
            "predicates": [_eq("a", "1"), {"field": "b", "operator": "gte", "value": "1"}],
        }
        assert basic_mode_violations(seg) == [{"index": 1, "operator": "gte"}]
        assert basic_mode_violations({"mode": "advanced", "predicates": seg["predicates"]}) == []


class TestEvaluateByMode:
    def test_repeated_field_eq_ors_in_basic(self) -> None:
        seg = {"handle": "s", "predicates": [_eq("plan", "pro"), _eq("plan", "team")]}
        assert evaluate_segments([seg], {"plan": "team"}) == ["s"]
        assert evaluate_segments([seg], {"plan": "free"}) == []

    def test_one_per_field_is_flat_and(self) -> None:
        seg = {"handle": "s", "predicates": [_eq("plan", "pro"), _eq("country", "us")]}
        assert evaluate_segments([seg], {"plan": "pro", "country": "us"}) == ["s"]
        assert evaluate_segments([seg], {"plan": "pro", "country": "ca"}) == []

    def test_range_on_one_field_is_advanced_and(self) -> None:
        seg = {
            "handle": "r",
            "predicates": [
                {"field": "seats", "operator": "gte", "value": "10"},
                {"field": "seats", "operator": "lte", "value": "100"},
            ],
        }
        assert evaluate_segments([seg], {"seats": 50}) == ["r"]
        assert evaluate_segments([seg], {"seats": 500}) == []

    def test_explicit_advanced_repeated_eq_never_matches(self) -> None:
        seg = {
            "handle": "a",
            "mode": "advanced",
            "predicates": [_eq("plan", "pro"), _eq("plan", "team")],
        }
        assert evaluate_segments([seg], {"plan": "pro"}) == []
        assert evaluate_segments([seg], {"plan": "team"}) == []

    def test_or_within_field_and_across_fields(self) -> None:
        seg = {
            "handle": "s",
            "predicates": [_eq("plan", "pro"), _eq("country", "us"), _eq("plan", "team")],
        }
        assert evaluate_segments([seg], {"plan": "team", "country": "us"}) == ["s"]
        assert evaluate_segments([seg], {"plan": "team", "country": "ca"}) == []


class TestCanonicalize:
    def test_merges_repeated_field_into_one_in(self) -> None:
        seg = {
            "handle": "s",
            "predicates": [
                _eq("plan", "pro"),
                _eq("region", "us"),
                {"field": "plan", "operator": "in", "value": "team,pro"},
            ],
        }
        out = canonicalize_segment_predicates(seg)
        assert out["ok"] is True
        assert out["segment"]["predicates"] == [
            {"field": "plan", "operator": "in", "value": "pro,team"},
            _eq("region", "us"),
        ]

    def test_no_repeat_and_advanced_pass_through_same_object(self) -> None:
        plain = {"handle": "s", "predicates": [_eq("a", "1"), _eq("b", "2")]}
        assert canonicalize_segment_predicates(plain)["segment"] is plain
        adv = {"handle": "a", "mode": "advanced", "predicates": [_eq("a", "1"), _eq("a", "2")]}
        assert canonicalize_segment_predicates(adv)["segment"] is adv

    def test_refuses_comma_and_whitespace_values(self) -> None:
        comma = {"predicates": [_eq("p", "a,b"), _eq("p", "c")]}
        assert canonicalize_segment_predicates(comma)["ok"] is False
        ws = {"predicates": [_eq("p", " a"), _eq("p", "c")]}
        assert canonicalize_segment_predicates(ws)["ok"] is False


def _bug_1389_playbook() -> dict[str, Any]:
    placeholder = "dim_imported_t"
    segments = [
        {
            "id": "s1",
            "handle": "pro",
            "dimension_id": placeholder,
            "predicates": [_eq("plan", "pro")],
        },
        {
            "id": "s2",
            "handle": "team",
            "dimension_id": placeholder,
            "predicates": [_eq("plan", "team")],
        },
        {
            "id": "s3",
            "handle": "us",
            "dimension_id": placeholder,
            "predicates": [_eq("country", "us")],
        },
        {
            "id": "s4",
            "handle": "ca",
            "dimension_id": placeholder,
            "predicates": [_eq("country", "ca")],
        },
        {
            "id": "s5",
            "handle": "emea",
            "dimension_id": placeholder,
            "predicates": [_eq("rt_region", "emea")],
        },
    ]
    return {
        "version": "1.0.0",
        "plans": [{"id": "starter", "unique_handle": "starter"}],
        "entitlement_rules": [
            {
                "id": "r_f",
                "entitlement_id": "f",
                "targets": [{"kind": "plan", "id": "starter"}],
                "segment_ids": ["pro", "team", "us", "ca"],
                "type_fields": {"kind": "feature", "enabled": True},
            }
        ],
        "segments": segments,
    }


class TestBug1389RuleMatching:
    """A shared placeholder dimension_id must not decide rule matching."""

    def _allowed(self, held: set[str]) -> bool:
        result = derive_local_entitlement_from_configured_rules(
            handle="f",
            context=None,
            current_plan_handle="starter",
            segment_ids=held,
            usage_balances={},
            user_usage=None,
            playbook=_bug_1389_playbook(),
        )
        assert result is not None
        return bool(result["allowed"])

    def test_derived_keys_split_plan_and_country(self) -> None:
        keys = segment_dimension_keys(_bug_1389_playbook()["segments"])
        assert keys == {
            "pro": "plan",
            "team": "plan",
            "us": "country",
            "ca": "country",
            "emea": "rt.region",
        }

    def test_one_dimension_only_is_denied(self) -> None:
        assert self._allowed({"pro"}) is False
        assert self._allowed({"us", "ca"}) is False
        assert self._allowed({"pro", "team"}) is False

    def test_one_from_each_dimension_is_granted(self) -> None:
        assert self._allowed({"pro", "us"}) is True
        assert self._allowed({"team", "ca"}) is True
