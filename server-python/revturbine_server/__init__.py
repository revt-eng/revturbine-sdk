"""
RevTurbine Server-Side SDK for Python.

Performs server-to-server evaluation calls against the RevTurbine decision engine
and returns a ``ServerEvaluationPayload`` (generated TypedDict) that the
client-side SDK can hydrate via ``sdk.hydrate(payload)``.

Payload and sub-types are imported from the generated ``revturbine.types``
module so the Python SDK stays aligned with the JSON-Schema source of truth.

Usage::

    from revturbine_server import RevTurbineServer

    server = RevTurbineServer(
        tenant_id="tenant_abc",
        api_key="rt_secret_xxx",
        endpoint="https://api.revturbine.io",
    )

    payload = server.evaluate(
        user_id="user_123",
        traits={"plan": "pro"},
        placements=[{"slot_id": "hero_banner"}],
        entitlement_handles=["advanced_analytics"],
        include_theme=True,
    )

    # Serialize and send to client-side SDK
    import json
    json_str = json.dumps(payload)
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ---------------------------------------------------------------------------
# Generated types from revturbine-schema (source of truth)
# ---------------------------------------------------------------------------
from revturbine.types import (
    ServerEvaluationPayload,
    ServerEvaluationPayloadDecisionsItem,
    ServerEvaluationPayloadEntitlementsValue,
    ServerEvaluationPayloadTrialStatus,
    ServerEvaluationPayloadUser,
    ServerEvaluationPayloadUserContext,
)

__all__ = [
    "RevTurbineServer",
    "ServerEvaluationPayload",
    "ServerEvaluationPayloadDecisionsItem",
    "ServerEvaluationPayloadEntitlementsValue",
    "ServerEvaluationPayloadTrialStatus",
    "ServerEvaluationPayloadUser",
    "ServerEvaluationPayloadUserContext",
]

# ---------------------------------------------------------------------------
# SDK-only request type (not in schema)
# ---------------------------------------------------------------------------
PlacementRequest = Dict[str, Optional[str]]
"""Keys: slot_id, entitlement_handle, plan_handle, placement_handle."""


def _request_id() -> str:
    return str(uuid.uuid4())


class RevTurbineServer:
    """Server-side RevTurbine evaluation client."""

    def __init__(
        self,
        *,
        tenant_id: str,
        api_key: str,
        endpoint: str,
        default_ttl_seconds: int = 60,
        timeout_seconds: float = 30.0,
    ) -> None:
        if not tenant_id:
            raise ValueError("tenant_id is required")
        if not api_key:
            raise ValueError("api_key is required")
        if not endpoint:
            raise ValueError("endpoint is required")

        self._tenant_id = tenant_id
        self._api_key = api_key
        self._endpoint = endpoint.rstrip("/")
        self._default_ttl = default_ttl_seconds
        self._timeout = timeout_seconds

    # -------------------------------------------------------------------
    # Public API
    # -------------------------------------------------------------------

    def evaluate(
        self,
        *,
        user_id: str,
        anonymous_id: Optional[str] = None,
        traits: Optional[Dict[str, Any]] = None,
        page: Optional[Dict[str, Any]] = None,
        placements: Optional[Sequence[PlacementRequest]] = None,
        entitlement_handles: Optional[Sequence[str]] = None,
        usage_balances: Optional[Dict[str, float]] = None,
        include_theme: bool = False,
        include_trial_status: bool = False,
        include_user_context: bool = False,
    ) -> ServerEvaluationPayload:
        """Evaluate placement decisions, entitlements, and context for a user."""
        rid = _request_id()
        anon_id = anonymous_id or _request_id()

        decisions = self._evaluate_placements(rid, user_id, traits, page, placements, usage_balances)
        entitlements = self._evaluate_entitlements(user_id, entitlement_handles)
        trial_status = self._fetch_trial_status(rid, user_id) if include_trial_status else None
        user_context = self._fetch_user_context(rid, user_id) if include_user_context else None
        theme = self._fetch_theme(rid) if include_theme else None

        user: ServerEvaluationPayloadUser = {
            "id": user_id,
            "anonymous_id": anon_id,
            "traits": traits,
        }

        payload: ServerEvaluationPayload = {
            "version": "1.0.0",
            "request_id": rid,
            "tenant_id": self._tenant_id,
            "evaluated_at": datetime.now(timezone.utc).isoformat(),
            "ttl_seconds": self._default_ttl,
            "user": user,
            "decisions": decisions,
        }

        if entitlements:
            payload["entitlements"] = entitlements
        if trial_status is not None:
            payload["trial_status"] = trial_status
        if user_context is not None:
            payload["user_context"] = user_context
        if theme is not None:
            payload["theme"] = theme

        return payload

    def check_entitlement(
        self,
        user_id: str,
        handle: str,
        *,
        used: Optional[float] = None,
        balance: Optional[float] = None,
        required_tier: Optional[str] = None,
    ) -> ServerEvaluationPayloadEntitlementsValue:
        """Check a single entitlement for a user."""
        rid = _request_id()
        body: Dict[str, Any] = {
            "request_id": rid,
            "user_id": user_id,
            "entitlement_handle": handle,
        }
        if used is not None:
            body["used"] = used
        if balance is not None:
            body["balance"] = balance
        if required_tier is not None:
            body["required_tier"] = required_tier

        try:
            data = self._api_post(rid, "/api/decision-api/v1/check-entitlement", body)
            return ServerEvaluationPayloadEntitlementsValue(
                status=data.get("status", "denied"),
                allowed=data.get("allowed", False),
                reason=data.get("reason"),
                current_tier=data.get("current_tier"),
            )
        except Exception:
            return ServerEvaluationPayloadEntitlementsValue(
                status="denied",
                allowed=False,
                reason="network_error",
            )

    def get_trial_status(self, user_id: str) -> ServerEvaluationPayloadTrialStatus:
        """Fetch trial status for a user."""
        return self._fetch_trial_status(_request_id(), user_id)

    def to_json(self, payload: ServerEvaluationPayload) -> str:
        """Serialize a payload to JSON."""
        return json.dumps(payload, default=str)

    # -------------------------------------------------------------------
    # Internal
    # -------------------------------------------------------------------

    def _evaluate_placements(
        self,
        rid: str,
        user_id: str,
        traits: Optional[Dict[str, Any]],
        page: Optional[Dict[str, Any]],
        placements: Optional[Sequence[PlacementRequest]],
        usage_balances: Optional[Dict[str, float]],
    ) -> List[ServerEvaluationPayloadDecisionsItem]:
        if not placements:
            return []

        if len(placements) > 1:
            return self._evaluate_placements_batch(rid, user_id, traits, page, list(placements), usage_balances)

        return [self._evaluate_single_placement(rid, user_id, placements[0], traits)]

    def _evaluate_single_placement(
        self,
        rid: str,
        user_id: str,
        placement: PlacementRequest,
        traits: Optional[Dict[str, Any]],
    ) -> ServerEvaluationPayloadDecisionsItem:
        body = {
            "request_id": rid,
            "user_id": user_id,
            "traits": traits or {},
            "slot_id": placement.get("slot_id"),
            "entitlement_handle": placement.get("entitlement_handle"),
            "plan_handle": placement.get("plan_handle"),
            "placement_handle": placement.get("placement_handle"),
        }

        try:
            data = self._api_post(rid, "/api/decision-api/v1/decide-context", body)
            decision = data.get("decision", {})
            visible = bool(decision.get("visible", False))
            result = ServerEvaluationPayloadDecisionsItem(
                slot_id=placement.get("slot_id"),
                entitlement_handle=placement.get("entitlement_handle"),
                plan_handle=placement.get("plan_handle"),
                placement_handle=placement.get("placement_handle"),
                visible=visible,
                output=decision if visible else None,
                reason_codes=data.get("reason_codes"),
            )
            return result
        except Exception:
            return ServerEvaluationPayloadDecisionsItem(
                slot_id=placement.get("slot_id"),
                entitlement_handle=placement.get("entitlement_handle"),
                plan_handle=placement.get("plan_handle"),
                placement_handle=placement.get("placement_handle"),
                visible=False,
                reason_codes=["network_error"],
            )

    def _evaluate_placements_batch(
        self,
        rid: str,
        user_id: str,
        traits: Optional[Dict[str, Any]],
        page: Optional[Dict[str, Any]],
        placements: List[PlacementRequest],
        usage_balances: Optional[Dict[str, float]],
    ) -> List[ServerEvaluationPayloadDecisionsItem]:
        body = {
            "request_id": rid,
            "user_id": user_id,
            "traits": traits or {},
            "usage_balances": usage_balances or {},
            "page": page or {},
            "placements": [
                {
                    "slot_id": p.get("slot_id"),
                    "entitlement_handle": p.get("entitlement_handle"),
                    "plan_handle": p.get("plan_handle"),
                    "placement_handle": p.get("placement_handle"),
                }
                for p in placements
            ],
        }

        try:
            data = self._api_post(rid, "/api/decision-api/v1/bootstrap-context", body)
            decisions_raw = data.get("decisions", [])
            results: List[ServerEvaluationPayloadDecisionsItem] = []
            for i, d in enumerate(decisions_raw):
                original = placements[i] if i < len(placements) else {}
                result_data = d.get("result", {})
                decision_data = result_data.get("decision", {})
                visible = bool(decision_data.get("visible", False))
                entry = ServerEvaluationPayloadDecisionsItem(
                    slot_id=original.get("slot_id"),
                    entitlement_handle=original.get("entitlement_handle"),
                    plan_handle=original.get("plan_handle"),
                    placement_handle=original.get("placement_handle"),
                    visible=visible,
                    output=decision_data if visible else None,
                    reason_codes=result_data.get("reason_codes"),
                )
                results.append(entry)
            return results
        except Exception:
            return [
                ServerEvaluationPayloadDecisionsItem(
                    slot_id=p.get("slot_id"),
                    entitlement_handle=p.get("entitlement_handle"),
                    plan_handle=p.get("plan_handle"),
                    placement_handle=p.get("placement_handle"),
                    visible=False,
                    reason_codes=["network_error"],
                )
                for p in placements
            ]

    def _evaluate_entitlements(
        self,
        user_id: str,
        handles: Optional[Sequence[str]],
    ) -> Optional[Dict[str, ServerEvaluationPayloadEntitlementsValue]]:
        if not handles:
            return None

        results: Dict[str, ServerEvaluationPayloadEntitlementsValue] = {}
        for handle in handles:
            results[handle] = self.check_entitlement(user_id, handle)
        return results

    def _fetch_trial_status(self, rid: str, user_id: str) -> ServerEvaluationPayloadTrialStatus:
        try:
            data = self._api_post(rid, "/api/decision-api/v1/trial-status", {
                "request_id": rid,
                "user_id": user_id,
            })
            return ServerEvaluationPayloadTrialStatus(
                in_trial=data.get("in_trial", False),
                trial_type=data.get("trial_type"),
                plan_handle=data.get("plan_handle"),
                day_number=data.get("day_number"),
                days_remaining=data.get("days_remaining"),
            )
        except Exception:
            return ServerEvaluationPayloadTrialStatus(in_trial=False)

    def _fetch_user_context(self, rid: str, user_id: str) -> Optional[ServerEvaluationPayloadUserContext]:
        try:
            data = self._api_post(rid, "/api/decision-api/v1/user-context", {
                "request_id": rid,
                "user_id": user_id,
            })
            return ServerEvaluationPayloadUserContext(
                segments=data.get("segments"),
                traits=data.get("traits"),
                usage_balances=data.get("usage_balances"),
            )
        except Exception:
            return None

    def _fetch_theme(self, rid: str) -> Optional[Dict[str, Any]]:
        try:
            return self._api_get(rid, "/api/sdk/theme")
        except Exception:
            return None

    # -------------------------------------------------------------------
    # HTTP helpers (stdlib only — zero runtime dependencies)
    # -------------------------------------------------------------------

    def _api_post(self, rid: str, path: str, body: Any) -> Dict[str, Any]:
        url = f"{self._endpoint}{path}"
        data = json.dumps(body).encode("utf-8")
        req = Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", f"Bearer {self._api_key}")
        req.add_header("x-tenant-id", self._tenant_id)
        req.add_header("x-request-id", rid)

        with urlopen(req, timeout=self._timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _api_get(self, rid: str, path: str) -> Dict[str, Any]:
        url = f"{self._endpoint}{path}"
        req = Request(url, method="GET")
        req.add_header("Authorization", f"Bearer {self._api_key}")
        req.add_header("x-tenant-id", self._tenant_id)
        req.add_header("x-request-id", rid)

        with urlopen(req, timeout=self._timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
