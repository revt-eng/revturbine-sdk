"""DomainProviderRegistry — Python port of @revt-eng/core/providers/registry.ts.

Manages registered domain providers and resolves their collective state
into a typed ``ResolvedProviderContext``. Sync-only per Q-5 of plan 33;
async providers are a TASK-7 concern.

Source: revturbine-scaffold/src/core/providers/registry.ts
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from revturbine.core.providers.types import (
    DomainProvider,
    DomainProviderName,
    ResolvedProviderContext,
)

__all__ = ["DomainProviderRegistry"]


@dataclass
class _CacheEntry:
    value: Any
    resolved_at: int  # ms since epoch
    ttl_ms: int


def _now_ms() -> int:
    return int(time.time() * 1000)


def _cache_ttl_ms(provider: DomainProvider) -> int:
    """Read ``cache_ttl_ms`` off a provider, defaulting to ``0`` (no cache)
    when the attribute is absent. Mirrors TS's ``provider.cacheTtlMs ?? 0``."""
    return int(getattr(provider, "cache_ttl_ms", 0) or 0)


class DomainProviderRegistry:
    """Registers domain providers and resolves them into a typed context.

    Source: registry.ts:35-182
    """

    def __init__(self) -> None:
        self._providers: dict[DomainProviderName, DomainProvider] = {}
        self._cache: dict[DomainProviderName, _CacheEntry] = {}
        self._unsubscribers: dict[DomainProviderName, Callable[[], None]] = {}

    # ── Registration ───────────────────────────────────────────────────────

    def register(self, provider: DomainProvider) -> None:
        """Register a provider, replacing any existing one for the same domain.

        If the provider exposes ``subscribe(listener)``, the registry wires
        a push-based cache invalidation: every emitted value updates the
        cache entry for that domain.

        Source: registry.ts:43-62
        """
        domain = provider.domain
        if domain in self._providers:
            self.unregister(domain)
        self._providers[domain] = provider

        subscribe = getattr(provider, "subscribe", None)
        if callable(subscribe):

            def _listener(next_value: Any, _domain: DomainProviderName = domain) -> None:
                self._cache[_domain] = _CacheEntry(
                    value=next_value,
                    resolved_at=_now_ms(),
                    ttl_ms=_cache_ttl_ms(self._providers[_domain]),
                )

            unsub = subscribe(_listener)
            if callable(unsub):
                self._unsubscribers[domain] = unsub

    def unregister(self, domain: DomainProviderName) -> None:
        """Source: registry.ts:65-73"""
        self._providers.pop(domain, None)
        self._cache.pop(domain, None)
        unsub = self._unsubscribers.pop(domain, None)
        if unsub is not None:
            unsub()

    def clear(self) -> None:
        """Remove all providers, caches, and subscriptions.

        Source: registry.ts:76-81
        """
        for unsub in self._unsubscribers.values():
            unsub()
        self._providers.clear()
        self._cache.clear()
        self._unsubscribers.clear()

    # ── Resolution ─────────────────────────────────────────────────────────

    def resolve_all(self) -> ResolvedProviderContext:
        """Resolve every registered provider into a single typed context.

        ``traits`` and ``traits:<namespace>`` providers are merged into the
        single ``traits`` slot. Within-domain merge order follows insertion
        order — later-resolved providers override earlier ones for the same
        trait key. The TS uses ``Promise.all`` over registered providers;
        Python is sync per Q-5.

        Source: registry.ts:93-137
        """
        ctx: ResolvedProviderContext = {}
        merged_traits: dict[str, Any] = {}
        has_traits = False

        for domain, provider in self._providers.items():
            value = self._resolve_with_cache(domain, provider)
            if domain == "traits" or domain.startswith("traits:"):
                trait_state = value if isinstance(value, dict) else None
                if trait_state and isinstance(trait_state.get("traits"), dict):
                    merged_traits.update(trait_state["traits"])
                    has_traits = True
            else:
                # Untyped assignment by domain name — TypedDict's TypedDict
                # access pattern doesn't permit dynamic keys; cast to plain
                # dict for the assignment, then return the TypedDict view.
                ctx_dict: dict[str, Any] = ctx  # type: ignore[assignment]
                ctx_dict[domain] = value

        if has_traits:
            ctx["traits"] = {"traits": merged_traits}
        return ctx

    def get(self, domain: DomainProviderName) -> Any | None:
        """Return the raw resolved value for a single domain (cache-aware).

        Source: registry.ts:142-161
        """
        provider = self._providers.get(domain)
        if provider is None:
            return None
        return self._resolve_with_cache(domain, provider)

    def has(self, domain: DomainProviderName) -> bool:
        """Source: registry.ts:164-166"""
        return domain in self._providers

    @property
    def size(self) -> int:
        """Source: registry.ts:169-171"""
        return len(self._providers)

    def invalidate(self, domain: DomainProviderName) -> None:
        """Source: registry.ts:174-176"""
        self._cache.pop(domain, None)

    def invalidate_all(self) -> None:
        """Force re-resolve on next call.

        Source: registry.ts:179-181
        """
        self._cache.clear()

    # ── Internal ───────────────────────────────────────────────────────────

    def _resolve_with_cache(
        self,
        domain: DomainProviderName,
        provider: DomainProvider,
    ) -> Any:
        """Read from cache when fresh, else resolve and write back."""
        cached = self._cache.get(domain)
        now = _now_ms()
        if cached is not None and cached.ttl_ms > 0 and now - cached.resolved_at < cached.ttl_ms:
            return cached.value
        value = provider.resolve()
        self._cache[domain] = _CacheEntry(
            value=value,
            resolved_at=now,
            ttl_ms=_cache_ttl_ms(provider),
        )
        return value
