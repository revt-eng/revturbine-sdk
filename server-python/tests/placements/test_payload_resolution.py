"""Tests for ``revturbine.core.placements.payload_resolution``.

Includes a pilot-corpus block (``TestPayloadPilotCorpus``) — hand-derived
expected outputs traced from
revturbine-scaffold/src/placements/controllers/payload-resolution.ts.
This extends the TASK-5 entitlement pilot (batch 1) into the
payload-resolution surface.
"""

from __future__ import annotations

from typing import Any

import pytest

from revturbine.core.placements.payload_resolution import (
    apply_value_maps,
    create_static_placement_content_lookup_provider,
    resolve_content,
    resolve_payload_for_user,
    resolve_payload_for_user_with_provider,
    resolve_tokens,
)

# ── resolve_tokens ──────────────────────────────────────────────────────────


class TestResolveTokens:
    def test_basic_substitution(self) -> None:
        assert resolve_tokens("Hello {{name}}", {"name": "Ada"}) == "Hello Ada"

    def test_whitespace_inside_braces(self) -> None:
        assert resolve_tokens("{{  name  }}", {"name": "x"}) == "x"

    def test_unknown_token_left_verbatim(self) -> None:
        assert resolve_tokens("Hi {{missing}}", {"name": "x"}) == "Hi {{missing}}"

    def test_alias_fallback(self) -> None:
        # current_usage → usage_current
        assert resolve_tokens("{{current_usage}}", {"usage_current": 42}) == "42"
        assert resolve_tokens("{{current_limit}}", {"usage_limit": 100}) == "100"
        assert resolve_tokens("{{remaining_usage}}", {"usage_remaining": 58}) == "58"

    def test_direct_key_wins_over_alias(self) -> None:
        ctx = {"current_usage": "direct", "usage_current": "aliased"}
        assert resolve_tokens("{{current_usage}}", ctx) == "direct"

    def test_js_string_coercion_null(self) -> None:
        # Explicit None present → JS String(null) → "null".
        assert resolve_tokens("{{k}}", {"k": None}) == "null"

    def test_js_string_coercion_bool(self) -> None:
        assert resolve_tokens("{{k}}", {"k": True}) == "true"
        assert resolve_tokens("{{k}}", {"k": False}) == "false"

    def test_js_string_coercion_integral_float(self) -> None:
        # JS String(5.0) === "5".
        assert resolve_tokens("{{k}}", {"k": 5.0}) == "5"

    def test_js_string_coercion_decimal_float(self) -> None:
        assert resolve_tokens("{{k}}", {"k": 1.5}) == "1.5"

    def test_js_string_coercion_int(self) -> None:
        assert resolve_tokens("{{k}}", {"k": 7}) == "7"

    def test_multiple_tokens_one_template(self) -> None:
        out = resolve_tokens(
            "{{a}}-{{b}}-{{a}}",
            {"a": "X", "b": "Y"},
        )
        assert out == "X-Y-X"

    def test_no_tokens_returns_template(self) -> None:
        assert resolve_tokens("plain text", {}) == "plain text"

    def test_alias_absent_falls_through(self) -> None:
        # current_usage with neither direct nor alias present.
        assert resolve_tokens("{{current_usage}}", {}) == "{{current_usage}}"


# ── resolve_content ─────────────────────────────────────────────────────────


class TestResolveContent:
    def test_resolves_string_fields_only(self) -> None:
        content = {
            "title": "Hi {{name}}",
            "count": 5,
            "flag": True,
            "nested": {"keep": "{{name}}"},
        }
        out = resolve_content(content, {"name": "Ada"})
        assert out["title"] == "Hi Ada"
        # Non-string values pass through untouched (including nested dicts).
        assert out["count"] == 5
        assert out["flag"] is True
        assert out["nested"] == {"keep": "{{name}}"}

    def test_empty_content(self) -> None:
        assert resolve_content({}, {"name": "x"}) == {}


# ── apply_value_maps ────────────────────────────────────────────────────────


