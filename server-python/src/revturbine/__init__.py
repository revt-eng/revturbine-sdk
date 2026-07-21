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

from revturbine.config import (
    PLAYBOOK_FORMAT_VERSION,
    ConfigArtifact,
    LegacyRevTurbineConfig,
    Playbook,
    PlaybookHeader,
    RevTurbineConfig,
    parse_playbook_or_throw,
)
from revturbine.sdk import RevTurbineCustomerSdk, UserContext

__version__ = "0.2.2"

__all__ = [
    "PLAYBOOK_FORMAT_VERSION",
    "ConfigArtifact",
    "LegacyRevTurbineConfig",
    "Playbook",
    "PlaybookHeader",
    "RevTurbineConfig",
    "RevTurbineCustomerSdk",
    "UserContext",
    "__version__",
    "parse_playbook_or_throw",
]
