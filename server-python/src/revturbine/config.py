"""Portable Playbook header types and dual-read normalization."""

from __future__ import annotations

import warnings
from typing import Any, Literal, TypeAlias, TypedDict

PLAYBOOK_FORMAT_VERSION = "1.0.0"


class _PlaybookHeaderRequired(TypedDict):
    artifact_type: Literal["playbook"]
    format_version: Literal["1.0.0"]
    tenant_id: str
    environment_id: str


class PlaybookHeader(_PlaybookHeaderRequired, total=False):
    """Canonical portable Playbook header."""

    playbook_handle: str
    playbook_version_id: str | None
    project_id: str
    exported_at: str
    schema_version: str
    bundle_schema_version: int


Playbook: TypeAlias = dict[str, Any]
"""Canonical portable Playbook artifact."""

LegacyRevTurbineConfig: TypeAlias = dict[str, Any]
"""Deprecated legacy config wire shape accepted for one migration window."""

RevTurbineConfig: TypeAlias = LegacyRevTurbineConfig
"""Deprecated alias for :data:`LegacyRevTurbineConfig`."""

ConfigArtifact: TypeAlias = Playbook | LegacyRevTurbineConfig


class LegacyConfigTargetDefaults(TypedDict):
    """Target values for legacy artifacts that predate target stamping."""

    tenant_id: str
    environment_id: str


_REQUIRED_BODY_ARRAY_FIELDS: tuple[str, ...] = (
    "plans",
    "entitlements",
    "entitlement_rules",
    "segments",
    "content_ui_paths",
)
_LEGACY_PROJECTION_FIELDS: tuple[str, ...] = ("slot_configs", "content_overrides")


def _require_non_empty_string(value: Any, source: str, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f'Invalid {source}: missing non-empty string "{field}"')
    return value


def _validate_body(value: Playbook, source: str) -> None:
    for key in _REQUIRED_BODY_ARRAY_FIELDS:
        if not isinstance(value.get(key), list):
            raise ValueError(f'Invalid {source}: missing array "{key}"')


def parse_playbook_or_throw(
    raw: Any,
    source: str,
    legacy_target_defaults: LegacyConfigTargetDefaults | None = None,
) -> Playbook | None:
    """Normalize a canonical or known legacy artifact into a Playbook.

    Either canonical discriminator selects the canonical path. Unsupported
    future ``format_version`` values therefore reject and never fall back to
    legacy parsing.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError(f"Invalid {source}: expected top-level object")

    legacy_projection_fields = [field for field in _LEGACY_PROJECTION_FIELDS if field in raw]
    if legacy_projection_fields:
        warnings.warn(
            f"{source} uses deprecated Playbook projection(s): "
            f"{', '.join(legacy_projection_fields)}. Move activation/triggers to local runtime "
            "state and content to Message Blocks/Placement Payloads.",
            DeprecationWarning,
            stacklevel=2,
        )

    canonical = "artifact_type" in raw or "format_version" in raw
    if canonical:
        if raw.get("artifact_type") != "playbook":
            raise ValueError(f'Invalid {source}: unsupported "artifact_type"')
        if raw.get("format_version") != PLAYBOOK_FORMAT_VERSION:
            raise ValueError(
                f'Invalid {source}: unsupported "format_version" {raw.get("format_version")!r}'
            )
        tenant_id = _require_non_empty_string(raw.get("tenant_id"), source, "tenant_id")
        environment_id = _require_non_empty_string(
            raw.get("environment_id"), source, "environment_id"
        )
        playbook_version_id = raw.get("playbook_version_id")
    else:
        if raw.get("version") != PLAYBOOK_FORMAT_VERSION:
            raise ValueError(
                f'Invalid {source}: unsupported legacy "version" {raw.get("version")!r}'
            )
        tenant_id_value = raw.get("tenant_id")
        environment_id_value = raw.get("environment_id")
        if legacy_target_defaults is not None:
            if not isinstance(tenant_id_value, str) or not tenant_id_value:
                tenant_id_value = legacy_target_defaults["tenant_id"]
            if not isinstance(environment_id_value, str) or not environment_id_value:
                environment_id_value = legacy_target_defaults["environment_id"]
        tenant_id = _require_non_empty_string(tenant_id_value, source, "tenant_id")
        environment_id = _require_non_empty_string(environment_id_value, source, "environment_id")
        playbook_version_id = raw.get("change_set_id")

    if playbook_version_id is not None and not isinstance(playbook_version_id, str):
        raise ValueError(f'Invalid {source}: "playbook_version_id" must be a string or null')

    playbook_handle = raw.get("playbook_handle", "default")
    _require_non_empty_string(playbook_handle, source, "playbook_handle")

    project_id = raw.get("project_id")
    if project_id is not None:
        _require_non_empty_string(project_id, source, "project_id")
    exported_at = raw.get("exported_at")
    if exported_at is not None and not isinstance(exported_at, str):
        raise ValueError(f'Invalid {source}: "exported_at" must be a string')
    schema_version = raw.get("schema_version")
    if schema_version is not None:
        _require_non_empty_string(schema_version, source, "schema_version")
    bundle_schema_version = raw.get("bundle_schema_version")
    if bundle_schema_version is not None and (
        not isinstance(bundle_schema_version, int)
        or isinstance(bundle_schema_version, bool)
        or bundle_schema_version < 0
    ):
        raise ValueError(
            f'Invalid {source}: "bundle_schema_version" must be a non-negative integer'
        )

    normalized = {
        key: value for key, value in raw.items() if key not in {"version", "change_set_id"}
    }
    normalized.update(
        {
            "artifact_type": "playbook",
            "format_version": PLAYBOOK_FORMAT_VERSION,
            "playbook_handle": playbook_handle,
            "playbook_version_id": playbook_version_id,
            "tenant_id": tenant_id,
            "environment_id": environment_id,
        }
    )
    _validate_body(normalized, source)
    return normalized


__all__ = [
    "PLAYBOOK_FORMAT_VERSION",
    "ConfigArtifact",
    "LegacyConfigTargetDefaults",
    "LegacyRevTurbineConfig",
    "Playbook",
    "PlaybookHeader",
    "RevTurbineConfig",
    "parse_playbook_or_throw",
]