class TestApplyValueMaps:
    def test_maps_matching_value(self) -> None:
        ctx = {"plan": "pro"}
        tokens = [{"token": "plan", "value_map": {"pro": "Professional"}}]
        assert apply_value_maps(ctx, tokens) == {"plan": "Professional"}

    def test_unmapped_value_unchanged(self) -> None:
        ctx = {"plan": "enterprise"}
        tokens = [{"token": "plan", "value_map": {"pro": "Professional"}}]
        assert apply_value_maps(ctx, tokens) == {"plan": "enterprise"}

    def test_none_value_skipped(self) -> None:
        ctx: dict[str, Any] = {"plan": None}
        tokens = [{"token": "plan", "value_map": {"pro": "Professional"}}]
        assert apply_value_maps(ctx, tokens) == {"plan": None}

    def test_token_without_value_map_skipped(self) -> None:
        ctx = {"plan": "pro"}
        tokens = [{"token": "plan"}]
        assert apply_value_maps(ctx, tokens) == {"plan": "pro"}

    def test_token_missing_name_skipped(self) -> None:
        ctx = {"plan": "pro"}
        tokens = [{"value_map": {"pro": "X"}}]
        assert apply_value_maps(ctx, tokens) == {"plan": "pro"}

    def test_boolean_value_js_stringified_for_map_key(self) -> None:
        # JS String(true) === "true" — the value_map key must be "true".
        ctx = {"flag": True}
        tokens = [{"token": "flag", "value_map": {"true": "ENABLED"}}]
        assert apply_value_maps(ctx, tokens) == {"flag": "ENABLED"}

    def test_does_not_mutate_input_context(self) -> None:
        ctx = {"plan": "pro"}
        tokens = [{"token": "plan", "value_map": {"pro": "Professional"}}]
        apply_value_maps(ctx, tokens)
        assert ctx == {"plan": "pro"}  # original unchanged


# ── create_static_placement_content_lookup_provider ─────────────────────────


class TestStaticLookupProvider:
    def test_list_payloads_filters_by_surface(self) -> None:
        provider = create_static_placement_content_lookup_provider(
            payloads=[
                {"surface_template_id": "banner", "id": "p1", "status": "active"},
                {"surface_template_id": "modal", "id": "p2", "status": "active"},
            ],
        )
        result = provider.list_payloads("banner")
        assert [p["id"] for p in result] == ["p1"]

    def test_get_message_block_by_id(self) -> None:
        provider = create_static_placement_content_lookup_provider(
            message_blocks=[{"block_id": "b1", "status": "active"}],
        )
        block = provider.get_message_block_by_id("b1")
        assert block is not None
        assert block["status"] == "active"
        assert provider.get_message_block_by_id("missing") is None

    def test_get_ui_path_by_id_or_name(self) -> None:
        provider = create_static_placement_content_lookup_provider(
            ui_paths=[{"id": "u1", "name": "checkout"}],
        )
        by_id = provider.get_ui_path_by_id("u1")
        by_name = provider.get_ui_path_by_id("checkout")
        assert by_id is not None and by_id["name"] == "checkout"
        assert by_name is not None and by_name["id"] == "u1"
        assert provider.get_ui_path_by_id("nope") is None

    def test_get_promotion_by_id_or_name(self) -> None:
        provider = create_static_placement_content_lookup_provider(
            promotions=[{"id": "pr1", "name": "summer"}],
        )
        by_id = provider.get_promotion_by_id("pr1")
        by_name = provider.get_promotion_by_id("summer")
        assert by_id is not None and by_id["name"] == "summer"
        assert by_name is not None and by_name["id"] == "pr1"
        assert provider.get_promotion_by_id("nope") is None

    def test_list_personalization_tokens(self) -> None:
        provider = create_static_placement_content_lookup_provider(
            tokens=[{"token": "x"}],
        )
        assert provider.list_personalization_tokens() == [{"token": "x"}]

    def test_empty_provider_defaults(self) -> None:
        provider = create_static_placement_content_lookup_provider()
        assert provider.list_payloads("any") == []
        assert provider.get_message_block_by_id("any") is None
        assert provider.list_personalization_tokens() == []


# ── resolve_payload_for_user ────────────────────────────────────────────────


def _payload(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "pay_1",
        "surface_template_id": "banner",
        "status": "active",
        "default_message_block_id": "blk_default",
    }
    base.update(over)
    return base


def _block(block_id: str, content: dict[str, Any], **over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "block_id": block_id,
        "status": "active",
        "default_content": content,
    }
    base.update(over)
    return base


