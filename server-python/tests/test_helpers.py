"""Unit tests for ``revturbine.core.helpers``.

Mirrors the case shape of ``revturbine-scaffold/src/core/helpers.test.ts``
where applicable, plus Python-specific edge cases (``bool`` not being
``int`` for type-guard purposes, etc.).
"""

from __future__ import annotations

import math
from typing import Any

import pytest

from revturbine.core.helpers import (
    LocalLookupParts,
    category_bucket,
    configured_plan_name_from_exported_config,
    ensure_array,
    first_string_value,
    is_modal_safe_surface_type,
    is_record,
    looks_generic_usage_unit,
    milestone_version,
    normalize_event_type,
    normalized_route,
    parse_cap_rule,
    parse_exported_config_or_throw,
    parse_local_lookup_key,
    parse_numberish,
    period_window_start,
    placement_matches_plan_target,
    placement_priority,
    placement_score,
    placement_target_plan_ids,
    plan_target_aliases,
    proximity_score,
    recommend_next_plan_up,
    sanitize_slug,
    sanitize_usage_token_prefix,
    server_order,
    stable_stringify,
    superseded_versions,
    usage_amounts_from_entries,
    usage_token_prefix_from_entitlement_id,
    validate_trial_status_shape,
)

# ── is_record ────────────────────────────────────────────────────────────────


class TestIsRecord:
    def test_dict_is_record(self) -> None:
        assert is_record({}) is True
        assert is_record({"a": 1}) is True

    @pytest.mark.parametrize(
        "value",
        [None, [], [1, 2], "str", 0, 0.0, 1, 1.5, True, False, object()],
    )
    def test_non_dict_is_not_record(self, value: Any) -> None:
        assert is_record(value) is False


# ── ensure_array ─────────────────────────────────────────────────────────────


class TestEnsureArray:
    def test_returns_filtered_list(self) -> None:
        assert ensure_array(["a", "b", "c"]) == ["a", "b", "c"]

    def test_strips_empty_and_whitespace(self) -> None:
        assert ensure_array(["a", "", "  ", "b"]) == ["a", "b"]

    def test_none_returns_empty(self) -> None:
        assert ensure_array(None) == []

    def test_no_args_returns_empty(self) -> None:
        assert ensure_array() == []

    def test_non_string_filtered(self) -> None:
        # The TS signature only takes string[], but defensive filtering
        # keeps us safe at the SDK boundary.
        assert ensure_array(["valid", 1, None, "ok"]) == ["valid", "ok"]  # type: ignore[list-item]

    def test_non_list_returns_empty(self) -> None:
        assert ensure_array("not a list") == []  # type: ignore[arg-type]


# ── first_string_value ───────────────────────────────────────────────────────


class TestFirstStringValue:
    def test_returns_first_non_empty(self) -> None:
        assert first_string_value("", "first", "second") == "first"

    def test_skips_whitespace_only(self) -> None:
        assert first_string_value("  ", "real") == "real"

    def test_skips_non_strings(self) -> None:
        assert first_string_value(None, 123, [], "found") == "found"

    def test_all_empty_returns_none(self) -> None:
        assert first_string_value("", "  ", None, 0) is None

    def test_no_args_returns_none(self) -> None:
        assert first_string_value() is None


# ── parse_numberish ──────────────────────────────────────────────────────────


class TestParseNumberish:
    def test_int(self) -> None:
        assert parse_numberish(42) == 42.0

    def test_float(self) -> None:
        assert parse_numberish(3.14) == 3.14

    def test_negative(self) -> None:
        assert parse_numberish(-7) == -7.0

    def test_zero(self) -> None:
        assert parse_numberish(0) == 0.0

    def test_numeric_string(self) -> None:
        assert parse_numberish("42") == 42.0
        assert parse_numberish("3.14") == 3.14
        assert parse_numberish("-1") == -1.0

    def test_string_with_whitespace(self) -> None:
        # JS Number("  42  ") parses to 42; Python float() also strips.
        assert parse_numberish("  42  ") == 42.0

    def test_non_numeric_string_returns_none(self) -> None:
        assert parse_numberish("abc") is None
        assert parse_numberish("") is None
        assert parse_numberish("1.2.3") is None

    def test_bool_returns_none(self) -> None:
        # bool is int in Python; the TS guard rejects booleans, so we do too.
        assert parse_numberish(True) is None
        assert parse_numberish(False) is None

    def test_none_returns_none(self) -> None:
        assert parse_numberish(None) is None

    def test_nan_returns_none(self) -> None:
        assert parse_numberish(float("nan")) is None

    def test_infinity_returns_none(self) -> None:
        assert parse_numberish(float("inf")) is None
        assert parse_numberish(float("-inf")) is None

    def test_dict_returns_none(self) -> None:
        assert parse_numberish({"a": 1}) is None

    def test_list_returns_none(self) -> None:
        assert parse_numberish([1]) is None


# ── normalized_route ─────────────────────────────────────────────────────────


