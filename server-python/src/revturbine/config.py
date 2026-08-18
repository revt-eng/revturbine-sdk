"""Portable Playbook header types and dual-read normalization."""

from __future__ import annotations

import json
import warnings
from typing import Any, Literal, NamedTuple, TypeAlias, TypedDict, TypeGuard

PLAYBOOK_FORMAT_VERSION = "1.0.0"

BUNDLE_SCHEMA_VERSION = 14
"""Newest payload ``bundle_schema_version`` this port fully understands.

Mirror of ``SCHEMA_VERSION`` in scaffold ``src/core/bundle/ir.ts`` — the
single source of truth, whose header logs every bump. The two must advance
in lockstep or version refusal diverges between ports.
"""

BUNDLE_MIN_READABLE_SCHEMA_VERSION = 11
"""Oldest payload ``bundle_schema_version`` this port still reads correctly.

Mirror of ``MIN_READABLE_SCHEMA_VERSION`` in scaffold ``src/core/bundle/ir.ts``.
"""


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
    bundle_min_readable_schema_version: int


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
    bundle_min_readable = raw.get("bundle_min_readable_schema_version")
    if bundle_min_readable is not None and (
        not isinstance(bundle_min_readable, int)
        or isinstance(bundle_min_readable, bool)
        or bundle_min_readable < 0
    ):
        raise ValueError(
            f'Invalid {source}: "bundle_min_readable_schema_version" must be a non-negative integer'
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


# ── Canonical-JSON payload version refusal (plan 177 TASK-3 / AC-3) ─────────
#
# Port of scaffold ``src/core/bundle/json-payload.ts`` — the reference
# implementation. The delivered payload artifact carries
# ``bundle_schema_version`` (what wrote it) and
# ``bundle_min_readable_schema_version`` (the oldest reader the writer
# vouches for). A runtime refuses — on raw parsed JSON, before the body is
# parsed or any rule evaluated — rather than partially applying config it
# cannot fully understand, because missing semantics can silently
# over-grant. Policy today is the strict range check
# ``[BUNDLE_MIN_READABLE_SCHEMA_VERSION .. BUNDLE_SCHEMA_VERSION]``; the
# payload-carried floor exists so a future additive-forward relaxation
# needs no artifact re-stamping.

PlaybookPayloadRefusalReason: TypeAlias = Literal[
    "malformed_envelope",
    "missing_schema_version",
    "schema_version_too_new",
    "schema_version_too_old",
    "requires_newer_reader",
]
"""Why a payload was refused. Mirrors the TypeScript reason taxonomy."""


class PlaybookPayloadVersionError(ValueError):
    """A delivered payload's version window is outside what this reader supports."""

    def __init__(self, reason: PlaybookPayloadRefusalReason, message: str) -> None:
        super().__init__(message)
        self.reason: PlaybookPayloadRefusalReason = reason


class PlaybookPayloadVersion(NamedTuple):
    """The version pair extracted from a payload envelope."""

    schema_version: int
    min_readable_schema_version: int


def _is_non_negative_int(value: Any) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def read_playbook_payload_version(raw: Any) -> PlaybookPayloadVersion:
    """Extract and envelope-validate the payload's version pair from raw JSON.

    No body parsing, no rule evaluation. A payload that predates the floor
    field gets ``floor = schema_version`` — the conservative reading that
    claims no cross-version compatibility.
    """
    if not isinstance(raw, dict):
        raise PlaybookPayloadVersionError(
            "malformed_envelope",
            "Playbook payload: expected a top-level JSON object",
        )
    version = raw.get("bundle_schema_version")
    if not _is_non_negative_int(version):
        raise PlaybookPayloadVersionError(
            "missing_schema_version",
            'Playbook payload: missing non-negative integer "bundle_schema_version" '
            "— refusing an unversioned payload",
        )
    floor = raw.get("bundle_min_readable_schema_version")
    if floor is None:
        return PlaybookPayloadVersion(version, version)
    if not _is_non_negative_int(floor) or floor > version:
        raise PlaybookPayloadVersionError(
            "malformed_envelope",
            f'Playbook payload: "bundle_min_readable_schema_version" ({floor!r}) must be '
            f"a non-negative integer <= bundle_schema_version ({version})",
        )
    return PlaybookPayloadVersion(version, floor)


def assert_playbook_payload_readable(
    raw: Any,
    *,
    schema_version: int | None = None,
    min_readable_schema_version: int | None = None,
) -> PlaybookPayloadVersion:
    """The refusal gate (AC-3).

    Raises :class:`PlaybookPayloadVersionError` unless the payload's version
    window is fully inside what this reader supports; returns the version
    pair on success. Run on raw parsed JSON BEFORE any body parse — refusing
    late is indistinguishable from partially applying config.
    """
    supported = BUNDLE_SCHEMA_VERSION if schema_version is None else schema_version
    reader_floor = (
        BUNDLE_MIN_READABLE_SCHEMA_VERSION
        if min_readable_schema_version is None
        else min_readable_schema_version
    )
    version = read_playbook_payload_version(raw)
    if version.min_readable_schema_version > supported:
        raise PlaybookPayloadVersionError(
            "requires_newer_reader",
            f"Playbook payload requires schema_version >= {version.min_readable_schema_version}; "
            f"this reader supports {reader_floor}..{supported}",
        )
    if version.schema_version > supported:
        raise PlaybookPayloadVersionError(
            "schema_version_too_new",
            f"Playbook payload: unsupported bundle_schema_version={version.schema_version} "
            f"(reader supports {reader_floor}..{supported})",
        )
    if version.schema_version < reader_floor:
        raise PlaybookPayloadVersionError(
            "schema_version_too_old",
            f"Playbook payload: unsupported bundle_schema_version={version.schema_version} "
            f"(reader supports {reader_floor}..{supported})",
        )
    return version


def parse_playbook_payload(
    data: str | bytes,
    source: str = "playbook payload",
    *,
    schema_version: int | None = None,
    min_readable_schema_version: int | None = None,
) -> Playbook:
    """Parse a delivered payload artifact into a validated Playbook.

    The Python counterpart of the TypeScript ``parsePlaybookPayload``. Order
    is the contract: decode strict UTF-8, ``json.loads``, version refusal,
    THEN :func:`parse_playbook_or_throw`. Payloads are canonical artifacts —
    there is no legacy-defaults escape hatch here.
    """
    text = data.decode("utf-8") if isinstance(data, bytes) else data
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as err:
        raise ValueError(f"Invalid {source}: not valid JSON — {err}") from err
    assert_playbook_payload_readable(
        raw,
        schema_version=schema_version,
        min_readable_schema_version=min_readable_schema_version,
    )
    playbook = parse_playbook_or_throw(raw, source)
    if playbook is None:  # pragma: no cover — raw is a dict, never None here
        raise ValueError(f"Invalid {source}: empty payload")
    return playbook


__all__ = [
    "BUNDLE_MIN_READABLE_SCHEMA_VERSION",
    "BUNDLE_SCHEMA_VERSION",
    "PLAYBOOK_FORMAT_VERSION",
    "ConfigArtifact",
    "LegacyConfigTargetDefaults",
    "LegacyRevTurbineConfig",
    "Playbook",
    "PlaybookHeader",
    "PlaybookPayloadRefusalReason",
    "PlaybookPayloadVersion",
    "PlaybookPayloadVersionError",
    "RevTurbineConfig",
    "assert_playbook_payload_readable",
    "parse_playbook_or_throw",
    "parse_playbook_payload",
    "read_playbook_payload_version",
]