class TestResolvePayloadForUser:
    def test_no_candidates_returns_none(self) -> None:
        assert resolve_payload_for_user("banner", {}, [], [], [], {}) is None

    def test_inactive_payload_filtered(self) -> None:
        result = resolve_payload_for_user(
            "banner",
            {},
            [_payload(status="draft")],
            [_block("blk_default", {"title": "X"})],
            [],
            {},
        )
        assert result is None

    def test_default_block_resolution(self) -> None:
        result = resolve_payload_for_user(
            "banner",
            {"segment_ids": []},
            [_payload()],
            [_block("blk_default", {"title": "Hello {{name}}"})],
            [],
            {"name": "Ada"},
        )
        assert result is not None
        assert result["resolved_content"]["title"] == "Hello Ada"
        assert "matched_segment_id" not in result

    def test_segment_content_map_flat_or(self) -> None:
        payload = _payload(
            segment_content_map=[
                {"segment_id": "seg_pro", "message_block_id": "blk_pro"},
            ],
        )
        result = resolve_payload_for_user(
            "banner",
            {"segment_ids": ["seg_pro"]},
            [payload],
            [
                _block("blk_default", {"title": "default"}),
                _block("blk_pro", {"title": "pro tier"}),
            ],
            [],
            {},
        )
        assert result is not None
        assert result["resolved_content"]["title"] == "pro tier"
        assert result["matched_segment_id"] == "seg_pro"

    def test_segment_override_merges_content(self) -> None:
        payload = _payload(
            segment_content_map=[
                {"segment_id": "seg_pro", "message_block_id": "blk_1"},
            ],
        )
        block = _block(
            "blk_1",
            {"title": "base", "cta": "Go"},
            segment_overrides=[
                {"segment_value_id": "seg_pro", "content": {"title": "overridden"}},
            ],
        )
        result = resolve_payload_for_user(
            "banner",
            {"segment_ids": ["seg_pro"]},
            [payload],
            [block],
            [],
            {},
        )
        assert result is not None
        # Override replaces title, keeps cta from default_content.
        assert result["resolved_content"]["title"] == "overridden"
        assert result["resolved_content"]["cta"] == "Go"

    def test_inactive_block_skips_payload(self) -> None:
        payload = _payload()
        result = resolve_payload_for_user(
            "banner",
            {},
            [payload],
            [_block("blk_default", {"title": "X"}, status="archived")],
            [],
            {},
        )
        assert result is None

    def test_cross_dimension_and_all_match(self) -> None:
        payload = _payload(
            segment_content_map=[
                {"segment_id": "geo_us", "message_block_id": "blk_us", "dimension": "geo"},
                {"segment_id": "plan_pro", "message_block_id": "blk_pro", "dimension": "plan"},
            ],
        )
        result = resolve_payload_for_user(
            "banner",
            {"segment_ids": ["geo_us", "plan_pro"]},
            [payload],
            [
                _block("blk_default", {"t": "d"}),
                _block("blk_us", {"t": "us"}),
                _block("blk_pro", {"t": "pro"}),
            ],
            [],
            {},
            {"segment_dimensions": {"geo": ["geo_us"], "plan": ["plan_pro"]}},
        )
        assert result is not None
        # First matched entry wins for the block.
        assert result["matched_segment_id"] == "geo_us"

    def test_cross_dimension_and_one_missing_skips(self) -> None:
        payload = _payload(
            segment_content_map=[
                {"segment_id": "geo_us", "message_block_id": "blk_us", "dimension": "geo"},
                {"segment_id": "plan_pro", "message_block_id": "blk_pro", "dimension": "plan"},
            ],
        )
        # User only in geo_us, not plan_pro → AND fails → payload skipped →
        # no further candidates → None.
        result = resolve_payload_for_user(
            "banner",
            {"segment_ids": ["geo_us"]},
            [payload],
            [_block("blk_us", {"t": "us"})],
            [],
            {},
            {"segment_dimensions": {"geo": ["geo_us"], "plan": ["plan_pro"]}},
        )
        assert result is None

    def test_value_map_applied_before_resolution(self) -> None:
        result = resolve_payload_for_user(
            "banner",
            {"segment_ids": []},
            [_payload()],
            [_block("blk_default", {"title": "Plan: {{plan}}"})],
            [{"token": "plan", "value_map": {"pro": "Professional"}}],
            {"plan": "pro"},
        )
        assert result is not None
        assert result["resolved_content"]["title"] == "Plan: Professional"


# ── resolve_payload_for_user_with_provider ──────────────────────────────────