class TestNormalizedRoute:
    def test_lowercases(self) -> None:
        assert normalized_route("/Users") == "/users"

    def test_strips_trailing_slash(self) -> None:
        assert normalized_route("/users/") == "/users"

    def test_strips_multiple_trailing_slashes(self) -> None:
        assert normalized_route("/users//") == "/users"

    def test_trims_whitespace(self) -> None:
        assert normalized_route("  /users  ") == "/users"

    def test_empty_becomes_root(self) -> None:
        assert normalized_route("") == "/"

    def test_whitespace_becomes_root(self) -> None:
        assert normalized_route("   ") == "/"

    def test_only_slash_stays_root(self) -> None:
        # "/" → trailing-slash strip would empty it → "/" fallback
        assert normalized_route("/") == "/"


# ── sanitize_slug ────────────────────────────────────────────────────────────


class TestSanitizeSlug:
    def test_basic(self) -> None:
        assert sanitize_slug("Hello World") == "hello-world"

    def test_replaces_special_chars(self) -> None:
        assert sanitize_slug("foo!@#$%bar") == "foo-bar"

    def test_collapses_runs_of_separators(self) -> None:
        assert sanitize_slug("foo  bar  baz") == "foo-bar-baz"

    def test_strips_leading_trailing_dashes(self) -> None:
        assert sanitize_slug("!hello!") == "hello"

    def test_keeps_numbers(self) -> None:
        assert sanitize_slug("Plan 2024") == "plan-2024"

    def test_empty_uses_default_fallback(self) -> None:
        assert sanitize_slug("") == "slot-unknown"

    def test_empty_uses_provided_fallback(self) -> None:
        assert sanitize_slug("", "abc123") == "slot-abc123"

    def test_only_punctuation_uses_fallback(self) -> None:
        assert sanitize_slug("!!!", "xyz") == "slot-xyz"

    def test_unicode_treated_as_separator(self) -> None:
        # Non-ASCII falls into the [^a-z0-9]+ bucket.
        assert sanitize_slug("café") == "caf"


# ── normalize_event_type ─────────────────────────────────────────────────────


class TestNormalizeEventType:
    @pytest.mark.parametrize(
        ("input_value", "expected"),
        [
            ("pageview", "clickstream_page_view"),
            ("page_view", "clickstream_page_view"),
            ("PageView", "clickstream_page_view"),
            ("page view", "clickstream_page_view"),
            ("page-view", "clickstream_page_view"),
            ("click", "clickstream_click"),
            ("doc_view", "clickstream_doc_view"),
            ("checkout_started", "clickstream_checkout_started"),
            ("checkout_completed", "clickstream_checkout_completed"),
            ("payment_failed", "clickstream_payment_failed"),
        ],
    )
    def test_known_aliases(self, input_value: str, expected: str) -> None:
        assert normalize_event_type(input_value) == expected

    def test_unknown_passes_through_normalized(self) -> None:
        assert normalize_event_type("Custom Event") == "custom_event"
        assert normalize_event_type("MY-CUSTOM-EVENT") == "my_custom_event"

    def test_empty_returns_unknown(self) -> None:
        assert normalize_event_type("") == "unknown_event"
        assert normalize_event_type("   ") == "unknown_event"


# ── parse_local_lookup_key ───────────────────────────────────────────────────


class TestParseLocalLookupKey:
    def test_full_key(self) -> None:
        parts = parse_local_lookup_key("slot::banner::ent::plan::placement")
        assert parts.slot_id == "slot"
        assert parts.surface_type == "banner"
        assert parts.entitlement_handle == "ent"
        assert parts.plan_handle == "plan"
        assert parts.placement_handle == "placement"

    def test_partial_key_fills_missing(self) -> None:
        parts = parse_local_lookup_key("slot::banner")
        assert parts.slot_id == "slot"
        assert parts.surface_type == "banner"
        assert parts.entitlement_handle == ""
        assert parts.plan_handle == ""
        assert parts.placement_handle == ""

    def test_empty_segments(self) -> None:
        parts = parse_local_lookup_key("slot::::ent")
        assert parts.slot_id == "slot"
        assert parts.surface_type == ""
        assert parts.entitlement_handle == "ent"

    def test_empty_key(self) -> None:
        parts = parse_local_lookup_key("")
        assert parts.slot_id == ""

    def test_returns_local_lookup_parts_type(self) -> None:
        parts = parse_local_lookup_key("a::b::c::d::e")
        assert isinstance(parts, LocalLookupParts)
        # Behaves as dict too.
        assert parts["slot_id"] == "a"


# ── plan_target_aliases ──────────────────────────────────────────────────────


