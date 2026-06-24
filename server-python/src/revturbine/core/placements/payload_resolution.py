"""Payload resolution — Python port of
@revt-eng/core/placements/controllers/payload-resolution.ts.

Content lookup + personalization-token application + segment-matched
payload selection. Self-contained: depends only on value types, not on
the engine, providers, or state classes.

The schema content types (``ContentPlacementPayload``, ``MessageBlock``,
``ContentUiPath``, ``ContentPromotion``, ``PersonalizationToken``) are
modeled loosely as ``dict[str, Any]`` here — same approach as the
``PlacementOutput`` alias in helpers.py. The strongly-typed Pydantic
models from ``revturbine_types`` get wired in at TASK-7.

``resolve_payload_for_user_with_provider`` is sync per Q-5 of plan 33;
the TS version is async because provider methods may be remote, but
local-mode providers are CPU-bound. An async ``aresolve_..._with_provider``
variant is a TASK-7 concern.

Source: revturbine-scaffold/src/placements/controllers/payload-resolution.ts
"""

from __future__ import annotations

import re
from typing import Any, Protocol, TypedDict, runtime_checkable

from revturbine.core.helpers import is_record

__all__ = [
    "PayloadResolutionOptions",
    "PersonalizationContext",
    "PlacementContentLookupProvider",
    "ResolvedContent",
    "ResolvedPayload",
    "apply_value_maps",
    "create_static_placement_content_lookup_provider",
    "resolve_content",
    "resolve_payload_for_user",
    "resolve_payload_for_user_with_provider",
    "resolve_tokens",
]


# ── Loose value-type aliases (TASK-7 swaps these for revturbine_types) ───────

PersonalizationContext = dict[str, Any]
ResolvedContent = dict[str, Any]
ContentPlacementPayload = dict[str, Any]
MessageBlock = dict[str, Any]
ContentUiPath = dict[str, Any]
ContentPromotion = dict[str, Any]
PersonalizationToken = dict[str, Any]


class _UserTargetingContext(TypedDict, total=False):
    """The subset of ``UserTargetingContext`` payload resolution reads —
    just the materialized segment IDs.

    Source: core/types.ts ``UserTargetingContext``
    """

    segment_ids: list[str]


class _ResolvedPayloadRequired(TypedDict):
    payload: ContentPlacementPayload
    message_block: MessageBlock
    resolved_content: ResolvedContent


class ResolvedPayload(_ResolvedPayloadRequired, total=False):
    """Source: payload-resolution.ts:18-27"""

    matched_segment_id: str
    ui_path_id: str
    promotion_id: str
    ui_path: ContentUiPath
    promotion: ContentPromotion


class PayloadResolutionOptions(TypedDict, total=False):
    """Source: payload-resolution.ts:128-135"""

    segment_dimensions: dict[str, list[str]]


@runtime_checkable
class PlacementContentLookupProvider(Protocol):
    """Sync lookup provider. The TS protocol allows sync-or-async returns
    (``T | Promise<T>``); the Python port is sync per Q-5.

    Source: payload-resolution.ts:29-35
    """

    def list_payloads(self, surface_template_id: str) -> list[ContentPlacementPayload]: ...
    def get_message_block_by_id(self, block_id: str) -> MessageBlock | None: ...
    def get_ui_path_by_id(self, ui_path_id: str) -> ContentUiPath | None: ...
    def get_promotion_by_id(self, promotion_id: str) -> ContentPromotion | None: ...
    def list_personalization_tokens(self) -> list[PersonalizationToken]: ...


class _StaticLookupProvider:
    """Concrete ``PlacementContentLookupProvider`` built from static lists.

    Source: payload-resolution.ts:37-63
    """

    def __init__(
        self,
        *,
        payloads: list[ContentPlacementPayload] | None = None,
        message_blocks: list[MessageBlock] | None = None,
        ui_paths: list[ContentUiPath] | None = None,
        promotions: list[ContentPromotion] | None = None,
        tokens: list[PersonalizationToken] | None = None,
    ) -> None:
        self._payloads = payloads if isinstance(payloads, list) else []
        self._block_map = {
            b["block_id"]: b
            for b in (message_blocks if isinstance(message_blocks, list) else [])
            if is_record(b) and "block_id" in b
        }
        self._ui_paths = ui_paths if isinstance(ui_paths, list) else []
        self._promotions = promotions if isinstance(promotions, list) else []
        self._tokens = tokens if isinstance(tokens, list) else []

    def list_payloads(self, surface_template_id: str) -> list[ContentPlacementPayload]:
        return [p for p in self._payloads if p.get("surface_template_id") == surface_template_id]

    def get_message_block_by_id(self, block_id: str) -> MessageBlock | None:
        return self._block_map.get(block_id)

    def get_ui_path_by_id(self, ui_path_id: str) -> ContentUiPath | None:
        for item in self._ui_paths:
            if item.get("id") == ui_path_id or item.get("name") == ui_path_id:
                return item
        return None

    def get_promotion_by_id(self, promotion_id: str) -> ContentPromotion | None:
        for item in self._promotions:
            if item.get("id") == promotion_id or item.get("name") == promotion_id:
                return item
        return None

    def list_personalization_tokens(self) -> list[PersonalizationToken]:
        return self._tokens


