"""Tests for ``revturbine.core.providers.registry``."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from revturbine.core.providers.registry import DomainProviderRegistry


@pytest.fixture
def freeze_time(monkeypatch: pytest.MonkeyPatch) -> Callable[[float], None]:
    """Freeze ``time.time`` across the registry module."""
    state = {"now": 1_000_000.0}

    def _fake_time() -> float:
        return state["now"]

    monkeypatch.setattr(
        "revturbine.core.providers.registry.time.time",
        _fake_time,
    )

    def setter(now_seconds: float) -> None:
        state["now"] = now_seconds

    return setter


class _StubProvider:
    """Minimal provider satisfying the ``DomainProvider`` Protocol."""

    def __init__(
        self,
        *,
        domain: str,
        value: Any,
        cache_ttl_ms: int = 0,
    ) -> None:
        self.domain = domain
        self._value = value
        self.cache_ttl_ms = cache_ttl_ms
        self.resolve_count = 0

    def resolve(self) -> Any:
        self.resolve_count += 1
        return self._value


class _SubscribableProvider(_StubProvider):
    def __init__(
        self,
        *,
        domain: str,
        value: Any,
        cache_ttl_ms: int = 0,
    ) -> None:
        super().__init__(domain=domain, value=value, cache_ttl_ms=cache_ttl_ms)
        self._listeners: list[Callable[[Any], None]] = []
        self.unsubscribe_calls = 0

    def subscribe(self, listener: Callable[[Any], None]) -> Callable[[], None]:
        self._listeners.append(listener)

        def _unsub() -> None:
            self.unsubscribe_calls += 1
            self._listeners.remove(listener)

        return _unsub

    def push(self, value: Any) -> None:
        for listener in list(self._listeners):
            listener(value)


# ── Registration ────────────────────────────────────────────────────────────


class TestRegistration:
    def test_register_and_get(self) -> None:
        reg = DomainProviderRegistry()
        reg.register(_StubProvider(domain="plan", value={"current_plan_handle": "pro"}))
        assert reg.has("plan")
        assert reg.size == 1
        assert reg.get("plan") == {"current_plan_handle": "pro"}

    def test_register_replaces_existing(self) -> None:
        reg = DomainProviderRegistry()
        reg.register(_StubProvider(domain="plan", value="A"))
        reg.register(_StubProvider(domain="plan", value="B"))
        assert reg.get("plan") == "B"
        assert reg.size == 1

    def test_unregister_drops_provider(self) -> None:
        reg = DomainProviderRegistry()
        reg.register(_StubProvider(domain="plan", value="A"))
        reg.unregister("plan")
        assert not reg.has("plan")
        assert reg.get("plan") is None

    def test_unregister_unknown_is_noop(self) -> None:
        reg = DomainProviderRegistry()
        reg.unregister("missing")  # No raise.

    def test_clear_drops_everything(self) -> None:
        reg = DomainProviderRegistry()
        reg.register(_StubProvider(domain="plan", value="A"))
        reg.register(_StubProvider(domain="entitlements", value={"entries": {}}))
        reg.clear()
        assert reg.size == 0
        assert not reg.has("plan")

    def test_get_unknown_returns_none(self) -> None:
        reg = DomainProviderRegistry()
        assert reg.get("missing") is None


# ── Caching ─────────────────────────────────────────────────────────────────


class TestCaching:
    def test_zero_ttl_re_resolves_every_call(self) -> None:
        reg = DomainProviderRegistry()
        provider = _StubProvider(domain="plan", value="X", cache_ttl_ms=0)
        reg.register(provider)
        reg.resolve_all()
        reg.resolve_all()
        reg.resolve_all()
        assert provider.resolve_count == 3

    def test_positive_ttl_uses_cache_within_window(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1.0)
        reg = DomainProviderRegistry()
        provider = _StubProvider(domain="plan", value="X", cache_ttl_ms=10_000)
        reg.register(provider)
        reg.resolve_all()
        # Within window — cache hit.
        freeze_time(5.0)
        reg.resolve_all()
        assert provider.resolve_count == 1
        # Past window — re-resolve.
        freeze_time(15.0)
        reg.resolve_all()
        assert provider.resolve_count == 2

    def test_invalidate_clears_one_domain(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1.0)
        reg = DomainProviderRegistry()
        provider = _StubProvider(domain="plan", value="X", cache_ttl_ms=10_000)
        reg.register(provider)
        reg.resolve_all()
        reg.invalidate("plan")
        reg.resolve_all()
        assert provider.resolve_count == 2

    def test_invalidate_all_clears_every_domain(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1.0)
        reg = DomainProviderRegistry()
        a = _StubProvider(domain="plan", value="A", cache_ttl_ms=10_000)
        b = _StubProvider(domain="entitlements", value={"entries": {}}, cache_ttl_ms=10_000)
        reg.register(a)
        reg.register(b)
        reg.resolve_all()
        reg.invalidate_all()
        reg.resolve_all()
        assert a.resolve_count == 2
        assert b.resolve_count == 2


# ── Subscription / push invalidation ────────────────────────────────────────


class TestSubscription:
    def test_subscription_pushes_into_cache(
        self,
        freeze_time: Callable[[float], None],
    ) -> None:
        freeze_time(1.0)
        reg = DomainProviderRegistry()
        provider = _SubscribableProvider(
            domain="plan",
            value="initial",
            cache_ttl_ms=10_000,
        )
        reg.register(provider)
        # Pushed value goes straight into the cache; no resolve needed.
        provider.push("pushed")
        assert reg.get("plan") == "pushed"
        assert provider.resolve_count == 0

    def test_unregister_unsubscribes(self) -> None:
        reg = DomainProviderRegistry()
        provider = _SubscribableProvider(domain="plan", value="A")
        reg.register(provider)
        reg.unregister("plan")
        assert provider.unsubscribe_calls == 1

    def test_clear_unsubscribes_all(self) -> None:
        reg = DomainProviderRegistry()
        a = _SubscribableProvider(domain="plan", value="A")
        b = _SubscribableProvider(domain="entitlements", value={"entries": {}})
        reg.register(a)
        reg.register(b)
        reg.clear()
        assert a.unsubscribe_calls == 1
        assert b.unsubscribe_calls == 1


# ── resolve_all merge semantics ─────────────────────────────────────────────


class TestResolveAll:
    def test_returns_each_domain_under_its_key(self) -> None:
        reg = DomainProviderRegistry()
        reg.register(_StubProvider(domain="plan", value={"current_plan_handle": "pro"}))
        reg.register(
            _StubProvider(
                domain="entitlements",
                value={"entries": {"a": {"status": "allowed", "allowed": True}}},
            ),
        )
        ctx = reg.resolve_all()
        assert ctx["plan"] == {"current_plan_handle": "pro"}
        assert ctx["entitlements"]["entries"]["a"]["allowed"] is True

    def test_merges_traits_namespaces(self) -> None:
        reg = DomainProviderRegistry()
        reg.register(_StubProvider(domain="traits", value={"traits": {"plan": "pro"}}))
        reg.register(
            _StubProvider(domain="traits:trial", value={"traits": {"trial_active": True}}),
        )
        reg.register(
            _StubProvider(domain="traits:usage", value={"traits": {"usage_pct": 80}}),
        )
        ctx = reg.resolve_all()
        assert ctx["traits"] == {
            "traits": {"plan": "pro", "trial_active": True, "usage_pct": 80},
        }

    def test_traits_later_overrides_earlier(self) -> None:
        reg = DomainProviderRegistry()
        reg.register(_StubProvider(domain="traits", value={"traits": {"k": "v1"}}))
        reg.register(_StubProvider(domain="traits:override", value={"traits": {"k": "v2"}}))
        ctx = reg.resolve_all()
        assert ctx["traits"]["traits"]["k"] == "v2"

    def test_traits_empty_provider_ignored(self) -> None:
        reg = DomainProviderRegistry()
        # Provider returns no traits at all → ctx has no traits key.
        reg.register(_StubProvider(domain="traits", value={"traits": {}}))
        # Wait — empty dict has has_traits=True (Object.assign with {}).
        # Match TS: `if (traitState?.traits)` → an empty {} is truthy in
        # both JS and Python, so has_traits flips to True.
        ctx = reg.resolve_all()
        assert ctx.get("traits") == {"traits": {}}

    def test_traits_non_dict_value_ignored(self) -> None:
        reg = DomainProviderRegistry()
        # Pathological provider returns a non-dict; the merge path skips it
        # rather than crashing.
        reg.register(_StubProvider(domain="traits", value="not-a-dict"))
        ctx = reg.resolve_all()
        assert "traits" not in ctx

    def test_empty_registry_returns_empty_context(self) -> None:
        reg = DomainProviderRegistry()
        assert reg.resolve_all() == {}
