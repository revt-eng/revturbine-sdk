"""CapEnforcer — Python port of @revt-eng/core/state/cap-enforcer.ts.

Manages presentation-cap and cooldown state, persisted through any
``RevTurbineStorage`` backend. Reads cap policies (``max_per_period`` +
``cooldown_days``) from a ``PlacementOutput`` and either records the
presentation or denies it with a per-rule reason code.

Source: revturbine-scaffold/src/core/state/cap-enforcer.ts
"""

from __future__ import annotations

import contextlib
import json
import math
import time
from typing import Any

from revturbine.core.helpers import (
    PlacementCapRule,
    PlacementOutput,
    is_record,
    parse_cap_rule,
    period_window_start,
)
from revturbine.core.state.storage import RevTurbineStorage
from revturbine.core.state.types import (
    CapEnforcementResult,
    PlacementCapPolicy,
    PresentationCapState,
)

__all__ = ["CapEnforcer", "CapEnforcerOptions"]

_STORAGE_PREFIX = "revturbine:presentation-caps"
_MS_PER_DAY = 24 * 60 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


class CapEnforcerOptions(dict[str, Any]):
    """Constructor argument bundle. Kept as a dict for parity with TS object
    literals; field access is via the keyword params on ``CapEnforcer``."""


class CapEnforcer:
    """Enforces per-placement caps and cooldowns against persisted history.

    Source: cap-enforcer.ts:60-208
    """

    def __init__(
        self,
        *,
        storage: RevTurbineStorage,
        tenant_id: str,
        user_id: str,
    ) -> None:
        self._storage = storage
        self._tenant_id = tenant_id
        self._user_id = user_id
        self._caps_by_key: dict[str, PresentationCapState] = {}
        self.hydrate()

    # ── Public API ──────────────────────────────────────────────────────────

    def enforce(self, output: PlacementOutput) -> CapEnforcementResult:
        """Decide whether ``output`` is allowed by its cap + cooldown policies.

        On success: records the presentation (appends ``now`` to ``seen_at``,
        sets ``cooldown_until`` if any policy declares one) and persists.
        On failure: returns the suppression reason without recording.

        Source: cap-enforcer.ts:81-128
        """
        policies = self._extract_policies(output)
        if not policies:
            return CapEnforcementResult(allowed=True)

        key = self._cap_key(output)
        now = _now_ms()
        existing = self._caps_by_key.get(key, PresentationCapState(seen_at=[]))
        # Defensive cleanup on read — drops malformed timestamps, matching
        # the TS filter chain.
        state: PresentationCapState = PresentationCapState(
            seen_at=[ts for ts in existing["seen_at"] if isinstance(ts, int) and ts > 0],
        )
        if "cooldown_until" in existing:
            state["cooldown_until"] = existing["cooldown_until"]

        # Active cooldown takes precedence over per-period caps.
        cooldown_until = state.get("cooldown_until")
        if cooldown_until is not None and cooldown_until > now:
            self._caps_by_key[key] = state
            return CapEnforcementResult(
                allowed=False,
                reason="suppressed_by_payload_cooldown",
            )

        # Check cap rules. The first rule that's been hit causes denial.
        for policy in policies:
            for rule in policy["rules"]:
                window_start = period_window_start(rule["period"], now)
                within_window = [ts for ts in state["seen_at"] if window_start <= ts <= now]
                if len(within_window) >= rule["count"]:
                    # Trim the in-memory state to the active window so the
                    # next call doesn't re-scan stale timestamps. Mirrors TS.
                    new_state: PresentationCapState = PresentationCapState(seen_at=within_window)
                    if "cooldown_until" in state:
                        new_state["cooldown_until"] = state["cooldown_until"]
                    self._caps_by_key[key] = new_state
                    return CapEnforcementResult(
                        allowed=False,
                        reason=f"suppressed_by_payload_cap_{rule['period']}",
                    )

        # Allowed — record this presentation.
        state["seen_at"].append(now)

        cooldowns = [
            policy["cooldown_ms"]
            for policy in policies
            if "cooldown_ms" in policy
            and isinstance(policy["cooldown_ms"], (int, float))
            and not isinstance(policy["cooldown_ms"], bool)
            and math.isfinite(policy["cooldown_ms"])
            and policy["cooldown_ms"] > 0
        ]
        if cooldowns:
            state["cooldown_until"] = now + int(max(cooldowns))
        else:
            state.pop("cooldown_until", None)

        self._caps_by_key[key] = state
        self.persist()
        return CapEnforcementResult(allowed=True)

    # ── Serialization ──────────────────────────────────────────────────────

    def hydrate(self) -> None:
        """Load state from storage. Malformed JSON is dropped and the storage
        entry is removed.

        Source: cap-enforcer.ts:132-154
        """
        raw = self._storage.get_item(self._storage_key())
        if not raw:
            return
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            self._storage.remove_item(self._storage_key())
            return
        if not isinstance(parsed, dict):
            return
        for key, value in parsed.items():
            if not isinstance(value, dict):
                continue
            seen_at_raw = value.get("seen_at")
            seen_at: list[int] = (
                [
                    ts
                    for ts in seen_at_raw
                    if isinstance(ts, int) and not isinstance(ts, bool) and ts > 0
                ]
                if isinstance(seen_at_raw, list)
                else []
            )
            cooldown_until_raw = value.get("cooldown_until")
            entry: PresentationCapState = PresentationCapState(seen_at=seen_at)
            if (
                isinstance(cooldown_until_raw, (int, float))
                and not isinstance(cooldown_until_raw, bool)
                and math.isfinite(cooldown_until_raw)
            ):
                entry["cooldown_until"] = int(cooldown_until_raw)
            self._caps_by_key[key] = entry

    def persist(self) -> None:
        """Best-effort write to storage. Errors are swallowed.

        Source: cap-enforcer.ts:156-163
        """
        with contextlib.suppress(Exception):
            self._storage.set_item(self._storage_key(), json.dumps(self._caps_by_key))

    # ── Internal ───────────────────────────────────────────────────────────

    def _storage_key(self) -> str:
        return f"{_STORAGE_PREFIX}:{self._tenant_id}:{self._user_id}"

    def _cap_key(self, output: PlacementOutput) -> str:
        surface = output.get("surface")
        surface_type = surface["type"] if is_record(surface) and "type" in surface else ""
        output_id = output.get("output_id", "")
        return ":".join([self._tenant_id, self._user_id, str(surface_type), str(output_id)])

    def _extract_policies(self, output: PlacementOutput) -> list[PlacementCapPolicy]:
        """Walk ``output``, ``output.content``, and the
        ``content.{payload,placement,surface}`` legacy nests, collecting
        any ``caps`` blocks found at each level.

        Source: cap-enforcer.ts:175-207
        """
        policies: list[PlacementCapPolicy] = []
        roots: list[Any] = [output]

        content = output.get("content")
        if is_record(content):
            roots.append(content)
            for nested_key in ("payload", "placement", "surface"):
                nested = content.get(nested_key)
                if nested is not None:
                    roots.append(nested)

        for root in roots:
            if not is_record(root):
                continue
            caps = root.get("caps")
            if not is_record(caps):
                continue

            rules: list[PlacementCapRule] = []
            rule = parse_cap_rule(caps.get("max_per_period"))
            if rule is not None:
                rules.append(rule)

            cooldown_days = caps.get("cooldown_days")
            cooldown_ms: int | None = None
            if (
                isinstance(cooldown_days, (int, float))
                and not isinstance(cooldown_days, bool)
                and math.isfinite(cooldown_days)
                and cooldown_days > 0
            ):
                cooldown_ms = int(cooldown_days * _MS_PER_DAY)

            policy: PlacementCapPolicy = PlacementCapPolicy(rules=rules)
            if cooldown_ms is not None:
                policy["cooldown_ms"] = cooldown_ms
            policies.append(policy)

        return policies
