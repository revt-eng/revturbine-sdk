"""Canonical "unlimited" limit handling — Python port of
@revt-eng/entitlements/unlimited.ts (plan 72 Part B).

"Unlimited" was historically spelled three ways: the string ``'unlimited'``
(legacy authoring + live evaluator), ``null``/absent (IR + compiled-bundle
convention), and the numeric sentinel ``999999`` (seed/demo display
convention). Plan 72 makes all three resolve to the same enforced result:
infinite, never a literal 999,999 cap. This module is the ONE place the
notion lives — never re-spell it inline.

Source: revturbine-scaffold/src/entitlements/unlimited.ts
"""

from __future__ import annotations

import math
from typing import Any

__all__ = ["UNLIMITED_SENTINEL", "is_unlimited_limit", "resolve_limit_value"]

# Seed/demo-data numeric sentinel meaning "unlimited" (plan 63 REQ-7 / plan 70).
UNLIMITED_SENTINEL = 999_999


def is_unlimited_limit(v: Any) -> bool:
    """True when a stored limit-like value means "unlimited": ``None``/absent,
    the string ``'unlimited'``, or the ``999999`` sentinel.

    Source: unlimited.ts (isUnlimitedLimit). Bools are excluded from the
    sentinel comparison (Python ``True == 1`` would otherwise leak through
    where JS ``true === 999999`` is false).
    """
    if v is None or v == "unlimited":
        return True
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == UNLIMITED_SENTINEL


def resolve_limit_value(v: Any) -> float | None:
    """Resolve a stored limit-like value (``limit_value`` / ``allowance`` /
    ``included_count``) to the number used for enforcement and permissiveness
    scoring: unlimited → ``+inf``; a finite number → itself; anything else →
    ``None`` (not a usable limit).

    Source: unlimited.ts (resolveLimitValue).
    """
    if is_unlimited_limit(v):
        return math.inf
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return float(v)
    return None
