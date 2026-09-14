"""Segment-chip enforcement in the headless resolver (plan 233 TASK-7).

Behaviour parity with the TS resolver is required, not optional (Kent
2026-09-11): the browser SDK and every headless port must make the same
selection for the same input. These mirror
``revturbine-scaffold/src/placements/controllers/local-resolver-segment-chips.test.ts``
case for case.

The defect being closed: ``target.segment_chips`` was evaluated only inside the
browser SDK's diagnostic probe. Nothing in any decision path read it, so a
payload chipped to a segment the user is not in rendered for everyone.
"""

from __future__ import annotations

from typing import Any

from revturbine.core.placements.local_resolver import create_static_placement_resolver
from revturbine.core.rules.segment_eligibility import evaluate_segment_eligibility


def _surface() -> dict[str, Any]:
    return {
        "template_id": "modal_overlay",
        "fields": {"header": "Upgrade", "body": "Get more features"},
        "ctas": [{"label": "Upgrade Now", "path": "open_checkout", "config": {}}],
    }


def _resolver_chipped_to(chips: list[str]) -> Any:
    return create_static_placement_resolver(
        {
            "placements": [
                {
                    "id": "pl_foo",
                    "category": "gated",
                    "order": 0,
                    "trigger": None,
                    "payloads": [
                        {
                            "id": "pay1",
                            "status": "active",
                            "target": {"plan_ids": [], "segment_chips": chips},
                            "surfaces": [_surface()],
                        }
                    ],
                }
            ]
        },
        {"version": "1.0.0", "plans": [], "entitlements": [], "segments": []},
    )


def _rec(name: str, metadata: dict[str, Any] | None = None) -> Any:
    return {"id": "pl_foo", "name": name, "route": "/", "metadata": metadata}


def _ctx(segment_slugs: list[str]) -> dict[str, Any]:
    # Handles live in ``segment_slugs`` in every runtime. ``segment_ids`` carries
    # minted ids here, so matching against it would silently match nothing.
    return {"__providers": {"segments": {"segment_ids": [], "segment_slugs": segment_slugs}}}


_SLOT = _rec("pl_foo", {"surface_template_ids": ["modal_overlay"]})
_INPUT = {"placement_id": "p1", "user_id": "u"}


class TestSegmentChipEnforcement:
    def test_refuses_chip_naming_a_segment_that_does_not_exist(self) -> None:
        # The escalated case, verbatim.
        decision = _resolver_chipped_to(["segment_that_does_not_exist"])(_INPUT, _SLOT, _ctx([]))
        assert decision["visible"] is False
        assert "segment_target_mismatch" in decision["reason_codes"]

    def test_refuses_a_user_not_in_the_chipped_segment(self) -> None:
        decision = _resolver_chipped_to(["power_users"])(_INPUT, _SLOT, _ctx(["casuals"]))
        assert decision["visible"] is False

    def test_renders_for_a_member(self) -> None:
        decision = _resolver_chipped_to(["power_users"])(_INPUT, _SLOT, _ctx(["power_users"]))
        assert decision["visible"] is True

    def test_no_chips_means_no_filter(self) -> None:
        # An unchipped payload is untargeted, not untargetable.
        decision = _resolver_chipped_to([])(_INPUT, _SLOT, _ctx([]))
        assert decision["visible"] is True

    def test_matches_any_chip(self) -> None:
        decision = _resolver_chipped_to(["power_users", "trialists"])(
            _INPUT, _SLOT, _ctx(["trialists"])
        )
        assert decision["visible"] is True

    def test_gates_the_direct_lookup_path_too(self) -> None:
        # Gating one path would leave the other an unguarded back door.
        decision = _resolver_chipped_to(["segment_that_does_not_exist"])(
            _INPUT, _rec("pl_foo"), _ctx([])
        )
        assert decision["visible"] is False

    def test_does_not_match_a_handle_that_only_appears_in_segment_ids(self) -> None:
        # Guards the cross-language divergence directly: if this ever passes,
        # some runtime is reading the id field and parity is gone.
        ctx = {"__providers": {"segments": {"segment_ids": ["power_users"], "segment_slugs": []}}}
        decision = _resolver_chipped_to(["power_users"])(_INPUT, _SLOT, ctx)
        assert decision["visible"] is False


class TestEvaluateSegmentEligibility:
    def test_no_chips_admits_everyone(self) -> None:
        assert evaluate_segment_eligibility({"target_segment_chips": []}, {"segment_ids": []}) == {
            "eligible": True
        }

    def test_or_within(self) -> None:
        assert evaluate_segment_eligibility(
            {"target_segment_chips": ["a", "b"]}, {"segment_ids": ["b"]}
        ) == {"eligible": True}

    def test_mismatch_reason(self) -> None:
        assert evaluate_segment_eligibility(
            {"target_segment_chips": ["a"]}, {"segment_ids": ["c"]}
        ) == {"eligible": False, "reason": "segment_mismatch"}

    def test_unknown_chip_matches_nobody(self) -> None:
        assert (
            evaluate_segment_eligibility(
                {"target_segment_chips": ["typo"]}, {"segment_ids": ["a", "b"]}
            )["eligible"]
            is False
        )

    def test_exact_on_handles(self) -> None:
        assert (
            evaluate_segment_eligibility(
                {"target_segment_chips": ["Power_Users"]}, {"segment_ids": ["power_users"]}
            )["eligible"]
            is False
        )
