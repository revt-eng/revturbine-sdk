"""Purchased allowances; port of scaffold's purchased-allowance.ts and validator."""

from __future__ import annotations

import math
import re
from typing import Any

from revturbine.core.entitlements.unlimited import resolve_limit_value

MAX_SAFE_INTEGER = 9007199254740991


def validate_purchased_addons(value: Any = None) -> list[dict[str, Any]]:
    """Validate and sanitize the current holdings, without guessing quantities."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("Invalid purchased add-ons: expected an array")
    holdings: list[dict[str, Any]] = []
    keys: set[tuple[str, str]] = set()
    aggregates: set[str] = set()
    variations: set[str] = set()
    for entry in value:
        if not isinstance(entry, dict):
            raise ValueError("Invalid purchased add-on handle or quantity")
        handle = entry.get("addon_handle")
        variation = entry.get("addon_variation_handle")
        quantity = entry.get("quantity")
        if (
            not isinstance(handle, str)
            or re.fullmatch(r"[a-z0-9._]{1,100}", handle) is None
            or (
                "addon_variation_handle" in entry
                and (
                    not isinstance(variation, str)
                    or re.fullmatch(r"[a-z0-9._]{1,100}", variation) is None
                )
            )
            or isinstance(quantity, bool)
            or not isinstance(quantity, (int, float))
            or not math.isfinite(quantity)
            or quantity < 0
            or quantity > MAX_SAFE_INTEGER
            or int(quantity) != quantity
        ):
            raise ValueError("Invalid purchased add-on handle or quantity")
        key = (handle, variation or "")
        if key in keys:
            raise ValueError(f"Duplicate purchased add-on holding: {handle}:{variation or ''}")
        keys.add(key)
        (aggregates if variation is None else variations).add(handle)
        if handle in aggregates and handle in variations:
            raise ValueError(f"Ambiguous purchased add-on aggregate and variation: {handle}")
        holding: dict[str, Any] = {"addon_handle": handle, "quantity": int(quantity)}
        if variation is not None:
            holding["addon_variation_handle"] = variation
        holdings.append(holding)
    return holdings


def allowance_period(
    kind: str, fields: dict[str, Any], billing_period: str | None = None
) -> str | None:
    """Normalize cadence without equating calendar periods and fixed durations."""
    if kind == "seat":
        return "seat"
    raw = fields.get("reset_period" if kind == "credits" else "period_scope")
    if raw in ("billing_period", "per_billing_period"):
        return {"monthly": "month", "annual": "year"}.get(billing_period or "")
    if not isinstance(raw, str) or not raw:
        return None
    if raw in ("per_6_hours", "six_hours"):
        return "six_hours"
    return raw.removeprefix("per_")


def assert_compatible_allowances(
    a: dict[str, Any],
    b: dict[str, Any],
    a_billing_period: str | None = None,
    b_billing_period: str | None = None,
) -> None:
    """Reject incompatible periods or scopes instead of dropping purchases."""
    af, bf = a["fields"], b["fields"]
    period = allowance_period(a["kind"], af, a_billing_period)
    if (
        a["kind"] != b["kind"]
        or period is None
        or period != allowance_period(b["kind"], bf, b_billing_period)
        or any(
            (af[field] if af.get(field) is not None else default)
            != (bf[field] if bf.get(field) is not None else default)
            for field, default in (
                ("allocation", "account"),
                ("instance", ""),
                ("seat_type_id", ""),
            )
        )
    ):
        raise ValueError(
            f"Incompatible purchased allowances: {a['ruleId']} and {b['ruleId']} "
            "require matching periods and scopes"
        )


def aggregate_purchased_allowance(
    baseline: dict[str, Any] | None,
    purchases: list[dict[str, Any]],
    baseline_billing_period: str | None = None,
) -> dict[str, Any] | None:
    """Add distinct purchased grants while retaining the baseline policy anchor."""
    anchor = baseline or (purchases[0]["rule"] if purchases else None)
    if anchor is None:
        return None
    field = {
        "seat": "included_count",
        "credits": "allowance_value",
        "usage_limit": "limit_value",
        "limit": "limit_value",
    }.get(anchor["kind"])
    if field is None or not purchases:
        return {"rule": anchor}
    recurring = [
        p
        for p in purchases
        if p["rule"]["kind"] != "credits" or "reset_period" in p["rule"]["fields"]
    ]
    if not recurring:
        return {"rule": baseline} if baseline else None
    policy = baseline or recurring[0]["rule"]
    period = baseline_billing_period if baseline else recurring[0].get("billingPeriod")

    def value_of(rule: dict[str, Any]) -> float:
        fields = rule["fields"]
        raw = fields.get(field, fields.get("allowance") if field == "allowance_value" else None)
        value = resolve_limit_value(raw)
        if value is None or value < 0:
            raise ValueError(f"Invalid allowance: {rule['ruleId']}")
        return value

    total = value_of(baseline) if baseline else 0.0
    handles = [baseline["ruleId"]] if baseline else []
    for purchase in recurring:
        rule = purchase["rule"]
        assert_compatible_allowances(policy, rule, period, purchase.get("billingPeriod"))
        value = value_of(rule)
        contribution = value * purchase["quantity"]
        if math.isfinite(value) and (
            not math.isfinite(contribution) or contribution > MAX_SAFE_INTEGER
        ):
            raise ValueError(f"Purchased allowance overflow: {rule['ruleId']}")
        total += contribution
        if math.isfinite(total) and total > MAX_SAFE_INTEGER:
            raise ValueError("Purchased allowance overflow")
        if rule["ruleId"] not in handles:
            handles.append(rule["ruleId"])
    return {"rule": policy, "effectiveAllowance": total, "contributingRuleHandles": handles}
