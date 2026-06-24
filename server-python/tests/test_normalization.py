"""Tests for ``revturbine.core.normalization``."""

from __future__ import annotations

from typing import Any

from revturbine.core.normalization import (
    VALID_SURFACE_TYPES,
    normalize_placement_output,
)


def _rid() -> str:
    return "generated-rid"


class TestNormalizePlacementOutput:
    def test_non_dict_returns_none(self) -> None:
        assert normalize_placement_output("nope", _rid) is None
        assert normalize_placement_output(None, _rid) is None
        assert normalize_placement_output([1], _rid) is None

    def test_missing_output_id_returns_none(self) -> None:
        assert normalize_placement_output({"surface": {"type": "banner"}}, _rid) is None

    def test_non_string_output_id_returns_none(self) -> None:
        assert normalize_placement_output({"output_id": 123}, _rid) is None

    def test_minimal_valid(self) -> None:
        result = normalize_placement_output({"output_id": "o1"}, _rid)
        assert result is not None
        assert result["output_id"] == "o1"
        assert result["category"] == "unknown"
        assert result["surface"] == {"type": "custom"}
        assert result["content"] == {}
        assert result["cta_path"] == {}
        assert result["ui_path"] == {}
        assert result["rule_id"] == ""
        assert result["decision_id"] == "generated-rid"
        assert result["config_version"] == "unknown"
        assert result["present_upsell"] is False
        assert "promotion" not in result

    def test_known_surface_type_preserved(self) -> None:
        result = normalize_placement_output(
            {"output_id": "o", "surface": {"type": "modal", "template": "m1", "slot_id": "s1"}},
            _rid,
        )
        assert result is not None
        assert result["surface"] == {"type": "modal", "template": "m1", "slot_id": "s1"}

    def test_unknown_surface_type_collapses_to_custom(self) -> None:
        result = normalize_placement_output(
            {"output_id": "o", "surface": {"type": "definitely-not-real"}},
            _rid,
        )
        assert result is not None
        assert result["surface"]["type"] == "custom"

    def test_cta_path_falls_back_to_ui_path(self) -> None:
        result = normalize_placement_output(
            {"output_id": "o", "ui_path": {"type": "navigate", "path": "/x"}},
            _rid,
        )
        assert result is not None
        # Both cta_path and ui_path point at the resolved value.
        assert result["cta_path"] == {"type": "navigate", "path": "/x"}
        assert result["ui_path"] == {"type": "navigate", "path": "/x"}

    def test_cta_path_wins_over_ui_path(self) -> None:
        result = normalize_placement_output(
            {
                "output_id": "o",
                "cta_path": {"a": 1},
                "ui_path": {"b": 2},
            },
            _rid,
        )
        assert result is not None
        assert result["cta_path"] == {"a": 1}
        assert result["ui_path"] == {"a": 1}

    def test_decision_id_preserved_when_present(self) -> None:
        result = normalize_placement_output(
            {"output_id": "o", "decision_id": "d-explicit"},
            _rid,
        )
        assert result is not None
        assert result["decision_id"] == "d-explicit"

    def test_promotion_attached_only_when_record(self) -> None:
        with_promo = normalize_placement_output(
            {"output_id": "o", "promotion": {"id": "pr1"}},
            _rid,
        )
        assert with_promo is not None
        assert with_promo["promotion"] == {"id": "pr1"}

        non_record_promo = normalize_placement_output(
            {"output_id": "o", "promotion": "not-a-dict"},
            _rid,
        )
        assert non_record_promo is not None
        assert "promotion" not in non_record_promo

    def test_all_fields_passthrough(self) -> None:
        data: dict[str, Any] = {
            "output_id": "o",
            "category": "trial",
            "surface": {"type": "toast", "template": "t", "slot_id": "s"},
            "content": {"k": "v"},
            "cta_path": {"type": "navigate"},
            "rule_id": "r1",
            "decision_id": "d1",
            "config_version": "v9",
            "present_upsell": True,
            "promotion": {"p": 1},
        }
        result = normalize_placement_output(data, _rid)
        assert result is not None
        assert result["category"] == "trial"
        assert result["present_upsell"] is True
        assert result["config_version"] == "v9"
        assert result["rule_id"] == "r1"

    def test_valid_surface_types_snapshot(self) -> None:
        # Guards against accidental edits to the hardcoded snapshot.
        assert "banner" in VALID_SURFACE_TYPES
        assert "custom" in VALID_SURFACE_TYPES
        assert "full_page" in VALID_SURFACE_TYPES
        assert len(VALID_SURFACE_TYPES) == 16