class TestPlanTargetAliases:
    def test_starter_free_aliased(self) -> None:
        assert plan_target_aliases("starter") == ["starter", "free"]
        assert plan_target_aliases("free") == ["starter", "free"]
        assert plan_target_aliases("FREE") == ["starter", "free"]

    def test_professional_pro_aliased(self) -> None:
        assert plan_target_aliases("professional") == ["professional", "pro"]
        assert plan_target_aliases("pro") == ["professional", "pro"]

    def test_enterprise_passthrough(self) -> None:
        assert plan_target_aliases("enterprise") == ["enterprise"]

    def test_unknown_normalized_singleton(self) -> None:
        assert plan_target_aliases("custom-tier") == ["custom-tier"]
        assert plan_target_aliases("  Foo  ") == ["foo"]

    def test_empty_returns_empty(self) -> None:
        assert plan_target_aliases("") == []
        assert plan_target_aliases("   ") == []


# ── usage_token_prefix_from_entitlement_id ───────────────────────────────────


class TestUsageTokenPrefixFromEntitlementId:
    @pytest.mark.parametrize(
        ("input_value", "expected"),
        [
            ("api_calls_minutes", "api_calls"),
            ("api_calls_minute", "api_calls"),
            ("seat_count_seats", "seat_count"),
            ("trial_credits", "trial"),
            ("foo_usage", "foo"),
            ("foo", "foo"),
            ("FOO", "foo"),
            ("  foo  ", "foo"),
        ],
    )
    def test_strips_suffixes(self, input_value: str, expected: str) -> None:
        assert usage_token_prefix_from_entitlement_id(input_value) == expected


# ── sanitize_usage_token_prefix ──────────────────────────────────────────────


class TestSanitizeUsageTokenPrefix:
    def test_lowercases(self) -> None:
        assert sanitize_usage_token_prefix("API_CALLS") == "api_calls"

    def test_replaces_whitespace_with_underscore(self) -> None:
        assert sanitize_usage_token_prefix("api calls") == "api_calls"

    def test_strips_disallowed_chars(self) -> None:
        assert sanitize_usage_token_prefix("foo-bar!") == "foobar"

    def test_keeps_alphanumeric_and_underscore(self) -> None:
        assert sanitize_usage_token_prefix("a1_b2") == "a1_b2"

    def test_empty(self) -> None:
        assert sanitize_usage_token_prefix("") == ""


# ── looks_generic_usage_unit ─────────────────────────────────────────────────


class TestLooksGenericUsageUnit:
    @pytest.mark.parametrize(
        "unit",
        ["minutes", "minute", "credits", "credit", "seats", "seat", "units", "unit"],
    )
    def test_generic_units(self, unit: str) -> None:
        assert looks_generic_usage_unit(unit) is True

    @pytest.mark.parametrize(
        "unit",
        ["api_call", "gigabyte", "custom", "", "MINUTES"],  # case-sensitive per TS
    )
    def test_non_generic(self, unit: str) -> None:
        assert looks_generic_usage_unit(unit) is False


# ── category_bucket ──────────────────────────────────────────────────────────


class TestCategoryBucket:
    # Direct port of helpers.test.ts case grid.
    @pytest.mark.parametrize(
        ("category", "expected"),
        [
            ("gated", 0),
            ("entitlement", 0),
            ("gated_feature", 0),
            ("fixed", 1),
            ("FIXED", 1),
            ("usage", 2),
            ("credit", 2),
            ("seat", 2),
            ("quota", 2),
            ("trial", 3),
            ("upsell", 4),
            ("conversion", 4),
            ("expansion", 4),
            ("retention", 5),
            ("winback", 5),
            ("churn", 5),
            ("mystery", 99),
            ("", 99),
        ],
    )
    def test_category_buckets(self, category: str, expected: int) -> None:
        assert category_bucket(category) == expected

    def test_gated_lt_fixed_ordering_invariant(self) -> None:
        # Spec: Access Gates always sort first.
        assert category_bucket("gated") < category_bucket("fixed")
        assert category_bucket("fixed") < category_bucket("usage")
        assert category_bucket("usage") < category_bucket("trial")


# ── is_modal_safe_surface_type ───────────────────────────────────────────────


class TestIsModalSafeSurfaceType:
    @pytest.mark.parametrize(
        "surface_type",
        ["banner", "toast", "in_page", "button", "cli", "unknown"],
    )
    def test_safe_types(self, surface_type: str) -> None:
        assert is_modal_safe_surface_type(surface_type) is True

    @pytest.mark.parametrize("surface_type", ["modal", "MODAL", "  modal  ", "full_page"])
    def test_unsafe_types(self, surface_type: str) -> None:
        assert is_modal_safe_surface_type(surface_type) is False


# ── stable_stringify ─────────────────────────────────────────────────────────


