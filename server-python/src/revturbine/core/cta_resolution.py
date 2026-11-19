"""Port of core/cta-resolution.ts: authored CTAs and compatibility projection."""

from typing import Any

from revturbine.core.helpers import is_record

DEFAULT_ROLES = {
    "open_checkout": "purchase",
    "view_plans": "learn_more",
    "book_demo": "contact",
    "contact_sales": "contact",
    "complete_onboarding": "engage",
    "invite_teammate": "engage",
    "refer_friend": "engage",
    "verify_work_email": "engage",
    "extend_trial": "engage",
    "update_payment_method": "continue",
    "manage_subscription": "continue",
    "enable_auto_renewal": "manage",
    "switch_billing_period": "manage",
    "open_rt_placement": "learn_more",
    "snooze": "snooze",
}
ACTION_PATHS = {
    "open_checkout_modal": "open_checkout",
    "navigate_to_plans": "view_plans",
    "open_placement": "open_rt_placement",
}


def _normalize_cta_path(cta: Any) -> dict[str, Any]:
    """Map a raw CTA ``{path, config}`` to the resolved ``cta_path``
    shape. ``plan_handle`` / ``placement_handle`` are omitted (not set
    to ``None``) when the source config field isn't a string — this
    matches JS ``JSON.stringify`` dropping ``undefined`` properties so
    serialized parity holds.

    Source: local-resolver.ts:81-118
    """
    if not is_record(cta) or not cta.get("path"):
        return {"type": "dismiss"}

    raw_path = cta["path"]
    config = cta.get("config")
    if not is_record(config):
        config = {}

    if raw_path == "open_checkout":
        # BUG-1192: the CTA type is delivered exactly as authored.
        result: dict[str, Any] = {"type": "open_checkout"}
        purchase = config.get("purchase")
        if isinstance(purchase, str):
            result["plan_handle"] = purchase
        return result

    if raw_path == "view_plans":
        return {"type": "view_plans"}

    if raw_path == "open_rt_placement":
        rt_result: dict[str, Any] = {"type": "open_rt_placement"}
        placement_handle = config.get("placement_handle")
        if isinstance(placement_handle, str):
            rt_result["placement_handle"] = placement_handle
        return rt_result

    # Custom and any other unmapped action: pass the authored action name
    # through as ``type`` and spread its config so a custom CTA's params reach
    # the SDK resolver. Mirrors local-resolver.ts.
    return {"type": raw_path, **config}


def _read_authored(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("label"), str):
        return None
    result = {"label": raw["label"]}
    for key in ("path", "role", "emphasis"):
        if isinstance(raw.get(key), str) and raw[key]:
            result[key] = raw[key]
    if isinstance(raw.get("config"), dict):
        result["config"] = raw["config"]
    return result


def authored_surface_ctas(surface: dict[str, Any]) -> list[dict[str, Any]]:
    """Read valid authored rows, falling back to the legacy primary label."""
    rows = surface.get("ctas")
    if isinstance(rows, list) and rows:
        return [entry for row in rows if (entry := _read_authored(row)) is not None]
    fields = surface.get("fields")
    label = fields.get("cta_label") if isinstance(fields, dict) else None
    return [{"label": label}] if isinstance(label, str) and label else []


def resolve_ctas(
    authored: list[dict[str, Any]], component: str | None, ui_paths: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Resolve roles and emphasis in authored order, bounded to five rows."""
    capped = authored[:5]
    primary_taken = any(c.get("emphasis") == "primary" for c in capped)
    result = []
    for cta in capped:
        path = cta.get("path") or "dismiss"
        inherited = None
        if path == "custom":
            handle = (cta.get("config") or {}).get("handle")
            definition = next((p for p in ui_paths if handle and p.get("name") == handle), None)
            if definition:
                inherited = definition.get("role") or None
                action = definition.get("action_type")
                path = ACTION_PATHS.get(action, action) if isinstance(action, str) else "custom"
        if inherited is None:
            inherited = (
                ("dismiss" if component in ("banner", "toast") else "not_now")
                if path == "dismiss"
                else DEFAULT_ROLES.get(path)
            )
        role = cta.get("role") or inherited
        emphasis = cta.get("emphasis")
        if emphasis not in ("primary", "secondary", "link"):
            if role in ("dismiss", "not_now", "snooze"):
                emphasis = "link"
            elif not primary_taken:
                emphasis = "primary"
                primary_taken = True
            else:
                emphasis = "secondary"
        resolved = {
            "label": cta["label"],
            "path": _normalize_cta_path(cta),
            "role_overridden": bool(cta.get("role") and cta["role"] != inherited),
            "emphasis": emphasis,
        }
        if role:
            resolved["role"] = role
        result.append(resolved)
    return result


def project_compatibility(ctas: list[dict[str, Any]]) -> dict[str, Any]:
    """Project the primary path/label and second authored label for old clients."""
    if not ctas:
        return {}
    primary = next((c for c in ctas if c["emphasis"] == "primary"), ctas[0])
    result = {"cta_path": primary["path"], "cta_label": primary["label"]}
    if len(ctas) > 1:
        result["secondary_cta_label"] = ctas[1]["label"]
    return result


def overlay_ctas(base: list[dict[str, Any]], content: dict[str, Any]) -> list[dict[str, Any]]:
    """Overlay block labels/roles/emphasis without changing surface paths."""
    result = [dict(c) for c in base]
    rows = content.get("ctas")
    if not isinstance(rows, list) or not rows:
        rows = [{"label": content.get("cta_label")}, {"label": content.get("secondary_cta_label")}]
    for index, raw in enumerate(rows):
        entry = _read_authored(raw)
        if entry is None:
            continue
        patch: dict[str, Any] = {k: entry[k] for k in ("label", "role", "emphasis") if k in entry}
        if index < len(result):
            result[index].update(patch)
        elif index == len(result):
            result.append(patch)
    return result
