"""Domain-provider value types — Python port of @revt-eng/core/providers/types.ts.

Translates the subset needed by ``DecisionEngine`` (TASK-5 batch 1:
plan, entitlement, segment, traits) plus the ``rules`` / ``content`` /
``theme`` states produced by ``create_static_providers`` (TASK-7 b1 —
`area:other`; the static adapter is the SDK's own local-mode
construction logic, so its return types land here). ``events`` / ``cta``
/ ``trial_status`` / ``usage_traits`` remain deferred.

Source: revturbine-scaffold/src/core/providers/types.ts
"""

from __future__ import annotations

from typing import Any, Literal, Protocol, TypedDict, runtime_checkable

__all__ = [
    "AnyDomainProvider",
    "ContentProviderState",
    "DomainProvider",
    "DomainProviderName",
    "EntitlementGrant",
    "EntitlementGrantSet",
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


# ── Domain names ────────────────────────────────────────────────────────────


DomainProviderName = str
"""TS uses ``'plan' | 'entitlements' | ... | 'traits:${string}'`` (a
``Literal | TraitsNamespace`` union). Python's typing can't express
the open ``traits:*`` namespace as a Literal, so we widen to ``str``
and validate at the registry's namespace-merge step instead.

Source: types.ts:33-43
"""


# ── Provider protocol ───────────────────────────────────────────────────────


@runtime_checkable
class DomainProvider(Protocol):
    """Base protocol all domain providers implement.

    ``resolve()`` is sync per the Q-5 decision in plan 33 (HTTP-mode
    async providers would need an ``aresolve()`` variant added in
    TASK-7). ``cache_ttl_ms`` is read by the registry when caching;
    ``subscribe`` is optional push-based invalidation.

    Source: types.ts:52-70
    """

    @property
    def domain(self) -> DomainProviderName: ...
    def resolve(self) -> Any: ...


# Convenience alias matching TS's ``AnyDomainProvider``.
AnyDomainProvider = DomainProvider


# ── Plan provider state ─────────────────────────────────────────────────────


class _PlanProviderStateRequired(TypedDict):
    current_plan_handle: str


class PlanProviderState(_PlanProviderStateRequired, total=False):
    """Source: types.ts:76-95 (extended in plan 43 TASK-8 / TASK-12).

    Trial fields mirror the TS ``PlanProviderState`` shape:
    ``trialActive`` / ``trialLimitType`` / ``trialProgressPercent`` /
    ``trialDaysRemaining`` / ``trialDaysTotal`` / ``trialState`` /
    ``trialUsageEntitlementHandle`` / ``trialUsageConsumed`` /
    ``trialUsageLimit``. The placement resolver's trial-gating reads
    ``trial_progress_percent`` first (universal) and falls back to
    time-based or usage-based math.
    """

    current_plan_name: str
    current_plan_price: str
    billing_period: Literal["monthly", "annual", "none"]
    trial_active: bool
    trial_limit_type: Literal["time", "usage"]
    trial_progress_percent: float
    trial_days_remaining: float
    trial_days_total: float
    trial_state: str
    trial_usage_entitlement_handle: str
    trial_usage_consumed: float
    trial_usage_limit: float
    available_plan_handles: list[str]


# ── Entitlement provider state ──────────────────────────────────────────────


class _EntitlementResultRequired(TypedDict):
    status: Literal["allowed", "limited", "denied"]
    allowed: bool


class EntitlementResult(_EntitlementResultRequired, total=False):
    """Per-handle entitlement decision, mirroring the schema's
    ``EntitlementCheckResult``. The TS-side ``EntitlementResult`` is an
    alias of ``EntitlementCheckResult`` from ``@revt-eng/schema``;
    we redeclare here pending TASK-7's vendoring of ``revturbine_types``.

    Source: types.ts:38 + schema EntitlementCheckResult
    """

    reason: str
    limit: float
    used: float
    remaining: float
    tier: str


class _EntitlementUsageEntryRequired(TypedDict):
    used: float
    limit: float
    remaining: float


class EntitlementUsageEntry(_EntitlementUsageEntryRequired, total=False):
    """Source: types.ts:147-157"""

    unit: str
    period: str
    reset_date: str


class _EntitlementGrantRequired(TypedDict):
    entitlement_id: str
    status: Literal["allowed", "limited", "denied"]


class EntitlementGrant(_EntitlementGrantRequired, total=False):
    """Source: types.ts:110-131"""

    entitlement_handle: str
    limit: float
    used: float
    allocation: str
    enforcement: Literal["hard_block", "soft_block", "degrade", "allow_overage"]
    source: Literal["rule", "user_context", "override"]
    plan_id: str
    segment_id: str
    seat_type_id: str
    rule_id: str


class EntitlementGrantSet(TypedDict, total=False):
    """Multi-level grants (account → instance → user). Most-specific wins.

    Source: types.ts:137-141
    """

    account: dict[str, EntitlementGrant]
    instance: dict[str, EntitlementGrant]
    user: dict[str, EntitlementGrant]


class _EntitlementProviderStateRequired(TypedDict):
    entries: dict[str, EntitlementResult]


class EntitlementProviderState(_EntitlementProviderStateRequired, total=False):
    """Source: types.ts:159-173"""

    usage: dict[str, EntitlementUsageEntry]
    grants: EntitlementGrantSet


# ── Segment provider state ──────────────────────────────────────────────────


class _SegmentProviderStateRequired(TypedDict):
    segment_ids: list[str]


class SegmentProviderState(_SegmentProviderStateRequired, total=False):
    """Source: types.ts:185-189"""

    segment_slugs: list[str]


# ── Traits provider state ───────────────────────────────────────────────────


class _TraitsProviderStateRequired(TypedDict):
    traits: dict[str, Any]


class TraitsProviderState(_TraitsProviderStateRequired, total=False):
    """Flat trait bag. Multiple ``traits:*``-namespaced providers merge into
    a single ``traits`` slot in ``ResolvedProviderContext``.

    Source: types.ts (TraitsProviderState interface)
    """


# ── Rule provider state ─────────────────────────────────────────────────────


class _EntitlementRuleSnapshotRequired(TypedDict):
    rule_id: str
    entitlement_id: str
    plan_ids: list[str]
    kind: Literal[
        "feature",
        "capability_tier",
        "usage_limit",
        "usage_pricing",
        "usage_rate",
        "credits",
        "seat",
    ]
    fields: dict[str, Any]


class EntitlementRuleSnapshot(_EntitlementRuleSnapshotRequired, total=False):
    """Runtime snapshot of one entitlement rule.

    ``targets`` (kind-discriminated: plan / plan_variation / addon /
    addon_variation) stays loosely typed (``list[dict[str, Any]]``) —
    the port keeps config-shaped nesting loose with the parity suite as
    the backstop. The reconciled evaluator that *consumes* these
    (``deriveLocalEntitlementFromConfiguredRules``) is plan 33 TASK-13;
    ``create_static_providers`` only populates ``plan_ids`` today
    (matching the TS static adapter).

    ``segment_ids`` is the plan #39 successor to the singular
    ``segment_id`` — empty list matches all users; non-empty applies
    flat-OR matching in this port (dimensional matching is deferred to
    parity with scaffold's ``segment-matching`` helper).

    Source: types.ts:261-289 (EntitlementRuleSnapshot)
    """

    targets: list[dict[str, Any]]
    segment_ids: list[str]


class _RuleProviderStateRequired(TypedDict):
    entitlement_rules: dict[str, list[EntitlementRuleSnapshot]]
    config_version: str


class RuleProviderState(_RuleProviderStateRequired, total=False):
    """Source: types.ts:303-310 (RuleProviderState)"""

    plan_rules: dict[str, list[dict[str, Any]]]
    # Plan #39 REQ-28: segment_id -> dimension_id lookup for §2.5
    # intra-OR / cross-AND matching. Optional during the cascade.
    segment_dimensions: dict[str, str]


# ── Content provider state ──────────────────────────────────────────────────


class _ContentProviderStateRequired(TypedDict):
    message_blocks: dict[str, dict[str, Any]]
    personalization: dict[str, Any]


class ContentProviderState(_ContentProviderStateRequired, total=False):
    """Message blocks + personalization tokens. Block/payload snapshots
    stay loosely typed per the port convention.

    Source: types.ts:229-236 (ContentProviderState)
    """

    payloads: dict[str, dict[str, Any]]


# ── Theme provider state ────────────────────────────────────────────────────


class ThemeProviderState(TypedDict):
    """Partial theme overrides to deep-merge with SDK defaults.

    Source: types.ts:356-359 (ThemeProviderState)
    """

    overrides: dict[str, Any]


# ── Resolved provider context ───────────────────────────────────────────────


class ResolvedProviderContext(TypedDict, total=False):
    """The merged output of ``DomainProviderRegistry.resolve_all()``. Each
    domain's resolved value lives under its key. ``traits:*`` sub-namespaces
    are merged into a single ``traits`` slot per the TS contract.

    Source: types.ts (ResolvedProviderContext interface)
    """

    plan: PlanProviderState
    entitlements: EntitlementProviderState
    segments: SegmentProviderState
    traits: TraitsProviderState
    rules: RuleProviderState
    content: ContentProviderState
    theme: ThemeProviderState
    # events / cta / trial_status / usage_traits remain deferred.
