"""Adapter option types — Python port of @revt-eng/core/adapters/types.ts.

Source: revturbine-scaffold/src/core/adapters/types.ts
"""

from __future__ import annotations

from typing import TypedDict

__all__ = ["AdapterBaseOptions"]


class AdapterBaseOptions(TypedDict, total=False):
    """Shared adapter options.

    ``cache_ttl_ms``: per-provider cache TTL in ms; 0 = re-resolve every
    call. The ``DomainProviderRegistry`` reads it when caching.

    Source: adapters/types.ts:11-14 (AdapterBaseOptions)
    """

    cache_ttl_ms: int
