from __future__ import annotations

from typing import Any

from revturbine import RevTurbineCustomerSdk


def _config() -> dict[str, Any]:
    return {
        "version": "1.0.0",
        "plans": [
            {
                "unique_handle": "free",
                "name": "Free",
                "tier_position": 0,
                "sort_order": 0,
                "visibility": "public",
            },
            {
                "unique_handle": "pro",
                "name": "Pro",
                "tier_position": 1,
                "sort_order": 0,
                "visibility": "public",
            },
        ],
        "addons": [
            {
                "unique_handle": "support",
                "name": "Support",
                "sort_order": 0,
                "visibility": "public",
            },
        ],
        "plan_variations": [
            {
                "handle": "free_default",
                "plan_handle": "free",
                "billing_period": "monthly",
                "segment_handle": None,
                "price_amount": 0,
                "currency": "usd",
                "pricing_model": "flat",
                "visibility": "public",
                "stripe_price_id": None,
                "price_source": "static",
            },
            {
                "handle": "pro_default",
                "plan_handle": "pro",
                "billing_period": "monthly",
                "segment_handle": None,
                "price_amount": 4900,
                "currency": "usd",
                "pricing_model": "flat",
                "visibility": "public",
                "stripe_price_id": None,
                "price_source": "static",
            },
            {
                "handle": "pro_startup",
                "plan_handle": "pro",
                "billing_period": "monthly",
                "segment_handle": "startup",
                "price_amount": 2900,
                "currency": "usd",
                "pricing_model": "flat",
                "visibility": "public",
                "stripe_price_id": None,
                "price_source": "static",
            },
        ],
        "addon_variations": [
            {
                "handle": "support_default",
                "addon_handle": "support",
                "billing_period": "monthly",
                "segment_handle": None,
                "price_amount": 1000,
                "currency": "usd",
                "pricing_model": "flat",
                "visibility": "public",
                "stripe_price_id": None,
                "price_source": "static",
            },
        ],
        "entitlements": [],
        "entitlement_rules": [],
        "segments": [
            {"handle": "startup", "name": "Startup", "dimension_id": "stage", "predicates": []}
        ],
        "content_ui_paths": [],
        "surface_templates": [],
        "placements": [],
    }


def test_public_catalog_methods_apply_specificity() -> None:
    sdk = RevTurbineCustomerSdk(
        user_context={"tenant_id": "tenant", "user_id": "user", "segment_ids": ["startup"]},
        exported_config=_config(),
    )
    assert [item["variation_handle"] for item in sdk.get_eligible_plans()] == [
        "free_default",
        "pro_startup",
    ]
    assert sdk.get_eligible_plans()[1]["price"] == {
        "price": 2900,
        "currency": "usd",
        "pricing_model": "flat",
        "billing_period": "monthly",
    }
    assert sdk.get_eligible_addons()[0]["variation_handle"] == "support_default"
