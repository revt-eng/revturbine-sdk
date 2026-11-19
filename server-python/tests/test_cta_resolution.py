"""Semantic CTA coverage beyond the legacy two-button corpus."""

from revturbine.core.cta_resolution import overlay_ctas, project_compatibility, resolve_ctas
from revturbine.core.normalization import normalize_placement_output


def test_custom_inheritance_overrides_and_authored_primary() -> None:
    ctas = resolve_ctas(
        [
            {"label": "Later", "path": "dismiss"},
            {"label": "Buy", "path": "open_checkout", "role": "upgrade"},
            {"label": "Help", "path": "custom", "config": {"handle": "help"}},
            {"label": "Continue", "path": "manage_subscription", "emphasis": "primary"},
            {"label": "More", "path": "custom", "config": {"handle": "plans"}},
            {"label": "Ignored", "path": "view_plans"},
        ],
        "modal",
        [
            {"name": "help", "role": "account_help"},
            {"name": "plans", "action_type": "navigate_to_plans"},
        ],
    )
    assert [c["role"] for c in ctas] == [
        "not_now",
        "upgrade",
        "account_help",
        "continue",
        "learn_more",
    ]
    assert [c["role_overridden"] for c in ctas] == [False, True, False, False, False]
    assert [c["emphasis"] for c in ctas] == [
        "link",
        "secondary",
        "secondary",
        "primary",
        "secondary",
    ]
    assert project_compatibility(ctas) == {
        "cta_path": {"type": "manage_subscription"},
        "cta_label": "Continue",
        "secondary_cta_label": "Buy",
    }


def test_message_block_overlays_semantics_but_keeps_surface_paths() -> None:
    base = [{"label": "Buy", "path": "open_checkout", "config": {"purchase": "pro"}}]
    authored = overlay_ctas(
        base,
        {
            "ctas": [{"label": "Proceed", "role": "continue"}, {"label": "Later"}],
            "cta_label": "Ignored",
        },
    )
    ctas = resolve_ctas(authored, "banner", [])
    assert ctas[0]["path"] == {"type": "open_checkout", "plan_handle": "pro"}
    assert ctas[0]["role"] == "continue"
    assert ctas[0]["role_overridden"] is True
    assert ctas[1]["path"] == {"type": "dismiss"}
    assert ctas[1]["role"] == "dismiss"
    assert base[0]["label"] == "Buy"


def test_normalization_projects_primary_and_preserves_legacy_paths() -> None:
    normalized = normalize_placement_output(
        {
            "output_id": "o",
            "cta_path": {"type": "ignored"},
            "content": {"header": "Header"},
            "ctas": [
                {
                    "label": "Later",
                    "path": {"type": "dismiss"},
                    "emphasis": "link",
                    "role": "not_now",
                },
                {
                    "label": "Continue",
                    "path": {"type": "manage_subscription"},
                    "emphasis": "primary",
                    "role": "continue",
                },
            ],
        },
        lambda: "rid",
    )
    assert normalized is not None
    assert normalized["cta_path"] == normalized["ui_path"] == {"type": "manage_subscription"}
    assert normalized["content"] == {
        "header": "Header",
        "cta_label": "Continue",
        "secondary_cta_label": "Continue",
    }
    legacy = normalize_placement_output(
        {
            "output_id": "old",
            "ui_path": {"type": "custom", "handle": "mine"},
            "content": {"cta_label": "Custom", "secondary_cta_label": "Later"},
        },
        lambda: "rid",
    )
    assert legacy is not None
    assert legacy["ctas"][0]["path"] == {"type": "custom", "handle": "mine"}
    assert legacy["ctas"][1]["path"] == {"type": "dismiss"}
