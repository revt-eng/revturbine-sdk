"""Canonical-JSON payload parsing + version refusal — plan 177 TASK-3 / AC-3.

Unit coverage for the live-constant defaults and the ``parse_playbook_payload``
boundary. The cross-language refusal matrix (explicit reader windows, all
reasons) lives in ``parity_contract/test_version_refusal.py``.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from revturbine.config import (
    BUNDLE_MIN_READABLE_SCHEMA_VERSION,
    BUNDLE_SCHEMA_VERSION,
    PlaybookPayloadVersion,
    PlaybookPayloadVersionError,
    assert_playbook_payload_readable,
    parse_playbook_or_throw,
    parse_playbook_payload,
    read_playbook_payload_version,
)


def _payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "artifact_type": "playbook",
        "format_version": "1.0.0",
        "tenant_id": "tenant_t",
        "environment_id": "production",
        "bundle_schema_version": BUNDLE_SCHEMA_VERSION,
        "bundle_min_readable_schema_version": BUNDLE_MIN_READABLE_SCHEMA_VERSION,
        "plans": [],
        "entitlements": [],
        "entitlement_rules": [],
        "segments": [],
        "content_ui_paths": [],
    }
    base.update(overrides)
    return base


def test_constants_form_a_valid_window() -> None:
    assert 0 <= BUNDLE_MIN_READABLE_SCHEMA_VERSION <= BUNDLE_SCHEMA_VERSION


def test_defaults_accept_a_currently_stamped_payload() -> None:
    version = assert_playbook_payload_readable(_payload())
    assert version == PlaybookPayloadVersion(
        BUNDLE_SCHEMA_VERSION, BUNDLE_MIN_READABLE_SCHEMA_VERSION
    )


def test_absent_floor_defaults_to_schema_version() -> None:
    raw = _payload()
    del raw["bundle_min_readable_schema_version"]
    assert read_playbook_payload_version(raw) == PlaybookPayloadVersion(
        BUNDLE_SCHEMA_VERSION, BUNDLE_SCHEMA_VERSION
    )


def test_parse_playbook_payload_round_trips_bytes() -> None:
    playbook = parse_playbook_payload(json.dumps(_payload()).encode("utf-8"))
    assert playbook["tenant_id"] == "tenant_t"
    assert playbook["bundle_schema_version"] == BUNDLE_SCHEMA_VERSION
    assert playbook["bundle_min_readable_schema_version"] == BUNDLE_MIN_READABLE_SCHEMA_VERSION
    # parse_playbook_or_throw normalization applied (defaulted handle).
    assert playbook["playbook_handle"] == "default"


def test_parse_playbook_payload_accepts_str() -> None:
    playbook = parse_playbook_payload(json.dumps(_payload()))
    assert playbook["environment_id"] == "production"


def test_refuses_before_parsing_the_body() -> None:
    # Body is garbage AND the version is too new: the version refusal must
    # win, proving no body parsing precedes the gate.
    raw = {
        "bundle_schema_version": BUNDLE_SCHEMA_VERSION + 10,
        "plans": "not-even-an-array",
    }
    with pytest.raises(PlaybookPayloadVersionError):
        parse_playbook_payload(json.dumps(raw))


def test_rejects_invalid_json() -> None:
    with pytest.raises(ValueError, match="not valid JSON"):
        parse_playbook_payload('{"bundle_schema_version":')


def test_rejects_invalid_utf8_bytes() -> None:
    with pytest.raises(UnicodeDecodeError):
        parse_playbook_payload(b'{"\xff\xfe":1}')


def test_lenient_parser_type_checks_the_floor_field() -> None:
    ok = parse_playbook_or_throw(_payload(), "test")
    assert ok is not None

    with pytest.raises(ValueError, match="bundle_min_readable_schema_version"):
        parse_playbook_or_throw(_payload(bundle_min_readable_schema_version="11"), "test")
    with pytest.raises(ValueError, match="bundle_min_readable_schema_version"):
        parse_playbook_or_throw(_payload(bundle_min_readable_schema_version=-1), "test")
    # Hand-authored configs without an envelope remain a supported legacy path.
    raw = _payload()
    del raw["bundle_schema_version"]
    del raw["bundle_min_readable_schema_version"]
    with pytest.warns(RuntimeWarning, match="no bundle_schema_version"):
        assert parse_playbook_or_throw(raw, "test") is not None


@pytest.mark.parametrize("version", [15, 16, 18])
def test_constructor_boundary_accepts_supported_versions(version: int) -> None:
    assert parse_playbook_or_throw(_payload(bundle_schema_version=version), "test") is not None


@pytest.mark.parametrize("version", [10, 999, "18", None])
def test_constructor_boundary_refuses_bad_versions(version: Any) -> None:
    with pytest.raises(PlaybookPayloadVersionError):
        parse_playbook_or_throw(_payload(bundle_schema_version=version), "test")


@pytest.mark.parametrize("versioned", [True, False])
def test_constructor_boundary_refuses_mandatory_extensions(versioned: bool) -> None:
    raw = _payload(extension_rules=[{"kind": "geo.v1", "must_understand": True}])
    if not versioned:
        del raw["bundle_schema_version"]
        del raw["bundle_min_readable_schema_version"]
    with pytest.raises(PlaybookPayloadVersionError, match="unsupported mandatory extension"):
        parse_playbook_or_throw(raw, "test")
