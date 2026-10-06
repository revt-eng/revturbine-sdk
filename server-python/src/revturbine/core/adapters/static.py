"""Static adapter — Python port of @revt-eng/core/adapters/static.ts.

Builds domain providers from a ``Playbook`` snapshot. No network,
no DB — the SDK's local-mode construction path: feed
``create_static_providers(...)`` into a ``LocalRuntime``.

``Playbook`` and its nested entries stay loosely typed
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
from revturbine.core.segments import evaluate_segments
from revturbine.core.user_context import build_targeting_state

__all__ = [
    "apply_server_builtin_dimensions",
    "create_static_providers",
    "resolve_static_segment_membership",
]

Playbook = dict[str, Any]
#: Deprecated spelling of :data:`Playbook` (BL-0156). Removed in ``0.12.0``.
ExportedConfig = Playbook


def resolve_static_segment_membership(
    config: Playbook,
    segment_ids: list[str] | None,
    user_context: dict[str, Any] | None,
) -> list[str]:
    """The segment handles a static snapshot's user belongs to (BL-0369).

    The browser SDK's rule (``resolveEffectiveProviderContext``): the
    caller-resolved ``segment_ids`` then every configured segment whose
    predicates match ``build_targeting_state(user_context)["segment_traits"]``
    (the reserved ``rt_*`` traits come only from ``builtin_dimensions``, plan
    279 PD-3), with ``user_context["experiments"]`` as the enrollment map,
    deduplicated in first-seen order. No user context means nothing is
    evaluated - membership is ``segment_ids`` alone (fail closed, PD-4). This
    used to report EVERY configured segment, so a payload or rule chipped to
    any segment was served to every user.

    Source: static.ts (resolveStaticSegmentMembership)
    """
    members: list[str] = [s for s in (segment_ids or []) if isinstance(s, str)]
    if user_context is not None:
        state = build_targeting_state(user_context, config)
        experiments = user_context.get("experiments")
        members.extend(
            evaluate_segments(
                config.get("segments") or [],
                state["segment_traits"],
                experiments if isinstance(experiments, dict) else {},
            )
        )
    return list(dict.fromkeys(members))


def apply_server_builtin_dimensions(
    user_context: dict[str, Any] | None,
    server_builtin_dimensions: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Overlay server-resolved built-in dimensions onto an app-supplied user
    context (BL-0366; plan 279 PD-3: the server value wins).

    Per key: every leaf of ``server_builtin_dimensions`` replaces the app's
    value for that dimension; an app-set leaf the server did not deliver is
    kept - the overlay ``mergeUserContext`` applies to a client-context
    delivery in the browser. Returns ``user_context`` unchanged when either
    side is absent (a non-dict overlay counts as absent). Pure: the input is
    never mutated.

    This port has no HTTP transport, so it never fetches anything itself:
    the app's backend reads ``GET /api/sdk/user-contexts/{userId}/builtin-dimensions``
    with its server key (or through the Node server SDK's
    ``getBuiltinDimensions``) and hands the response's ``builtin_dimensions``
    in here.

    Source: static.ts (applyServerBuiltinDimensions)
    """
    if user_context is None or not isinstance(server_builtin_dimensions, dict):
        return user_context
    app_set = user_context.get("builtin_dimensions")
    return {
        **user_context,
        "builtin_dimensions": {
            **(app_set if isinstance(app_set, dict) else {}),
            **server_builtin_dimensions,
        },
    }