class TestResolvePayloadWithProvider:
    def test_resolves_via_provider(self) -> None:
        provider = create_static_placement_content_lookup_provider(
            payloads=[_payload()],
            message_blocks=[_block("blk_default", {"title": "Hi {{name}}"})],
        )
        result = resolve_payload_for_user_with_provider(
            "banner",
            {"segment_ids": []},
            provider,
            {"name": "Bo"},
        )
        assert result is not None
        assert result["resolved_content"]["title"] == "Hi Bo"

    def test_ui_path_and_promotion_attached(self) -> None:
        payload = _payload(ui_path_id="u1", promotion_id="pr1")
        provider = create_static_placement_content_lookup_provider(
            payloads=[payload],
            message_blocks=[_block("blk_default", {"t": "x"})],
            ui_paths=[{"id": "u1", "name": "checkout"}],
            promotions=[{"id": "pr1", "name": "summer"}],
        )
        result = resolve_payload_for_user_with_provider(
            "banner",
            {"segment_ids": []},
            provider,
            {},
        )
        assert result is not None
        assert result["ui_path"]["name"] == "checkout"
        assert result["promotion"]["name"] == "summer"

    def test_no_active_payloads_returns_none(self) -> None:
        provider = create_static_placement_content_lookup_provider(
            payloads=[_payload(status="draft")],
        )
        assert resolve_payload_for_user_with_provider("banner", {}, provider, {}) is None

    def test_explicit_tokens_override_provider_tokens(self) -> None:
        provider = create_static_placement_content_lookup_provider(
            payloads=[_payload()],
            message_blocks=[_block("blk_default", {"t": "Plan {{plan}}"})],
            tokens=[{"token": "plan", "value_map": {"pro": "ProviderName"}}],
        )
        result = resolve_payload_for_user_with_provider(
            "banner",
            {"segment_ids": []},
            provider,
            {"plan": "pro"},
            explicit_tokens=[{"token": "plan", "value_map": {"pro": "ExplicitName"}}],
        )
        assert result is not None
        assert result["resolved_content"]["t"] == "Plan ExplicitName"

    def test_segment_match_via_provider(self) -> None:
        payload = _payload(
            segment_content_map=[
                {"segment_id": "seg_a", "message_block_id": "blk_a"},
            ],
        )
        provider = create_static_placement_content_lookup_provider(
            payloads=[payload],
            message_blocks=[
                _block("blk_default", {"t": "default"}),
                _block("blk_a", {"t": "segment-a"}),
            ],
        )
        result = resolve_payload_for_user_with_provider(
            "banner",
            {"segment_ids": ["seg_a"]},
            provider,
            {},
        )
        assert result is not None
        assert result["resolved_content"]["t"] == "segment-a"
        assert result["matched_segment_id"] == "seg_a"


# ── Pilot corpus (payload-resolution surface) ───────────────────────────────


class TestPayloadPilotCorpus:
    """10 hand-derived fixtures for the payload-resolution surface,
    extending the TASK-5 batch-1 entitlement pilot. Each expected value
    is traced from payload-resolution.ts.
    """

    _FIXTURES: list[tuple[str, str, dict[str, Any], str]] = [
        ("plain", "no tokens here", {}, "no tokens here"),
        ("single", "{{a}}", {"a": "X"}, "X"),
        ("spaced", "{{ a }}", {"a": "X"}, "X"),
        ("missing_verbatim", "{{x}}", {}, "{{x}}"),
        ("alias", "{{current_usage}}", {"usage_current": 9}, "9"),
        ("null_value", "{{n}}", {"n": None}, "null"),
        ("bool_true", "{{b}}", {"b": True}, "true"),
        ("bool_false", "{{b}}", {"b": False}, "false"),
        ("integral_float", "{{f}}", {"f": 3.0}, "3"),
        ("repeated", "{{a}}{{a}}", {"a": "Z"}, "ZZ"),
    ]

    @pytest.mark.parametrize(
        ("template", "context", "expected"),
        [(t[1], t[2], t[3]) for t in _FIXTURES],
        ids=[t[0] for t in _FIXTURES],
    )
    def test_resolve_tokens_pilot(
        self,
        template: str,
        context: dict[str, Any],
        expected: str,
    ) -> None:
        assert resolve_tokens(template, context) == expected

    def test_corpus_has_ten_fixtures(self) -> None:
        assert len(self._FIXTURES) == 10


# ── Branch coverage for ui_path/promotion propagation ───────────────────────


