"""RevTurbine Python SDK — headless, in-memory server-side decisioning.

``RevTurbineCustomerSdk`` (plan 33 TASK-7) is the public entry point: a
stateless wrapper that decides entitlements and placements in-process
from a caller-supplied user context + ``ExportedConfig`` — no network,
no persistence beyond memory. See :mod:`revturbine.sdk` for the scope
boundary (the browser bespoke decision engine is intentionally not
ported — plan 33 REQ-14).

The legacy thin-RPC HTTP client at ``revturbine_server`` remains
importable and unchanged; it is independent of, and composable with,
this in-memory class — not folded into it (the original plan's
dual-mode ``runtime_mode`` dispatch is superseded by the
headless-server scope decision).
"""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _package_version

from revturbine.config import (
    BUNDLE_MIN_READABLE_SCHEMA_VERSION,
    BUNDLE_SCHEMA_VERSION,
    PLAYBOOK_FORMAT_VERSION,
    ConfigArtifact,
    LegacyRevTurbineConfig,
    Playbook,
    PlaybookHeader,
    PlaybookPayloadRefusalReason,
    PlaybookPayloadVersion,
    PlaybookPayloadVersionError,
    RevTurbineConfig,
    assert_playbook_payload_readable,
    parse_playbook_or_throw,
    parse_playbook_payload,
    read_playbook_payload_version,
)
from revturbine.sdk import RevTurbineCustomerSdk, UserContext

# Single-sourced from the installed package metadata (pyproject.toml is the
# only place the version is written — plan 174 TASK-5 / REQ-8; the literal
# here previously drifted to 0.2.2 while pyproject moved on).
try:
    __version__ = _package_version("revturbine")
except PackageNotFoundError:  # pragma: no cover — source tree without install
    __version__ = "0.0.0+unknown"

__all__ = [
    "BUNDLE_MIN_READABLE_SCHEMA_VERSION",
    "BUNDLE_SCHEMA_VERSION",
    "PLAYBOOK_FORMAT_VERSION",
    "ConfigArtifact",
    "LegacyRevTurbineConfig",
    "Playbook",
    "PlaybookHeader",
    "PlaybookPayloadRefusalReason",
    "PlaybookPayloadVersion",
    "PlaybookPayloadVersionError",
    "RevTurbineConfig",
    "RevTurbineCustomerSdk",
    "UserContext",
    "__version__",
    "assert_playbook_payload_readable",
    "parse_playbook_or_throw",
    "parse_playbook_payload",
    "read_playbook_payload_version",
]