def _playbook_version(config: Playbook) -> str:
    """The Playbook's version identifier: canonical ``format_version``, else
    the legacy ``version``, else ``""``.

    Source: helpers.ts (playbookVersion)
    """
    for key in ("format_version", "version"):
        value = config.get(key)
        if isinstance(value, str):
            return value
    return ""


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
    config: Playbook,
    plan_handle: str | None = None,
    plan_name: str | None = None,
    usage: dict[str, dict[str, float]] | None = None,
    payment_failed: bool | None = None,
    payment_at_risk: bool | None = None,
    tiers: dict[str, str] | None = None,
    segment_ids: list[str] | None = None,
    user_context: dict[str, Any] | None = None,
    server_builtin_dimensions: dict[str, Any] | None = None,
    default_entitlement_policy: Literal["allow", "deny"] = "allow",
    cache_ttl_ms: int | None = None,
) -> list[DomainProvider]:
    """Create domain providers from a static Playbook snapshot.

    Returns providers for (when the config carries the data): plan,
    entitlements, segments, rules, content, theme — mirroring
    ``createStaticProviders`` 1:1.

    ``segment_ids`` (tenant segment handles the app resolved) and
    ``user_context`` (what built-in and trait segments are evaluated from)
    decide segment MEMBERSHIP - see
    :func:`resolve_static_segment_membership` (BL-0369).

    ``server_builtin_dimensions`` is the control plane's server-resolved
    ``builtin_dimensions`` for this user (BL-0366), fetched by the app's
    backend with its server key. It is overlaid per key on
    ``user_context["builtin_dimensions"]`` before membership is evaluated -
    a delivered leaf wins over the app-set value (plan 279 PD-3) - see
    :func:`apply_server_builtin_dimensions`. Ignored without a
    ``user_context`` (nothing is evaluated then; fail closed).

    Source: static.ts:42-182 (createStaticProviders)
    """
    providers: list[DomainProvider] = []

    # Plan provider — static.ts:46-57
    if plan_handle:
        resolved_plan_handle = plan_handle
        resolved_plan_name = plan_name if plan_name is not None else plan_handle

        def _plan() -> dict[str, Any]:
            state: dict[str, Any] = {
                "current_plan_handle": resolved_plan_handle,
                "current_plan_name": resolved_plan_name,
            }
            # Billing-recovery signals for the Retention qualifier triggers
            # (§3.7). Omitted when not supplied, matching static.ts.
            if payment_failed is not None:
                state["payment_failed"] = payment_failed
            if payment_at_risk is not None:
                state["payment_at_risk"] = payment_at_risk
            return state

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
            state: dict[str, Any] = {
                "entries": entries,
                # D-61: blanket defaults, not app-mirrored data.
                "origin": "playbook_default",
                "usage": usage_out,
            }
            # The user's current tier per capability_tier entitlement, for the
            # entitlement_gate.tier_threshold gate (plan 138 TASK-4). Omitted
            # when not supplied, matching static.ts.
            if tiers is not None:
                state["tiers"] = tiers
            return state

        providers.append(_StaticProvider("entitlements", _entitlements, cache_ttl_ms))

    segments: list[dict[str, Any]] = config.get("segments") or []

    # Segments provider - the user's MEMBERSHIP, never the configured
    # catalogue (BL-0369). Segment identity is the handle (plan 120), so both
    # views carry the same handles.
    if segments or segment_ids:

        def _segments() -> dict[str, Any]:
            members = resolve_static_segment_membership(
                config,
                segment_ids,
                apply_server_builtin_dimensions(user_context, server_builtin_dimensions),
            )
            return {"segment_ids": members, "segment_slugs": list(members)}

        providers.append(_StaticProvider("segments", _segments, cache_ttl_ms))

    entitlement_rules: list[dict[str, Any]] = config.get("entitlement_rules") or []

    # Rules provider — static.ts:105-138
    if entitlement_rules:

        def _rules() -> dict[str, Any]:
            by_ent: dict[str, list[dict[str, Any]]] = {}
            # Plan 147 (OQ-6): flat wire — `kind` is derived from the parent
            # entitlement's type. Index it by handle so each snapshot resolves
            # without the deleted `type_fields.kind`. Mirrors static.ts.
            ent_type_by_handle: dict[str, str] = {}
            for ent in config.get("entitlements") or []:
                if isinstance(ent.get("unique_handle"), str) and isinstance(ent.get("type"), str):
                    ent_type_by_handle[ent["unique_handle"]] = ent["type"]
            for rule in config.get("entitlement_rules") or []:
                ent_id = rule["entitlement_id"]
                by_ent.setdefault(ent_id, [])
                # Flat wire: the rule IS the type-fields bag; tolerate a legacy
                # nested `type_fields` bag (merged under the flat fields).
                nested = rule.get("type_fields")
                if not isinstance(nested, dict):
                    nested = {}
                fields = {**nested, **rule}
                kind = (
                    rule.get("kind")
                    or nested.get("kind")
                    or ent_type_by_handle.get(ent_id)
                    or "feature"
                )
                targets = rule.get("targets") or []
                # Legacy configs carry a flat `plan_ids` array instead of the
                # kind-discriminated `targets`. Mirror static.ts (plan 133):
                # under the fail-closed ruling an unmapped legacy rule would
                # silently DENY the entitlement instead of merely not
                # enriching it.
                legacy_plan_ids = [p for p in (rule.get("plan_ids") or []) if isinstance(p, str)]
                snapshot: dict[str, Any] = {
                    "rule_id": rule["id"],
                    "entitlement_id": ent_id,
                    # Runtime snapshot keeps the plan-level fast path
                    # (`plan_ids`); the kind-discriminated evaluator that
                    # consumes `targets` is plan 33 TASK-13. Faithful to
                    # static.ts (filter kind==='plan', legacy fallback).
                    "plan_ids": [t["id"] for t in targets if t.get("kind") == "plan"]
                    if targets
                    else legacy_plan_ids,
                    "kind": kind,
                    "fields": fields,
                }
                rule_segment_ids = rule.get("segment_ids")
                if isinstance(rule_segment_ids, list):
                    snapshot["segment_ids"] = [s for s in rule_segment_ids if isinstance(s, str)]
                else:
                    snapshot["segment_ids"] = []
                by_ent[ent_id].append(snapshot)
            # Plan #39 REQ-28: the segment -> dimension lookup the rule
            # evaluator needs for intra-dimension OR / cross-dimension AND,
            # keyed by handle (plan 120). Omitting it collapsed every segment
            # into one OR bucket on the provider-backed path - invisible while
            # every configured segment matched, a grant once membership is
            # real (BL-0369).
            segment_dimensions: dict[str, str] = {
                seg["handle"]: seg["dimension_id"]
                for seg in config.get("segments") or []
                if isinstance(seg.get("handle"), str) and isinstance(seg.get("dimension_id"), str)
            }
            return {
                "entitlement_rules": by_ent,
                "segment_dimensions": segment_dimensions,
                "config_version": _playbook_version(config),
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
