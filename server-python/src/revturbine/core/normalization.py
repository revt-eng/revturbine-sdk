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
    from revturbine.core.cta_resolution import project_compatibility, resolve_ctas

    raw_ctas = data.get("ctas")
    if isinstance(raw_ctas, list) and raw_ctas:
        ctas = []
        for cta in raw_ctas:
            if not is_record(cta):
                continue
            normalized = {
                "label": cta["label"] if isinstance(cta.get("label"), str) else "",
                "path": cta["path"] if is_record(cta.get("path")) else {},
                "role_overridden": cta.get("role_overridden") is True,
                "emphasis": cta.get("emphasis")
                if cta.get("emphasis") in ("primary", "secondary", "link")
                else "secondary",
            }
            if isinstance(cta.get("role"), str):
                normalized["role"] = cta["role"]
            ctas.append(normalized)
        compat = project_compatibility(ctas)
        result["cta_path"] = result["ui_path"] = compat.get("cta_path", {})
        result["content"] = dict(result["content"])
        for key in ("cta_label", "secondary_cta_label"):
            if compat.get(key):
                result["content"][key] = compat[key]
        result["ctas"] = ctas
    else:
        content = result["content"]
        label = content.get("cta_label")
        if isinstance(label, str) and label:
            authored = [{"label": label, "path": cta_path.get("type", "dismiss")}]
            secondary = content.get("secondary_cta_label")
            if isinstance(secondary, str) and secondary:
                authored.append({"label": secondary, "path": "dismiss"})
            ctas = resolve_ctas(authored, surface_raw.get("template"), [])
            ctas[0]["path"] = cta_path or {"type": "dismiss"}
            result["ctas"] = ctas
    return result
