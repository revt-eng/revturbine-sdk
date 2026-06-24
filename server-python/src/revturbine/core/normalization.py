"""Cross-domain normalization — Python port of @revt-eng/core/normalization.ts.

Pure wire-format → typed-shape normalizers shared across entitlements,
placements, and decisions. Kept standalone (no domain-to-domain imports),
mirroring the TS module's role.

Source: revturbine-scaffold/src/core/normalization.ts
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from revturbine.core.helpers import PlacementOutput, is_record

__all__ = ["VALID_SURFACE_TYPES", "normalize_placement_output"]

# Snapshot of ``SurfaceTypeSchema.options`` (resolved from the generated
# @revt-eng/schema at port time). TASK-7's vendoring of ``revturbine_types``
# replaces this hardcoded set with the generated enum; until then a drift
# in the schema's surface-type vocabulary would be caught by the parity
# suite (TASK-8/9/10).
VALID_SURFACE_TYPES: frozenset[str] = frozenset(
    {
        "banner",
        "modal",
        "tooltip",
        "sidebar",
        "inline",
        "toast",
        "fullscreen",
        "email",
        "sms",
        "push",
        "in_page",
        "button",
        "full_page",
        "agent",
        "cli",
        "custom",
    }
)


def normalize_placement_output(
    data: Any,
    generate_request_id: Callable[[], str],
) -> PlacementOutput | None:
    """Normalize a loose wire payload into a ``PlacementOutput`` dict.

    Returns ``None`` when ``data`` is not a dict or carries no
    ``output_id``. Unknown surface types collapse to ``"custom"``.
    ``cta_path`` falls back to ``ui_path`` then ``{}``; both keys are
    emitted pointing at the resolved value (mirrors the TS double-write).
    ``decision_id`` defaults to ``generate_request_id()`` when absent.

    Source: normalization.ts:18-52
    """
    if not is_record(data):
        return None
    output_id = data["output_id"] if isinstance(data.get("output_id"), str) else ""
    if not output_id:
        return None

    surface_raw = data["surface"] if is_record(data.get("surface")) else {}
    surface_type_raw = surface_raw.get("type")
    surface_type = (
        surface_type_raw
        if isinstance(surface_type_raw, str) and surface_type_raw in VALID_SURFACE_TYPES
        else "custom"
    )

    if is_record(data.get("cta_path")):
        cta_path: dict[str, Any] = data["cta_path"]
    elif is_record(data.get("ui_path")):
        cta_path = data["ui_path"]
    else:
        cta_path = {}

    surface: dict[str, Any] = {"type": surface_type}
    if isinstance(surface_raw.get("template"), str):
        surface["template"] = surface_raw["template"]
    if isinstance(surface_raw.get("slot_id"), str):
        surface["slot_id"] = surface_raw["slot_id"]

    result: PlacementOutput = {
        "output_id": output_id,
        "category": data["category"] if isinstance(data.get("category"), str) else "unknown",
        "surface": surface,
        "content": data["content"] if is_record(data.get("content")) else {},
        "cta_path": cta_path,
        "ui_path": cta_path,
        "rule_id": data["rule_id"] if isinstance(data.get("rule_id"), str) else "",
        "decision_id": (
            data["decision_id"]
            if isinstance(data.get("decision_id"), str)
            else generate_request_id()
        ),
        "config_version": (
            data["config_version"] if isinstance(data.get("config_version"), str) else "unknown"
        ),
        "present_upsell": (
            data["present_upsell"] if isinstance(data.get("present_upsell"), bool) else False
        ),
    }
    if is_record(data.get("promotion")):
        result["promotion"] = data["promotion"]
    return result