class TestStableStringify:
    def test_primitives(self) -> None:
        assert stable_stringify(None) == "null"
        assert stable_stringify(True) == "true"
        assert stable_stringify(False) == "false"
        assert stable_stringify(42) == "42"
        assert stable_stringify("hello") == '"hello"'

    def test_array(self) -> None:
        assert stable_stringify([1, 2, 3]) == "[1,2,3]"

    def test_empty_array(self) -> None:
        assert stable_stringify([]) == "[]"

    def test_empty_object(self) -> None:
        assert stable_stringify({}) == "{}"

    def test_sorts_keys(self) -> None:
        assert stable_stringify({"b": 1, "a": 2}) == '{"a":2,"b":1}'

    def test_deeply_sorts(self) -> None:
        value = {"z": {"b": 2, "a": 1}, "a": [{"y": 1, "x": 2}]}
        assert stable_stringify(value) == '{"a":[{"x":2,"y":1}],"z":{"a":1,"b":2}}'

    def test_two_equal_payloads_match(self) -> None:
        # Different insertion order; same canonical output.
        a = {"x": 1, "y": [1, 2], "z": {"a": "b", "c": "d"}}
        b = {"z": {"c": "d", "a": "b"}, "y": [1, 2], "x": 1}
        assert stable_stringify(a) == stable_stringify(b)

    def test_nested_with_array_order_preserved(self) -> None:
        # Arrays keep insertion order (only object keys sort).
        assert stable_stringify({"a": [3, 1, 2]}) == '{"a":[3,1,2]}'

    def test_rejects_nan(self) -> None:
        with pytest.raises(ValueError):
            stable_stringify(float("nan"))

    def test_rejects_inf(self) -> None:
        with pytest.raises(ValueError):
            stable_stringify(math.inf)


# ── parse_cap_rule (batch 2) ─────────────────────────────────────────────────


class TestParseCapRule:
    @pytest.mark.parametrize("period", ["session", "day", "week", "month", "lifetime"])
    def test_valid_periods(self, period: str) -> None:
        rule = parse_cap_rule({"count": 3, "period": period})
        assert rule is not None
        assert rule["count"] == 3.0
        assert rule["period"] == period

    def test_count_from_string_coerces(self) -> None:
        rule = parse_cap_rule({"count": "5", "period": "day"})
        assert rule is not None
        assert rule["count"] == 5.0

    @pytest.mark.parametrize(
        "value",
        [None, "not a dict", [], 42, True],
    )
    def test_non_dict_returns_none(self, value: Any) -> None:
        assert parse_cap_rule(value) is None

    def test_missing_count_returns_none(self) -> None:
        assert parse_cap_rule({"period": "day"}) is None

    def test_zero_count_returns_none(self) -> None:
        assert parse_cap_rule({"count": 0, "period": "day"}) is None

    def test_negative_count_returns_none(self) -> None:
        assert parse_cap_rule({"count": -1, "period": "day"}) is None

    def test_non_numeric_count_returns_none(self) -> None:
        assert parse_cap_rule({"count": "abc", "period": "day"}) is None

    def test_unknown_period_returns_none(self) -> None:
        assert parse_cap_rule({"count": 3, "period": "decade"}) is None

    def test_missing_period_returns_none(self) -> None:
        assert parse_cap_rule({"count": 3}) is None


# ── period_window_start (batch 2) ────────────────────────────────────────────


class TestPeriodWindowStart:
    def test_session_returns_zero(self) -> None:
        assert period_window_start("session", 1_000_000) == 0

    def test_lifetime_returns_zero(self) -> None:
        assert period_window_start("lifetime", 1_000_000) == 0

    def test_day_subtracts_24h(self) -> None:
        now = 100_000_000
        assert period_window_start("day", now) == now - 24 * 60 * 60 * 1000

    def test_week_subtracts_7d(self) -> None:
        now = 100_000_000
        assert period_window_start("week", now) == now - 7 * 24 * 60 * 60 * 1000

    def test_month_subtracts_30d(self) -> None:
        now = 100_000_000
        assert period_window_start("month", now) == now - 30 * 24 * 60 * 60 * 1000


# ── placement_target_plan_ids (batch 2) ──────────────────────────────────────


class TestPlacementTargetPlanIds:
    def test_direct_target_plan_ids(self) -> None:
        output = {"target": {"plan_ids": ["plan_pro", "plan_team"]}}
        assert placement_target_plan_ids(output) == ["plan_pro", "plan_team"]

    def test_filters_non_strings_from_direct(self) -> None:
        output = {"target": {"plan_ids": ["plan_pro", 42, None, "plan_team"]}}
        assert placement_target_plan_ids(output) == ["plan_pro", "plan_team"]

    def test_falls_back_to_content_embedded(self) -> None:
        output = {"content": {"__target_plan_ids": ["plan_x"]}}
        assert placement_target_plan_ids(output) == ["plan_x"]

    def test_direct_wins_over_embedded(self) -> None:
        output = {
            "target": {"plan_ids": ["direct"]},
            "content": {"__target_plan_ids": ["embedded"]},
        }
        assert placement_target_plan_ids(output) == ["direct"]

    def test_empty_direct_falls_through_to_embedded(self) -> None:
        output = {
            "target": {"plan_ids": []},
            "content": {"__target_plan_ids": ["embedded"]},
        }
        assert placement_target_plan_ids(output) == ["embedded"]

    def test_no_target_returns_empty(self) -> None:
        assert placement_target_plan_ids({}) == []

    def test_non_dict_target_falls_through(self) -> None:
        output = {"target": "not-a-dict", "content": {}}
        assert placement_target_plan_ids(output) == []

    def test_non_list_plan_ids(self) -> None:
        output = {"target": {"plan_ids": "single"}}
        assert placement_target_plan_ids(output) == []


