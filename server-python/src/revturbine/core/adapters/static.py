"""Static adapter — Python port of @revt-eng/core/adapters/static.ts.

Builds domain providers from an ``ExportedConfig`` snapshot. No network,
no DB — the SDK's local-mode construction path: feed
``create_static_providers(...)`` into a ``LocalRuntime``.

``ExportedConfig`` and its nested entries stay loosely typed
(``dict[str, Any]``) — the same decision the resolver/engine ports made
(avoid coupling to the generated types package; the parity suite is the
drift backstop). Provider state keys are emitted **snake_case** to match
the Python provider-state TypedDicts the engine consumes (the TS source
emits camelCase; this is the same TS→Python naming translation the rest
of the port applies).

Per Q-5 providers are sync. ``resolve()`` recomputes per call (the
registry honours ``cache_ttl_ms``), faithful to the TS arrow-`resolve`.

Source: revturbine-scaffold/src/core/adapters/static.ts
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from revturbine.core.providers.types import (
    DomainProvider,
    EntitlementResult,
)

__all__ = ["create_static_providers"]

ExportedConfig = dict[str, Any]


class _StaticProvider:
    """A single static domain provider: a ``domain`` tag plus a sync
    ``resolve()`` recomputed per call. Satisfies the ``DomainProvider``
    protocol; ``cache_ttl_ms`` is read by ``DomainProviderRegistry``.

    Source: the inline ``{ domain, cacheTtlMs, resolve }`` literals in
    static.ts:48-180.
    """

    def __init__(
        self,
        domain: str,
        resolve_fn: Callable[[], Any],
        cache_ttl_ms: int | None,
    ) -> None:
        self.domain = domain
        self._resolve_fn = resolve_fn
        self.cache_ttl_ms = cache_ttl_ms

    def resolve(self) -> Any:
        return self._resolve_fn()


def create_static_providers(
    *,
    config: ExportedConfig,
    plan_handle: str | None = None,
    plan_name: str | None = None,
    usage: dict[str, dict[str, float]] | None = None,
    default_entitlement_policy: Literal["allow", "deny"] = "allow",
    cache_ttl_ms: int | None = None,
) -> list[DomainProvider]:
    """Create domain providers from a static ExportedConfig snapshot.

    Returns providers for (when the config carries the data): plan,
    entitlements, segments, rules, content, theme — mirroring
    ``createStaticProviders`` 1:1.

    Source: static.ts:42-182 (createStaticProviders)
    """
    providers: list[DomainProvider] = []

    # Plan provider — static.ts:46-57
    if plan_handle:
        resolved_plan_handle = plan_handle
        resolved_plan_name = plan_name if plan_name is not None else plan_handle

        def _plan() -> dict[str, Any]:
            return {
                "current_plan_handle": resolved_plan_handle,
                "current_plan_name": resolved_plan_name,
            }

        providers.append(_StaticProvider("plan", _plan, cache_ttl_ms))

    entitlements: list[dict[str, Any]] = config.get("entitlements") or []

    # Entitlements provider — static.ts:59-90
    if entitlements:
        policy = default_entitlement_policy

        def _entitlements() -> dict[str, Any]:
            entries: dict[str, EntitlementResult] = {}
            usage_out: dict[str, dict[str, Any]] = {}
            for ent in config.get("entitlements") or []:
                handle = ent["unique_handle"]
                entries[handle] = {
                    "status": "allowed" if policy == "allow" else "denied",
                    "allowed": policy == "allow",
                    "reason": f"static_config_default_{policy}",
                }
                override = (usage or {}).get(handle)
                if override is not None:
                    used = override["used"]
                    limit = override["limit"]
                    entry: dict[str, Any] = {
                        "used": used,
                        "limit": limit,
                        "remaining": max(0.0, limit - used),
                    }
                    if ent.get("unit") is not None:
                        entry["unit"] = ent["unit"]
                    usage_out[handle] = entry
            return {"entries": entries, "usage": usage_out}

        providers.append(_StaticProvider("entitlements", _entitlements, cache_ttl_ms))

    segments: list[dict[str, Any]] = config.get("segments") or []

    # Segments provider — static.ts:92-103
    if segments:

        def _segments() -> dict[str, Any]:
            segs = config.get("segments") or []
            return {
                "segment_ids": [s["id"] for s in segs],
                "segment_slugs": [s["handle"] for s in segs],
            }

        providers.append(_StaticProvider("segments", _segments, cache_ttl_ms))

    entitlement_rules: list[dict[str, Any]] = config.get("entitlement_rules") or []

    # Rules provider — static.ts:105-138
    if entitlement_rules:

        def _rules() -> dict[str, Any]:
            by_ent: dict[str, list[dict[str, Any]]] = {}
            for rule in config.get("entitlement_rules") or []:
                ent_id = rule["entitlement_id"]
                by_ent.setdefault(ent_id, [])
                type_fields = rule.get("type_fields") or {}
                targets = rule.get("targets") or []
                snapshot: dict[str, Any] = {
                    "rule_id": rule["id"],
                    "entitlement_id": ent_id,
                    # Runtime snapshot keeps the plan-level fast path
                    # (`plan_ids`); the kind-discriminated evaluator that
                    # consumes `targets` is plan 33 TASK-13. Faithful to
                    # static.ts:120 (filter kind==='plan').
                    "plan_ids": [t["id"] for t in targets if t.get("kind") == "plan"],
                    "kind": type_fields.get("kind", "feature"),
                    "fields": type_fields,
                }
                rule_segment_ids = rule.get("segment_ids")
                if isinstance(rule_segment_ids, list):
                    snapshot["segment_ids"] = [s for s in rule_segment_ids if isinstance(s, str)]
                else:
                    snapshot["segment_ids"] = []
                by_ent[ent_id].append(snapshot)
            return {
                "entitlement_rules": by_ent,
                "config_version": config.get("version"),
            }

        providers.append(_StaticProvider("rules", _rules, cache_ttl_ms))

    message_blocks: list[dict[str, Any]] = config.get("message_blocks") or []
    personalization_tokens: list[Any] = config.get("personalization_tokens") or []

    # Content provider — static.ts:141-168
    if message_blocks or personalization_tokens:

        def _content() -> dict[str, Any]:
            blocks: dict[str, dict[str, Any]] = {}
            for block in config.get("message_blocks") or []:
                block_id = block["block_id"]
                entry: dict[str, Any] = {
                    "block_id": block_id,
                    "name": block.get("name"),
                    "default_content": block.get("default_content"),
                    "status": block.get("status"),
                }
                overrides = block.get("segment_overrides")
                if overrides is not None:
                    entry["segment_overrides"] = [
                        {
                            "segment_id": o.get("segment_value_id"),
                            "content": o.get("content"),
                        }
                        for o in overrides
                    ]
                blocks[block_id] = entry
            return {"message_blocks": blocks, "personalization": {}}

        providers.append(_StaticProvider("content", _content, cache_ttl_ms))

    theme: dict[str, Any] = config.get("theme") or {}

    # Theme provider — static.ts:170-181
    if theme and len(theme) > 0:

        def _theme() -> dict[str, Any]:
            return {"overrides": config.get("theme") or {}}

        providers.append(_StaticProvider("theme", _theme, cache_ttl_ms))

    return providers
