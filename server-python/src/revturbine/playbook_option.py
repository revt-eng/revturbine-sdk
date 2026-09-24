"""The ``exported_config`` -> ``playbook`` keyword-alias machinery (BL-0156).

``ExportedConfig`` is dead vocabulary. Plan 118 renamed the domain object to
**Playbook** and plan 104 renamed the schema type to ``RevTurbineConfig``, but
the *keyword*, *parameter* and *method* names that carry a Playbook around the
Python port still spelled it ``exported_config``. Scaffold went first
(``@revt-eng/core`` 0.1.330, ``src/core/playbook-option.ts``) and this is the
Python counterpart, deliberately mirroring it and ``web-sdk/playbook-option.ts``.

Two rules it exists to enforce:

1. **One resolver per read site.** Every reader of either spelling goes through
   :func:`resolve_playbook_option`, so precedence cannot drift between call
   sites.
2. **One warning per process, not one per alias.** A caller still spelling
   three of these gets a single :class:`DeprecationWarning` naming the first it
   hit, not a wall. The module-level flag is what makes that "per process".

Unlike the TypeScript copies there is no development-build gate: Python's
warnings machinery already lets an operator silence or escalate a
``DeprecationWarning`` with ``-W``/``PYTHONWARNINGS``, and it is hidden by
default outside ``__main__``. That is the idiomatic equivalent of the dev-only
console line, so it is used instead of inventing an env-var gate.
"""

from __future__ import annotations

import warnings
from typing import TypeVar

__all__ = [
    "PLAYBOOK_ALIAS_REMOVAL_VERSION",
    "require_playbook_option",
    "reset_playbook_alias_warning",
    "resolve_playbook_option",
    "warn_deprecated_playbook_alias_once",
]

#: The minor that removes every ``exported_config``-spelled alias.
PLAYBOOK_ALIAS_REMOVAL_VERSION = "0.12.0"

_warned = False

T = TypeVar("T")


def warn_deprecated_playbook_alias_once(message: str) -> None:
    """Emit the one-time :class:`DeprecationWarning` for a deprecated spelling.

    The message always names the canonical replacement and the removal version.
    """
    global _warned
    if _warned:
        return
    _warned = True
    warnings.warn(
        f"{message} Removed in {PLAYBOOK_ALIAS_REMOVAL_VERSION}.",
        DeprecationWarning,
        stacklevel=3,
    )


def resolve_playbook_option(
    playbook: T | None,
    exported_config: T | None,
    label: str,
) -> T | None:
    """Return whichever spelling was supplied, ``playbook`` winning.

    Reading the deprecated ``exported_config`` warns once per process. Returns
    ``None`` when neither was supplied, so each caller decides whether that is
    an error.
    """
    if playbook is not None:
        return playbook
    if exported_config is not None:
        warn_deprecated_playbook_alias_once(
            f"`{label}(exported_config=...)` is deprecated; "
            f"pass the same Playbook as `{label}(playbook=...)`."
        )
        return exported_config
    return None


def require_playbook_option(
    playbook: T | None,
    exported_config: T | None,
    label: str,
) -> T:
    """:func:`resolve_playbook_option`, but raise when neither was supplied.

    For a read site whose keyword was *required* before the rename, so omitting
    both stays an error rather than becoming a silent ``None``.
    """
    resolved = resolve_playbook_option(playbook, exported_config, label)
    if resolved is None:
        raise ValueError(f"{label}: 'playbook' is required")
    return resolved


def reset_playbook_alias_warning() -> None:
    """Test-only: forget that the alias warning fired so the next read warns."""
    global _warned
    _warned = False