# ── placement_matches_plan_target (batch 2) ──────────────────────────────────


class TestPlacementMatchesPlanTarget:
    def test_no_target_matches_anything(self) -> None:
        assert placement_matches_plan_target({}, "pro") is True

    def test_none_plan_handle_matches(self) -> None:
        assert placement_matches_plan_target({"target": {"plan_ids": ["pro"]}}) is True

    def test_empty_plan_handle_matches(self) -> None:
        assert placement_matches_plan_target({"target": {"plan_ids": ["pro"]}}, "") is True

    def test_exact_match(self) -> None:
        output = {"target": {"plan_ids": ["pro"]}}
        assert placement_matches_plan_target(output, "pro") is True

    def test_alias_match_starter_free(self) -> None:
        output = {"target": {"plan_ids": ["starter"]}}
        assert placement_matches_plan_target(output, "free") is True

    def test_alias_match_pro_professional(self) -> None:
        output = {"target": {"plan_ids": ["professional"]}}
        assert placement_matches_plan_target(output, "pro") is True

    def test_suffix_match(self) -> None:
        # plan_id "plan_pro" ends with "_pro"
        output = {"target": {"plan_ids": ["plan_pro"]}}
        assert placement_matches_plan_target(output, "pro") is True

    def test_substring_match(self) -> None:
        # plan_id "enterprise_v2" contains "enterprise"
        output = {"target": {"plan_ids": ["enterprise_v2"]}}
        assert placement_matches_plan_target(output, "enterprise") is True

    def test_no_match(self) -> None:
        output = {"target": {"plan_ids": ["enterprise"]}}
        assert placement_matches_plan_target(output, "free") is False

    def test_whitespace_only_plan_handle_yields_no_aliases(self) -> None:
        # `not plan_handle` is False for "   " (truthy), but
        # `plan_target_aliases("   ")` returns [], hitting the second guard.
        output = {"target": {"plan_ids": ["pro"]}}
        assert placement_matches_plan_target(output, "   ") is True


# ── usage_amounts_from_entries (batch 2) ─────────────────────────────────────


class TestUsageAmountsFromEntries:
    def test_dict_with_amount(self) -> None:
        usage = {"api_calls": {"amount": 42}}
        assert usage_amounts_from_entries(usage) == {"api_calls": 42.0}

    def test_bare_numeric_entry(self) -> None:
        usage = {"seats": 5}
        assert usage_amounts_from_entries(usage) == {"seats": 5.0}

    def test_float_entry(self) -> None:
        usage = {"credits": {"amount": 3.5}}
        assert usage_amounts_from_entries(usage) == {"credits": 3.5}

    def test_skips_non_numeric_entries(self) -> None:
        usage = {
            "good": {"amount": 1},
            "bad_dict": {"amount": "not-a-number"},
            "string": "five",
            "none": None,
        }
        assert usage_amounts_from_entries(usage) == {"good": 1.0}

    def test_skips_bool_entry(self) -> None:
        # bool subclass of int — explicitly rejected.
        usage = {"flag": True, "real": 7}
        assert usage_amounts_from_entries(usage) == {"real": 7.0}

    def test_none_returns_empty(self) -> None:
        assert usage_amounts_from_entries(None) == {}

    def test_empty_dict_returns_empty(self) -> None:
        assert usage_amounts_from_entries({}) == {}


# ── configured_plan_name_from_exported_config (batch 2) ──────────────────────


class TestConfiguredPlanNameFromExportedConfig:
    @pytest.fixture
    def config(self) -> dict[str, Any]:
        return {
            "plans": [
                {"id": "plan_pro", "unique_handle": "pro", "name": "Pro"},
                {"id": "plan_team", "unique_handle": "team", "name": "Team"},
                {"id": "plan_free", "unique_handle": "starter", "name": "Free Tier"},
            ],
        }

    def test_match_by_id(self, config: dict[str, Any]) -> None:
        assert configured_plan_name_from_exported_config(config, "plan_pro") == "Pro"

    def test_match_by_handle(self, config: dict[str, Any]) -> None:
        assert configured_plan_name_from_exported_config(config, "pro") == "Pro"

    def test_match_by_handle_case_insensitive(self, config: dict[str, Any]) -> None:
        assert configured_plan_name_from_exported_config(config, "PRO") == "Pro"

    def test_match_by_id_suffix(self, config: dict[str, Any]) -> None:
        # plan_id "plan_team" ends with "_team"
        assert configured_plan_name_from_exported_config(config, "team") == "Team"

    def test_user_plan_context_dict(self, config: dict[str, Any]) -> None:
        assert configured_plan_name_from_exported_config(config, {"id": "plan_pro"}) == "Pro"

    def test_no_match_returns_none(self, config: dict[str, Any]) -> None:
        assert configured_plan_name_from_exported_config(config, "missing") is None

    def test_no_config_returns_none(self) -> None:
        assert configured_plan_name_from_exported_config(None, "pro") is None

    def test_config_without_plans_array(self) -> None:
        assert configured_plan_name_from_exported_config({"plans": "not-a-list"}, "pro") is None

    def test_empty_plan_value(self, config: dict[str, Any]) -> None:
        assert configured_plan_name_from_exported_config(config, "") is None
        assert configured_plan_name_from_exported_config(config, "   ") is None
        assert configured_plan_name_from_exported_config(config, None) is None

    def test_plan_with_empty_name_falls_through(self) -> None:
        # When the matching plan's name is empty, the function continues
        # the loop rather than returning early.
        config: dict[str, Any] = {
            "plans": [
                {"id": "pro", "name": ""},
                {"id": "plan_pro", "name": "Real Pro"},
            ],
        }
        assert configured_plan_name_from_exported_config(config, "pro") == "Real Pro"

    def test_skips_non_dict_plan_entries(self) -> None:
        config: dict[str, Any] = {
            "plans": [
                "not-a-dict",
                {"id": "plan_pro", "name": "Pro"},
            ],
        }
        assert configured_plan_name_from_exported_config(config, "pro") == "Pro"


