"""revturbine.core.providers — Python port of @revt-eng/core/providers/.

Domain-provider system that supplies the decision engine's input
primitives (plans, entitlements, segments, traits, theme, etc.).

Sync-only per Q-5 of plan 33 — the TS-side `resolve()` returns
`T | Promise<T>`; the Python protocol is plain sync. HTTP-mode
async providers would need a parallel `aresolve()` / `aresolve_all()`
variant in a TASK-7 follow-up.
"""

from revturbine.core.providers.registry import DomainProviderRegistry
from revturbine.core.providers.types import (
    AnyDomainProvider,
    ContentProviderState,
    DomainProvider,
    DomainProviderName,
    EntitlementProviderState,
    EntitlementResult,
    EntitlementRuleSnapshot,
    EntitlementUsageEntry,
    PlanProviderState,
    ResolvedProviderContext,
    RuleProviderState,
    SegmentProviderState,
    ThemeProviderState,
    TraitsProviderState,
)

__all__ = [
    "AnyDomainProvider",
    "ContentProviderState",
    "DomainProvider",
    "DomainProviderName",
    "DomainProviderRegistry",
    "EntitlementProviderState",
    "EntitlementResult",
    "EntitlementRuleSnapshot",
    "EntitlementUsageEntry",
    "PlanProviderState",
    "ResolvedProviderContext",
    "RuleProviderState",
    "SegmentProviderState",
    "ThemeProviderState",
    "TraitsProviderState",
]