class TestUiPathPromotionPropagation:
    def test_flat_or_entry_carries_ui_path_and_promotion(self) -> None:
        payload = _payload(
            segment_content_map=[
                {
                    "segment_id": "seg_a",
                    "message_block_id": "blk_a",
                    "ui_path_id": "u_seg",
                    "promotion_id": "pr_seg",
                },
            ],
        )
        result = resolve_payload_for_user(
            "banner",
            {"segment_ids": ["seg_a"]},
            [payload],
            [_block("blk_a", {"t": "x"})],
            [],
            {},
        )
        assert result is not None
        assert result["ui_path_id"] == "u_seg"
        assert result["promotion_id"] == "pr_seg"

    def test_cross_dimension_match_carries_ui_path_and_promotion(self) -> None:
        payload = _payload(
            segment_content_map=[
                {
                    "segment_id": "geo_us",
                    "message_block_id": "blk_us",
                    "dimension": "geo",
                    "ui_path_id": "u_geo",
                    "promotion_id": "pr_geo",
                },
            ],
        )
        result = resolve_payload_for_user(
            "banner",
            {"segment_ids": ["geo_us"]},
            [payload],
            [_block("blk_us", {"t": "x"})],
            [],
            {},
            {"segment_dimensions": {"geo": ["geo_us"]}},
        )
        assert result is not None
        assert result["ui_path_id"] == "u_geo"
        assert result["promotion_id"] == "pr_geo"

    def test_segment_dimensions_set_but_entries_lack_dimension_falls_back(self) -> None:
        # options.segment_dimensions provided, but the entries have no
        # `dimension` key → entries_by_dimension is empty → flat-OR fallback.
        payload = _payload(
            segment_content_map=[
                {"segment_id": "seg_a", "message_block_id": "blk_a"},
            ],
        )
        result = resolve_payload_for_user(
            "banner",
            {"segment_ids": ["seg_a"]},
            [payload],
            [_block("blk_a", {"t": "fallback"})],
            [],
            {},
            {"segment_dimensions": {"geo": ["geo_us"]}},
        )
        assert result is not None
        assert result["resolved_content"]["t"] == "fallback"
        assert result["matched_segment_id"] == "seg_a"

    def test_with_provider_payload_level_ui_path_promotion(self) -> None:
        payload = _payload(ui_path_id="u_pay", promotion_id="pr_pay")
        provider = create_static_placement_content_lookup_provider(
            payloads=[payload],
            message_blocks=[_block("blk_default", {"t": "x"})],
            ui_paths=[{"id": "u_pay", "name": "pay-path"}],
            promotions=[{"id": "pr_pay", "name": "pay-promo"}],
        )
        result = resolve_payload_for_user_with_provider(
            "banner",
            {"segment_ids": []},
            provider,
            {},
        )
        assert result is not None
        assert result["ui_path"]["name"] == "pay-path"
        assert result["promotion"]["name"] == "pay-promo"

    def test_with_provider_segment_entry_ui_path_promotion(self) -> None:
        payload = _payload(
            segment_content_map=[
                {
                    "segment_id": "seg_a",
                    "message_block_id": "blk_a",
                    "ui_path_id": "u_seg",
                    "promotion_id": "pr_seg",
                },
            ],
        )
        provider = create_static_placement_content_lookup_provider(
            payloads=[payload],
            message_blocks=[_block("blk_a", {"t": "x"})],
            ui_paths=[{"id": "u_seg", "name": "seg-path"}],
            promotions=[{"id": "pr_seg", "name": "seg-promo"}],
        )
        result = resolve_payload_for_user_with_provider(
            "banner",
            {"segment_ids": ["seg_a"]},
            provider,
            {},
        )
        assert result is not None
        assert result["ui_path_id"] == "u_seg"
        assert result["promotion_id"] == "pr_seg"
        assert result["ui_path"]["name"] == "seg-path"
        assert result["promotion"]["name"] == "seg-promo"

    def test_with_provider_inactive_block_skips(self) -> None:
        provider = create_static_placement_content_lookup_provider(
            payloads=[_payload()],
            message_blocks=[_block("blk_default", {"t": "x"}, status="archived")],
        )
        assert resolve_payload_for_user_with_provider("banner", {}, provider, {}) is None

    def test_with_provider_missing_block_skips(self) -> None:
        # default_message_block_id points at a block the provider lacks.
        provider = create_static_placement_content_lookup_provider(
            payloads=[_payload(default_message_block_id="nope")],
            message_blocks=[],
        )
        assert resolve_payload_for_user_with_provider("banner", {}, provider, {}) is None

    def test_no_dimension_fallback_entry_carries_ui_path_promotion(self) -> None:
        # segment_dimensions set, but entries lack `dimension` →
        # no-metadata fallback loop; matched entry carries ui_path/promotion.
        payload = _payload(
            segment_content_map=[
                {
                    "segment_id": "seg_a",
                    "message_block_id": "blk_a",
                    "ui_path_id": "u_fb",
                    "promotion_id": "pr_fb",
                },
            ],
        )
        result = resolve_payload_for_user(
            "banner",
            {"segment_ids": ["seg_a"]},
            [payload],
            [_block("blk_a", {"t": "x"})],
            [],
            {},
            {"segment_dimensions": {"geo": ["geo_us"]}},
        )
        assert result is not None
        assert result["ui_path_id"] == "u_fb"
        assert result["promotion_id"] == "pr_fb"