# ── parse_exported_config_or_throw (batch 2) ─────────────────────────────────


class TestParseExportedConfigOrThrow:
    @pytest.fixture
    def valid_config(self) -> dict[str, Any]:
        return {
            "version": "1.0.0",
            "exported_at": "2026-05-14T00:00:00Z",
            "tenant_id": "tenant_test",
            "environment_id": "default",
            "plans": [],
            "entitlements": [],
            "entitlement_rules": [],
            "segments": [],
            "content_ui_paths": [],
            "surface_templates": [],
        }

    def test_valid_passes(self, valid_config: dict[str, Any]) -> None:
        parsed = parse_exported_config_or_throw(valid_config, "test")
        assert parsed is not None
        assert parsed["artifact_type"] == "playbook"
        assert parsed["format_version"] == "1.0.0"
        assert "version" not in parsed

    def test_none_returns_none(self) -> None:
        assert parse_exported_config_or_throw(None, "test") is None

    def test_non_dict_raises(self) -> None:
        with pytest.raises(ValueError, match="expected top-level object"):
            parse_exported_config_or_throw("not-a-dict", "test")

    def test_missing_version_raises(self, valid_config: dict[str, Any]) -> None:
        del valid_config["version"]
        with pytest.raises(ValueError, match='unsupported legacy "version"'):
            parse_exported_config_or_throw(valid_config, "test")

    def test_non_string_version_raises(self, valid_config: dict[str, Any]) -> None:
        valid_config["version"] = 1
        with pytest.raises(ValueError, match='unsupported legacy "version"'):
            parse_exported_config_or_throw(valid_config, "test")

    def test_missing_exported_at_is_allowed(self, valid_config: dict[str, Any]) -> None:
        del valid_config["exported_at"]
        assert parse_exported_config_or_throw(valid_config, "test") is not None

    @pytest.mark.parametrize(
        "missing_field",
        [
            "plans",
            "entitlements",
            "entitlement_rules",
            "segments",
            "content_ui_paths",
        ],
    )
    def test_missing_array_field_raises(
        self, valid_config: dict[str, Any], missing_field: str
    ) -> None:
        valid_config[missing_field] = "not-a-list"
        with pytest.raises(ValueError, match=f'missing array "{missing_field}"'):
            parse_exported_config_or_throw(valid_config, "test")

    def test_source_name_in_error(self) -> None:
        with pytest.raises(ValueError, match="Invalid bootstrap-config"):
            parse_exported_config_or_throw("bad", "bootstrap-config")

    def test_canonical_playbook_passes(self, valid_config: dict[str, Any]) -> None:
        del valid_config["version"]
        valid_config.update(
            {
                "artifact_type": "playbook",
                "format_version": "1.0.0",
                "playbook_handle": "default",
                "playbook_version_id": None,
                "project_id": "project_test",
                "experiments": [],
            }
        )
        assert parse_exported_config_or_throw(valid_config, "test") == valid_config

    def test_future_canonical_version_rejects_without_legacy_fallback(
        self, valid_config: dict[str, Any]
    ) -> None:
        valid_config.update(
            {
                "artifact_type": "playbook",
                "format_version": "2.0.0",
            }
        )
        with pytest.raises(ValueError, match='unsupported "format_version"'):
            parse_exported_config_or_throw(valid_config, "test")

    def test_legacy_projection_warning(self, valid_config: dict[str, Any]) -> None:
        valid_config.update({"slot_configs": [], "content_overrides": {}})

        with pytest.warns(DeprecationWarning, match="slot_configs, content_overrides"):
            parse_exported_config_or_throw(valid_config, "test")


# ── placement_score / placement_priority / proximity_score / server_order ───


