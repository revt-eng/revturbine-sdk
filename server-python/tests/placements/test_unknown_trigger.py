"""BL-0514 — an unknown placement trigger type never shows.

Mirrors ``revturbine-scaffold/src/placements/controllers/
local-resolver-unknown-trigger.test.ts`` case for case. A ``type`` the
resolver does not know used to apply no gate at all, so the placement showed.
"""

from __future__ import annotations

from typing import Any

from revturbine.core.placements.local_resolver import create_static_placement_resolver


def _resolver(trigger: Any) -> Any:
    return create_static_placement_resolver(
        {
            "placements": [
                {
                    "id": "pl_test",
                    "category": "other_conversion",
                    "order": 0,
                    "trigger": trigger,
                    "payloads": [
                        {
                            "id": "payload_1",
                            "status": "active",
                            "surfaces": [
                                {
                                    "template_id": "modal_overlay",
                                    "fields": {"header": "Upgrade", "body": "Body"},
                                    "ctas": [
                                        {"label": "Go", "path": "open_checkout", "config": {}}
                                    ],
                                }
                            ],
                        }
                    ],
                }
            ]
        },
        {"version": "1.0.0", "plans": [], "entitlements": [], "segments": []},
    )


_INPUT = {"placement_id": "pl_test", "user_id": "user_1"}
_SLOT = {
    "id": "slot",
    "name": "slot",
    "route": "/",
    "metadata": {"surface_template_ids": ["modal_overlay"]},
}
_CTX: dict[str, Any] = {"__providers": {"plan": {"current_plan_handle": "pro"}}}
_ALWAYS_ON = {"type": "qualifier", "qualifier": "none_always_on"}


class TestDirectLookup:
    def test_unknown_trigger_type_never_shows(self) -> None:
        res = _resolver({"type": "moon_phase", "phase": "full"})(_INPUT, None, _CTX)
        assert res["visible"] is False
        assert res["reason_codes"] == ["unknown_trigger_type"]

    def test_known_always_on_trigger_still_shows(self) -> None:
        assert _resolver(_ALWAYS_ON)(_INPUT, None, _CTX)["visible"] is True

    def test_typeless_trigger_applies_no_gate(self) -> None:
        assert _resolver({})(_INPUT, None, _CTX)["visible"] is True


class TestSlotPath:
    def test_unknown_trigger_type_is_never_a_candidate(self) -> None:
        res = _resolver({"type": "moon_phase"})(_INPUT, _SLOT, _CTX)
        assert res["visible"] is False
        assert res["reason_codes"] == ["no_eligible_candidate"]

    def test_known_always_on_trigger_is_still_served(self) -> None:
        assert _resolver(_ALWAYS_ON)(_INPUT, _SLOT, _CTX)["visible"] is True
