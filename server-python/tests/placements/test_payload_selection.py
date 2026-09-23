"""BL-0122 — payload SELECTION is per-payload, not first-payload-wins.

Mirrors ``revturbine-scaffold/src/placements/controllers/
local-resolver-payload-selection.test.ts`` case for case. Behaviour parity
with the TS resolver is required, not optional (Kent 2026-09-11).

The defect: the index took only the first active payload of an entry, so
payloads 2+ never became candidates and their ``target.segment_chips`` could
never be evaluated. Plan 233 TASK-7 made the chip predicate real, but only
for the one payload that reached it — a placement with an admin payload and a
member payload gave every member either the admin copy or nothing at all.

The contract (placement-prioritization.md §1 stage 3): "Targeting — the
user's plan and segment match **a payload**". Drag precedence ranks among
payloads the user MATCHES; it is not a pre-filter.
"""

from __future__ import annotations

from typing import Any

import pytest

from revturbine.core.placements.local_resolver import create_static_placement_resolver


def _payload(payload_id: str, header: str, chips: list[str]) -> dict[str, Any]:
    return {
        "id": payload_id,
        "status": "active",
        "target": {"plan_ids": [], "segment_chips": chips},
        "surfaces": [
            {
                "template_id": "modal_overlay",
                "fields": {"header": header, "body": "Body"},
                "ctas": [{"label": "Go", "path": "open_checkout", "config": {}}],
            }
        ],
    }


def _resolver(payloads: list[dict[str, Any]]) -> Any:
    return create_static_placement_resolver(
        {
            "placements": [
                {
                    "id": "pl_foo",
                    "category": "gated",
                    "order": 0,
                    "trigger": None,
                    "payloads": payloads,
                }
            ]
        },
        {"version": "1.0.0", "plans": [], "entitlements": [], "segments": []},
    )


def _two_chipped() -> Any:
    return _resolver(
        [
            _payload("payload_admin", "Admin message", ["seg_org_admin"]),
            _payload("payload_member", "Member message", ["seg_org_member"]),
        ]
    )


_INPUT = {"placement_id": "pl_foo", "user_id": "u"}
_SLOT = {
    "id": "pl_foo",
    "name": "pl_foo",
    "route": "/",
    "metadata": {"surface_template_ids": ["modal_overlay"]},
}
_DIRECT = {"id": "pl_foo", "name": "pl_foo", "route": "/", "metadata": None}


def _ctx(segment_slugs: list[str]) -> dict[str, Any]:
    return {"__providers": {"segments": {"segment_ids": [], "segment_slugs": segment_slugs}}}


@pytest.mark.parametrize("record", [_SLOT, _DIRECT], ids=["slot", "direct-lookup"])
class TestPayloadSelection:
    def test_serves_the_second_payload_to_a_user_chipped_to_it(
        self, record: dict[str, Any]
    ) -> None:
        res = _two_chipped()(_INPUT, record, _ctx(["seg_org_member"]))

        assert res["visible"] is True
        assert res["content"]["header"] == "Member message"
        assert res["output"]["output_id"] == "payload_member"

    def test_still_serves_the_first_payload_to_a_user_chipped_to_it(
        self, record: dict[str, Any]
    ) -> None:
        # Drag precedence is untouched for a user who matches payload 1.
        res = _two_chipped()(_INPUT, record, _ctx(["seg_org_admin"]))

        assert res["visible"] is True
        assert res["content"]["header"] == "Admin message"

    def test_refuses_when_the_user_matches_no_payload(self, record: dict[str, Any]) -> None:
        res = _two_chipped()(_INPUT, record, _ctx(["seg_outsider"]))

        assert res["visible"] is False
        assert "segment_target_mismatch" in res["reason_codes"]

    def test_takes_the_earlier_payload_when_the_user_matches_both(
        self, record: dict[str, Any]
    ) -> None:
        # Among payloads the user DOES match, authored order still decides —
        # the fix widens candidacy, it does not re-rank matches.
        res = _two_chipped()(_INPUT, record, _ctx(["seg_org_member", "seg_org_admin"]))

        assert res["content"]["header"] == "Admin message"

    def test_serves_an_unchipped_later_payload_when_the_chipped_first_one_misses(
        self, record: dict[str, Any]
    ) -> None:
        # An unchipped payload targets everyone, so it is always a candidate.
        resolver = _resolver(
            [
                _payload("payload_admin", "Admin message", ["seg_org_admin"]),
                _payload("payload_all", "Everyone message", []),
            ]
        )
        res = resolver(_INPUT, record, _ctx(["seg_org_member"]))

        assert res["visible"] is True
        assert res["content"]["header"] == "Everyone message"