class TestPlacementScore:
    def test_root_score(self) -> None:
        assert placement_score({"score": 42}) == 42.0

    def test_root_ltv_propensity(self) -> None:
        assert placement_score({"ltv_propensity_score": 10}) == 10.0

    def test_content_score(self) -> None:
        assert placement_score({"content": {"score": 5}}) == 5.0

    def test_content_ranking_score(self) -> None:
        assert placement_score({"content": {"ranking_score": 7.5}}) == 7.5

    def test_root_wins_over_content(self) -> None:
        assert placement_score({"score": 1, "content": {"score": 99}}) == 1.0

    def test_no_score_returns_zero(self) -> None:
        assert placement_score({}) == 0
        assert placement_score({"content": {}}) == 0

    def test_non_dict_content_falls_through(self) -> None:
        assert placement_score({"content": "not-a-dict"}) == 0


class TestPlacementPriority:
    def test_root_priority(self) -> None:
        assert placement_priority({"priority": 5}) == 5.0

    def test_root_placement_priority(self) -> None:
        assert placement_priority({"placement_priority": 3}) == 3.0

    def test_content_priority(self) -> None:
        assert placement_priority({"content": {"priority": 2}}) == 2.0

    def test_no_priority_returns_zero(self) -> None:
        assert placement_priority({}) == 0


class TestProximityScore:
    def test_usage_percent(self) -> None:
        assert proximity_score({"content": {"usage_percent": 80}}) == 80.0

    def test_trial_percent_elapsed(self) -> None:
        assert proximity_score({"content": {"trial_percent_elapsed": 50}}) == 50.0

    def test_threshold_percent(self) -> None:
        assert proximity_score({"content": {"threshold_percent": 25}}) == 25.0

    def test_priority_order_usage_wins(self) -> None:
        output = {
            "content": {
                "usage_percent": 80,
                "trial_percent_elapsed": 50,
                "threshold_percent": 25,
            },
        }
        assert proximity_score(output) == 80.0

    def test_falls_back_to_placement_score(self) -> None:
        output = {"score": 11, "content": {}}
        assert proximity_score(output) == 11.0

    def test_no_proximity_no_score_returns_zero(self) -> None:
        assert proximity_score({}) == 0


class TestServerOrder:
    @pytest.mark.parametrize("key", ["server_order", "order", "rank", "order_index"])
    def test_root_keys(self, key: str) -> None:
        assert server_order({key: 7}) == 7.0

    @pytest.mark.parametrize("key", ["server_order", "order", "rank", "order_index"])
    def test_content_keys(self, key: str) -> None:
        assert server_order({"content": {key: 9}}) == 9.0

    def test_root_wins_over_content(self) -> None:
        assert server_order({"server_order": 1, "content": {"server_order": 99}}) == 1.0

    def test_no_order_returns_none(self) -> None:
        assert server_order({}) is None
        assert server_order({"content": {}}) is None


# ── milestone_version (batch 2) ──────────────────────────────────────────────


class TestMilestoneVersion:
    def test_template_version_string(self) -> None:
        assert milestone_version({"content": {"template_version": "v2"}}) == "v2"

    def test_template_version_numeric(self) -> None:
        assert milestone_version({"content": {"template_version": 3}}) == "3"

    def test_template_version_numeric_float(self) -> None:
        assert milestone_version({"content": {"template_version": 2.5}}) == "2.5"

    def test_falls_back_to_milestone_version(self) -> None:
        assert milestone_version({"content": {"milestone_version": "m1"}}) == "m1"

    def test_milestone_version_numeric(self) -> None:
        assert milestone_version({"content": {"milestone_version": 4}}) == "4"

    def test_template_version_wins_over_milestone(self) -> None:
        output = {"content": {"template_version": "tv", "milestone_version": "mv"}}
        assert milestone_version(output) == "tv"

    def test_whitespace_only_string_falls_through(self) -> None:
        assert milestone_version({"content": {"template_version": "   "}}) is None

    def test_no_version_returns_none(self) -> None:
        assert milestone_version({}) is None
        assert milestone_version({"content": {}}) is None


# ── superseded_versions (batch 2) ────────────────────────────────────────────


class TestSupersededVersions:
    def test_string_returns_single_element_list(self) -> None:
        output = {"content": {"supersedes_template_version": "v1"}}
        assert superseded_versions(output) == ["v1"]

    def test_numeric_stringified(self) -> None:
        output = {"content": {"supersedes_template_version": 1}}
        assert superseded_versions(output) == ["1"]

    def test_array_all_stringified(self) -> None:
        output = {"content": {"supersedes_template_version": ["v1", 2, "v3"]}}
        assert superseded_versions(output) == ["v1", "2", "v3"]

    def test_array_filters_non_conforming(self) -> None:
        output = {"content": {"supersedes_template_version": ["v1", None, "", "v2"]}}
        assert superseded_versions(output) == ["v1", "v2"]

    def test_no_value_returns_empty(self) -> None:
        assert superseded_versions({}) == []
        assert superseded_versions({"content": {}}) == []


