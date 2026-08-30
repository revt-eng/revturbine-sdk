"""Pure plan and add-on variation eligibility (Plan 161)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from revturbine.core.entitlements.segment_matching import matches_rule_segments

_CURRENCY_SYMBOLS = {"usd": "$", "eur": "€", "gbp": "£", "jpy": "¥", "krw": "₩"}
_ZERO_DECIMAL_CURRENCIES = {"jpy", "krw"}


def format_currency_minor_units(amount: int, currency: str, locale: str = "en-US") -> str:
    """Deterministic parity formatter for the SDK's supported fixture locales."""
    normalized = currency.lower()
    digits = 0 if normalized in _ZERO_DECIMAL_CURRENCIES else 2
    major = amount / (10**digits)
    number = f"{major:,.{digits}f}"
    symbol = _CURRENCY_SYMBOLS.get(normalized)
    if locale == "en-US" and symbol:
        return f"{symbol}{number}"
    return f"{normalized.upper()} {number}"


def _matching_variations(
    variations: Sequence[Mapping[str, Any]],
    segment_ids: set[str],
    segment_dimensions: Mapping[str, str],
) -> list[Mapping[str, Any]]:
    matching = [
        variation
        for variation in variations
        if variation.get("visibility") == "public"
        and matches_rule_segments(
            [] if variation.get("segment_handle") is None else [variation["segment_handle"]],
            segment_ids,
            segment_dimensions,
        )
    ]
    specific = [item for item in matching if item.get("segment_handle") is not None]
    return specific or [item for item in matching if item.get("segment_handle") is None]


def _price(variation: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "price": variation["price_amount"],
        "currency": variation["currency"],
        "pricing_model": variation["pricing_model"],
        "billing_period": variation["billing_period"],
    }


def get_eligible_plans(
    plans: Sequence[Mapping[str, Any]],
    variations: Sequence[Mapping[str, Any]],
    *,
    segment_ids: Sequence[str] = (),
    segment_dimensions: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Return public, segment-eligible plan variations deterministically."""

    context_ids = set(segment_ids)
    dimensions = segment_dimensions or {}
    result: list[dict[str, Any]] = []
    for plan in plans:
        if plan.get("visibility") != "public":
            continue
        candidates = [
            item for item in variations if item.get("plan_handle") == plan.get("unique_handle")
        ]
        for variation in _matching_variations(candidates, context_ids, dimensions):
            result.append(
                {
                    "handle": plan["unique_handle"],
                    "name": plan["name"],
                    "tier_position": plan["tier_position"],
                    "sort_order": plan["sort_order"],
                    "variation_handle": variation["handle"],
                    "segment_handle": variation.get("segment_handle"),
                    "price": _price(variation),
                }
            )
    return sorted(
        result,
        key=lambda item: (
            item["tier_position"],
            item["sort_order"],
            item["handle"],
            item["variation_handle"],
        ),
    )


def get_eligible_addons(
    addons: Sequence[Mapping[str, Any]],
    variations: Sequence[Mapping[str, Any]],
    *,
    segment_ids: Sequence[str] = (),
    segment_dimensions: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Return public, segment-eligible add-on variations deterministically."""

    context_ids = set(segment_ids)
    dimensions = segment_dimensions or {}
    result: list[dict[str, Any]] = []
    for addon in addons:
        if addon.get("visibility") != "public":
            continue
        candidates = [
            item for item in variations if item.get("addon_handle") == addon.get("unique_handle")
        ]
        for variation in _matching_variations(candidates, context_ids, dimensions):
            result.append(
                {
                    "handle": addon["unique_handle"],
                    "name": addon["name"],
                    "sort_order": addon["sort_order"],
                    "variation_handle": variation["handle"],
                    "segment_handle": variation.get("segment_handle"),
                    "price": _price(variation),
                }
            )
    return sorted(
        result,
        key=lambda item: (item["sort_order"], item["handle"], item["variation_handle"]),
    )