def create_static_placement_content_lookup_provider(
    *,
    payloads: list[ContentPlacementPayload] | None = None,
    message_blocks: list[MessageBlock] | None = None,
    ui_paths: list[ContentUiPath] | None = None,
    promotions: list[ContentPromotion] | None = None,
    tokens: list[PersonalizationToken] | None = None,
) -> PlacementContentLookupProvider:
    """Build an in-memory ``PlacementContentLookupProvider``.

    Source: payload-resolution.ts:37-63
    """
    return _StaticLookupProvider(
        payloads=payloads,
        message_blocks=message_blocks,
        ui_paths=ui_paths,
        promotions=promotions,
        tokens=tokens,
    )


def _js_string(value: Any) -> str:
    """Match JavaScript's ``String(value)`` coercion for the value kinds
    a personalization context can hold.

    - ``None`` → ``"null"`` (JS ``String(null)``)
    - ``True`` / ``False`` → ``"true"`` / ``"false"``
    - integral ``float`` → no trailing ``.0`` (JS ``String(1.0) === "1"``)
    - everything else → ``str(value)``

    Without this, the parity suite (TASK-8/9/10) would diverge on
    boolean / null / integral-float token substitutions.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def apply_value_maps(
    context: PersonalizationContext,
    tokens: list[PersonalizationToken],
) -> PersonalizationContext:
    """Rewrite token values through each token's ``value_map``.

    A token whose context value (JS-stringified) appears as a key in its
    ``value_map`` is replaced by the mapped value. ``None`` context
    values and tokens without a ``value_map`` are skipped. Mirrors the
    TS ``rawValue == null`` (null/undefined) guard.

    Source: payload-resolution.ts:65-83
    """
    enhanced: PersonalizationContext = dict(context)
    for token_def in tokens:
        token_name = token_def.get("token")
        if token_name is None:
            continue
        raw_value = context.get(token_name)
        value_map = token_def.get("value_map")
        if raw_value is None or not value_map:
            continue
        mapped = value_map.get(_js_string(raw_value))
        if mapped is not None:
            enhanced[token_name] = mapped
    return enhanced


_TOKEN_ALIASES = {
    "current_usage": "usage_current",
    "current_limit": "usage_limit",
    "remaining_usage": "usage_remaining",
}

_TOKEN_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")


def resolve_tokens(template: str, context: PersonalizationContext) -> str:
    """Substitute ``{{token_name}}`` placeholders from ``context``.

    Unknown tokens fall back to a small alias table, then are left
    verbatim (the original ``{{...}}`` match) if still unresolved.

    Source: payload-resolution.ts:88-104
    """

    def _replace(match: re.Match[str]) -> str:
        key = match.group(1)
        # TS: `value = context[key]` — absent key is `undefined`. An
        # explicit JS `null` is a present value (String(null) → "null").
        # Python's "absent" is `key not in context`; an explicit None is
        # a present value too. Mirror the TS undefined→alias→leave chain.
        if key in context:
            return _js_string(context[key])
        alias_key = _TOKEN_ALIASES.get(key)
        if alias_key is not None and alias_key in context:
            return _js_string(context[alias_key])
        return match.group(0)  # unresolved → leave the {{token}} verbatim

    return _TOKEN_RE.sub(_replace, template)


def resolve_content(
    content: dict[str, Any],
    context: PersonalizationContext,
) -> ResolvedContent:
    """Resolve token placeholders in every string field of ``content``;
    non-string values pass through untouched.

    Source: payload-resolution.ts:109-119
    """
    resolved: ResolvedContent = {}
    for key, value in content.items():
        resolved[key] = resolve_tokens(value, context) if isinstance(value, str) else value
    return resolved


def _resolve_block_content(
    content: dict[str, Any],
    context: PersonalizationContext,
) -> ResolvedContent:
    """Source: payload-resolution.ts:121-126"""
    return resolve_content(content, context)


def _match_segment_content(
    payload: ContentPlacementPayload,
    user_segment_set: set[str],
    segment_dimensions: dict[str, list[str]] | None,
) -> tuple[str, str | None, str | None, str | None, bool]:
    """Resolve (block_id, segment_id, ui_path_id, promotion_id, skip).

    ``skip`` is True only in the cross-dimension AND path when the user
    fails the AND condition — the caller must skip this payload entirely
    (mirrors the TS ``continue``).

    Source: payload-resolution.ts:156-218
    """
    matched_block_id: str = payload["default_message_block_id"]
    matched_segment_id: str | None = None
    ui_path_id: str | None = payload.get("ui_path_id")
    promotion_id: str | None = payload.get("promotion_id")

    segment_content_map = payload.get("segment_content_map")
    if not segment_content_map:
        return matched_block_id, matched_segment_id, ui_path_id, promotion_id, False

    if segment_dimensions and len(segment_dimensions) > 0:
        # Cross-dimension AND: user must match ≥1 segment per dimension.
        entries_by_dimension: dict[str, list[dict[str, Any]]] = {}
        for entry in segment_content_map:
            dim = entry.get("dimension")
            if not dim:
                continue
            entries_by_dimension.setdefault(dim, []).append(entry)

        if entries_by_dimension:
            all_dimensions_match = True
            first_match_entry: dict[str, Any] | None = None
            for dim_entries in entries_by_dimension.values():
                dim_match = next(
                    (e for e in dim_entries if e["segment_id"] in user_segment_set),
                    None,
                )
                if dim_match is None:
                    all_dimensions_match = False
                    break
                if first_match_entry is None:
                    first_match_entry = dim_match

            if all_dimensions_match and first_match_entry is not None:
                matched_block_id = first_match_entry["message_block_id"]
                matched_segment_id = first_match_entry["segment_id"]
                if first_match_entry.get("ui_path_id"):
                    ui_path_id = first_match_entry["ui_path_id"]
                if first_match_entry.get("promotion_id"):
                    promotion_id = first_match_entry["promotion_id"]
            elif not all_dimensions_match:
                return matched_block_id, matched_segment_id, ui_path_id, promotion_id, True
        else:
            # No dimension metadata — fall back to flat OR.
            for entry in segment_content_map:
                if entry["segment_id"] in user_segment_set:
                    matched_block_id = entry["message_block_id"]
                    matched_segment_id = entry["segment_id"]
                    if entry.get("ui_path_id"):
                        ui_path_id = entry["ui_path_id"]
                    if entry.get("promotion_id"):
                        promotion_id = entry["promotion_id"]
                    break
    else:
        # Flat OR (backward compatible).
        for entry in segment_content_map:
            if entry["segment_id"] in user_segment_set:
                matched_block_id = entry["message_block_id"]
                matched_segment_id = entry["segment_id"]
                if entry.get("ui_path_id"):
                    ui_path_id = entry["ui_path_id"]
                if entry.get("promotion_id"):
                    promotion_id = entry["promotion_id"]
                break

    return matched_block_id, matched_segment_id, ui_path_id, promotion_id, False


def _apply_segment_overrides(
    block: MessageBlock,
    matched_segment_id: str | None,
    user_segment_set: set[str],
) -> tuple[dict[str, Any], str | None]:
    """Merge ``block.default_content`` with a matching segment override and
    return ``(content, matched_segment_id)``.

    When a ``segment_content_map`` entry already selected a segment, honor
    that exact segment. Otherwise (e.g. local mode, where payloads carry a
    single block via ``content_link`` and no ``segment_content_map``) fall
    back to the first block override whose segment matches the user — so
    message-block segment overrides work without a segment→block map in the
    wire format. The matched id is threaded back so the resolved payload
    reflects the override that fired.

    Source: payload-resolution.ts:223-231 (block-override extension, plan 77)
    """
    raw_content: dict[str, Any] = dict(block.get("default_content", {}))
    overrides = block.get("segment_overrides")
    if overrides:
        if matched_segment_id:
            override = next(
                (o for o in overrides if o.get("segment_value_id") == matched_segment_id),
                None,
            )
        else:
            override = next(
                (o for o in overrides if o.get("segment_value_id") in user_segment_set),
                None,
            )
        if override:
            raw_content = {**raw_content, **override.get("content", {})}
            matched_segment_id = override.get("segment_value_id")
    return raw_content, matched_segment_id


def resolve_payload_for_user(
    surface_template_id: str,
    user_context: _UserTargetingContext,
    payloads: list[ContentPlacementPayload],
    blocks: list[MessageBlock],
    tokens: list[PersonalizationToken],
    personalization: PersonalizationContext,
    options: PayloadResolutionOptions | None = None,
) -> ResolvedPayload | None:
    """Resolve the best-matching active payload for a user + surface.

    Source: payload-resolution.ts:137-245
    """
    candidates = [
        p
        for p in payloads
        if p.get("surface_template_id") == surface_template_id and p.get("status") == "active"
    ]
    if not candidates:
        return None

    block_map = {b["block_id"]: b for b in blocks if is_record(b) and "block_id" in b}
    user_segment_set = set(user_context.get("segment_ids") or [])
    enhanced_context = apply_value_maps(personalization, tokens)
    segment_dimensions = options.get("segment_dimensions") if options else None

    for payload in candidates:
        block_id, matched_segment_id, ui_path_id, promotion_id, skip = _match_segment_content(
            payload,
            user_segment_set,
            segment_dimensions,
        )
        if skip:
            continue

        block = block_map.get(block_id)
        if not block or block.get("status") != "active":
            continue

        raw_content, matched_segment_id = _apply_segment_overrides(
            block, matched_segment_id, user_segment_set
        )
        resolved_content = _resolve_block_content(raw_content, enhanced_context)

        result: ResolvedPayload = ResolvedPayload(
            payload=payload,
            message_block=block,
            resolved_content=resolved_content,
        )
        if matched_segment_id is not None:
            result["matched_segment_id"] = matched_segment_id
        if ui_path_id is not None:
            result["ui_path_id"] = ui_path_id
        if promotion_id is not None:
            result["promotion_id"] = promotion_id
        return result

    return None


def resolve_payload_for_user_with_provider(
    surface_template_id: str,
    user_context: _UserTargetingContext,
    provider: PlacementContentLookupProvider,
    personalization: PersonalizationContext,
    explicit_tokens: list[PersonalizationToken] | None = None,
) -> ResolvedPayload | None:
    """Provider-backed variant. Uses flat-OR segment matching only (no
    cross-dimension AND — the TS ``...WithProvider`` path doesn't take
    ``options``). Sync per Q-5; the TS version awaits possibly-async
    provider methods.

    Source: payload-resolution.ts:247-319
    """
    payloads = provider.list_payloads(surface_template_id)
    candidates = [p for p in payloads if p.get("status") == "active"]
    if not candidates:
        return None

    user_segment_set = set(user_context.get("segment_ids") or [])
    provider_tokens = (
        explicit_tokens if explicit_tokens is not None else provider.list_personalization_tokens()
    )
    enhanced_context = apply_value_maps(personalization, provider_tokens)

    for payload in candidates:
        matched_block_id: str = payload["default_message_block_id"]
        matched_segment_id: str | None = None
        ui_path_id: str | None = payload.get("ui_path_id")
        promotion_id: str | None = payload.get("promotion_id")

        segment_content_map = payload.get("segment_content_map")
        if segment_content_map:
            for entry in segment_content_map:
                if entry["segment_id"] in user_segment_set:
                    matched_block_id = entry["message_block_id"]
                    matched_segment_id = entry["segment_id"]
                    if entry.get("ui_path_id"):
                        ui_path_id = entry["ui_path_id"]
                    if entry.get("promotion_id"):
                        promotion_id = entry["promotion_id"]
                    break

        block = provider.get_message_block_by_id(matched_block_id)
        if not block or block.get("status") != "active":
            continue

        raw_content, matched_segment_id = _apply_segment_overrides(
            block, matched_segment_id, user_segment_set
        )
        resolved_content = _resolve_block_content(raw_content, enhanced_context)

        ui_path: ContentUiPath | None = None
        if ui_path_id:
            ui_path = provider.get_ui_path_by_id(ui_path_id)

        promotion: ContentPromotion | None = None
        if promotion_id:
            promotion = provider.get_promotion_by_id(promotion_id)

        result: ResolvedPayload = ResolvedPayload(
            payload=payload,
            message_block=block,
            resolved_content=resolved_content,
        )
        if matched_segment_id is not None:
            result["matched_segment_id"] = matched_segment_id
        if ui_path_id is not None:
            result["ui_path_id"] = ui_path_id
        if promotion_id is not None:
            result["promotion_id"] = promotion_id
        if ui_path is not None:
            result["ui_path"] = ui_path
        if promotion is not None:
            result["promotion"] = promotion
        return result

    return None
