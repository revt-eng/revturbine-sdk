"""Unit tests for ``_build_json_content_provider`` (plan 234 TASK-4 / AC-3).

Until now the ``placement_content_linked_segment_override`` parity fixture
was this adapter's ONLY coverage, so a port bug and a fixture bug were
indistinguishable — a byte-diff told you the sides disagreed, not which
side (or whether the fixture) was wrong. These tests pin the Python port's
behaviour on its own, through the provider's public reads
(``list_payloads`` / ``get_message_block_by_id``), never the internal
lists. Expected values traced from local-resolver.ts
``buildJsonContentProvider``.
"""

from __future__ import annotations

from typing import Any, cast

from revturbine.core.placements.local_resolver import (
    LocalPlacementDataset,
    _build_json_content_provider,
)


def _placement(
    entry_id: str = "pl_1", *, payload_status: str = "active", template_id: str = "tpl_banner"
) -> dict[str, Any]:
    return {
        "id": entry_id,
        "payloads": [
            {
                "status": payload_status,
                "surfaces": [{"template_id": template_id}],
            }
        ],
    }


def _studio_payload(
    payload_id: str = "pp_1",
    *,
    placement_id: str = "pl_1",
    block_id: str | None = "blk_1",
    status: str = "active",
    **content_link_extra: Any,
) -> dict[str, Any]:
    p: dict[str, Any] = {
        "payload_id": payload_id,
        "placement_id": placement_id,
        "status": status,
    }
    if block_id is not None:
        p["content_link"] = {"message_block_id": block_id, **content_link_extra}
    return p


def _config(
    payloads: list[dict[str, Any]] | None, blocks: list[dict[str, Any]] | None
) -> dict[str, Any]:
    cfg: dict[str, Any] = {}
    if payloads is not None:
        cfg["placement_payloads"] = payloads
    if blocks is not None:
        cfg["message_blocks"] = blocks
    return cfg


BLOCKS = [{"block_id": "blk_1", "title": "Upgrade now"}]
DATASET = cast("LocalPlacementDataset", {"placements": [_placement()]})


class TestReturnsNone:
    """`None` means "keep the inline surface content" — every gate that
    yields it must be its own case, because a provider built from nothing
    would silently shadow inline content downstream."""

    def test_no_message_blocks(self) -> None:
        assert _build_json_content_provider(_config([_studio_payload()], None), DATASET) is None
        assert _build_json_content_provider(_config([_studio_payload()], []), DATASET) is None

    def test_no_studio_payloads(self) -> None:
        assert _build_json_content_provider(_config(None, BLOCKS), DATASET) is None
        assert _build_json_content_provider(_config([], BLOCKS), DATASET) is None

    def test_inline_payloads_only(self) -> None:
        # A payload without content_link is inline — nothing to adapt.
        cfg = _config([_studio_payload(block_id=None)], BLOCKS)
        assert _build_json_content_provider(cfg, DATASET) is None

    def test_linked_placement_has_no_payload_surface(self) -> None:
        # The surface_template_id is keyed off the placement's FIRST payload
        # surface (BL-0151: no status filter). A placement with no payload
        # surface at all maps no template, so the linked payload is dropped.
        dataset = cast("LocalPlacementDataset", {"placements": [{"id": "pl_1", "payloads": []}]})
        cfg = _config([_studio_payload()], BLOCKS)
        assert _build_json_content_provider(cfg, dataset) is None

    def test_link_to_unknown_placement(self) -> None:
        cfg = _config([_studio_payload(placement_id="pl_ghost")], BLOCKS)
        assert _build_json_content_provider(cfg, DATASET) is None


class TestBuildsProvider:
    def test_adapts_content_linked_payload_onto_the_placement_template(self) -> None:
        cfg = _config([_studio_payload(ui_path_id="uip_1", promotion_id="promo_1")], BLOCKS)
        provider = _build_json_content_provider(cfg, DATASET)
        assert provider is not None

        # The adapted payload is keyed by the LINKED placement's surface
        # template — that is what makes a list_payloads(template) lookup
        # match the selected candidate.
        listed = provider.list_payloads("tpl_banner")
        assert [p["payload_id"] for p in listed] == ["pp_1"]
        adapted = listed[0]
        assert adapted["surface_template_id"] == "tpl_banner"
        assert adapted["default_message_block_id"] == "blk_1"
        assert adapted["ui_path_id"] == "uip_1"
        assert adapted["promotion_id"] == "promo_1"
        assert adapted["status"] == "active"

        assert provider.list_payloads("tpl_other") == []
        block = provider.get_message_block_by_id("blk_1")
        assert block is not None and block["title"] == "Upgrade now"

    def test_authored_status_is_ignored(self) -> None:
        """BL-0151: presence in an exported config means released (plan 76).

        ``RevTurbineConfigPlacementPayloadItem`` has no ``status`` field, so
        reading one off the wire always fell to ``inactive`` and the
        content-lookup provider — which gates on its own ``status`` — dropped
        every content-linked payload. The adapter shape's status is now
        hardcoded ``active``, as in the TS port.
        """
        no_status = _studio_payload("pp_n")
        del no_status["status"]
        cfg = _config(
            [
                _studio_payload("pp_a", status="active"),
                _studio_payload("pp_d", status="draft"),
                _studio_payload("pp_x", status="archived"),
                no_status,
            ],
            BLOCKS,
        )
        provider = _build_json_content_provider(cfg, DATASET)
        assert provider is not None
        by_id = {p["payload_id"]: p["status"] for p in provider.list_payloads("tpl_banner")}
        assert by_id == {"pp_a": "active", "pp_d": "active", "pp_x": "active", "pp_n": "active"}