# ── validate_trial_status_shape (batch 2) ────────────────────────────────────


class TestValidateTrialStatusShape:
    def test_non_dict_returns_default(self) -> None:
        assert validate_trial_status_shape(None) == {"in_trial": False}
        assert validate_trial_status_shape("string") == {"in_trial": False}
        assert validate_trial_status_shape([]) == {"in_trial": False}

    def test_minimal_valid(self) -> None:
        assert validate_trial_status_shape({"in_trial": True}) == {"in_trial": True}

    def test_in_trial_non_bool_defaults_to_false(self) -> None:
        assert validate_trial_status_shape({"in_trial": 1}) == {"in_trial": False}
        assert validate_trial_status_shape({"in_trial": "true"}) == {"in_trial": False}

    def test_full_shape(self) -> None:
        result = validate_trial_status_shape(
            {
                "in_trial": True,
                "trial_type": "premium",
                "plan_handle": "pro",
                "day_number": 3,
                "days_remaining": 11,
            },
        )
        assert result == {
            "in_trial": True,
            "trial_type": "premium",
            "plan_handle": "pro",
            "day_number": 3.0,
            "days_remaining": 11.0,
        }

    def test_optional_fields_dropped_when_wrong_type(self) -> None:
        result = validate_trial_status_shape(
            {
                "in_trial": True,
                "trial_type": 1,  # not a string
                "plan_handle": None,  # not a string
                "day_number": "3",  # not a number
                "days_remaining": True,  # bool — rejected
            },
        )
        assert result == {"in_trial": True}

    def test_partial_optional(self) -> None:
        result = validate_trial_status_shape({"in_trial": False, "trial_type": "extended"})
        assert result == {"in_trial": False, "trial_type": "extended"}


# ── recommend_next_plan_up (plan #46 TASK-4) ─────────────────────────────────


def _plan(
    handle: str,
    tier: int,
    sort: int = 0,
    source_id: str | None = None,
) -> dict[str, Any]:
    """Test fixture matching TS PlanIR shape."""
    return {
        "source_id": source_id or f"p_{handle}",
        "unique_handle": handle,
        "name": handle,
        "tier_position": tier,
        "sort_order": sort,
    }


class TestRecommendNextPlanUp:
    """Mirror of TS `recommendNextPlanUp` AC-3 tests + parity coverage."""

    def test_starter_to_pro(self) -> None:
        plans = [_plan("starter", 0), _plan("pro", 1), _plan("team", 2)]
        assert recommend_next_plan_up("starter", plans) == "pro"

    def test_pro_to_team(self) -> None:
        plans = [_plan("starter", 0), _plan("pro", 1), _plan("team", 2)]
        assert recommend_next_plan_up("pro", plans) == "team"

    def test_team_top_of_ladder_returns_none(self) -> None:
        plans = [_plan("starter", 0), _plan("pro", 1), _plan("team", 2)]
        assert recommend_next_plan_up("team", plans) is None

    def test_insertion_order_does_not_matter(self) -> None:
        shuffled = [_plan("team", 2), _plan("starter", 0), _plan("pro", 1)]
        assert recommend_next_plan_up("starter", shuffled) == "pro"
        assert recommend_next_plan_up("pro", shuffled) == "team"

    def test_sort_order_tiebreaker(self) -> None:
        # Same tier_position, lower sort_order wins.
        plans = [
            _plan("starter", 0),
            _plan("pro_b", 1, 1),
            _plan("pro_a", 1, 0),
            _plan("team", 3),
        ]
        assert recommend_next_plan_up("starter", plans) == "pro_a"
        assert recommend_next_plan_up("pro_a", plans) == "pro_b"
        assert recommend_next_plan_up("pro_b", plans) == "team"

    def test_source_id_tiebreaker(self) -> None:
        # All plans tier=1, sort=0; source_id ASC decides.
        plans = [
            _plan("starter", 0),
            _plan("z_plan", 1, 0, "p_z"),
            _plan("a_plan", 1, 0, "p_a"),
            _plan("m_plan", 1, 0, "p_m"),
        ]
        assert recommend_next_plan_up("starter", plans) == "a_plan"
        assert recommend_next_plan_up("a_plan", plans) == "m_plan"
        assert recommend_next_plan_up("m_plan", plans) == "z_plan"
        assert recommend_next_plan_up("z_plan", plans) is None

    def test_unknown_current_plan_returns_none(self) -> None:
        plans = [_plan("starter", 0), _plan("pro", 1)]
        assert recommend_next_plan_up("not_a_plan", plans) is None

    def test_empty_plans_returns_none(self) -> None:
        assert recommend_next_plan_up("starter", []) is None

    def test_empty_current_plan_handle_returns_none(self) -> None:
        plans = [_plan("starter", 0), _plan("pro", 1)]
        assert recommend_next_plan_up("", plans) is None

    def test_single_plan_returns_none(self) -> None:
        assert recommend_next_plan_up("only", [_plan("only", 0)]) is None
