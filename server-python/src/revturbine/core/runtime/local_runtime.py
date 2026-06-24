"""LocalRuntime — Python port of
@revt-eng/core/runtime/local-runtime.ts.

The standard composition of core subsystems for local-only
(in-process / embedded) placement and entitlement decisioning. Composes
``DomainProviderRegistry`` + ``DecisionEngine`` + ``InteractionTracker``
+ ``CapEnforcer`` + ``ImpressionHistory`` + the static placement
resolver. All pure, no network calls.

Per Q-5 the surface is **sync** (local-mode is CPU-bound: predicate
evaluation, in-memory caps). The TS methods are ``async`` only because
their signatures permit ``Promise``; the bodies have no awaits. An
``a``-prefixed async/HTTP-backed variant is **out of the headless
server SDK scope** (a residual non-goal of the narrowed plan 33).

``ExportedConfig`` stays loosely typed (``dict[str, Any]``) — the same
deliberate decision the resolver/engine ports made (avoids coupling to
the generated ``revturbine_types`` package, which server-python does
not vendor — that vendoring is likewise a residual non-goal). The
parity suite (TASK-8/9/10) is the backstop against schema drift.

Deferred leaves — faithful to the TS class shape, but the helper each
needs is not ported because it is **out of the headless server SDK
scope** (plan 33 REQ-14 browser/segments non-goal); the method raises
``NotImplementedError`` naming that boundary rather than silently
mis-deciding:

- ``evaluate_segments`` → ``evaluateSegments``
  (``segments/controllers/segments``) — REQ-14 non-goal.
- ``build_targeting_state`` → ``buildTargetingState``
  (``user/controllers/user-context``) — REQ-14 non-goal.
- ``derive_personalization_tokens`` →
  ``derivePlacementPersonalizationTokens``
  (``placements/controllers/token-derivation``) — REQ-14 non-goal.

``_derive_entitlement_from_config`` is now wired (plan 33 TASK-13) —
the faithful port of ``deriveLocalEntitlementFromConfiguredRules``.

These are exactly the non-placement paths the plan defers to a later
phase (Risks §"placement decisioning second"); TASK-6's acceptance is a
placement decision served locally with no network call, which the fully
wired engine/resolver path below satisfies. ``check_entitlement`` still
works for provider-backed entitlements via the ported engine path — the
deferred leaf is only the no-provider config fallback.

Source: revturbine-scaffold/src/core/runtime/local-runtime.ts
"""

from __future__ import annotations

from typing import Any, TypedDict

from revturbine.core.decisions import (
    DecisionEngine,
    DecisionEngineOptions,
    EntitlementCheckResult,
    PlacementDecision,
    PlacementDecisionInput,
    PlacementRecord,
    PlacementResolver,
)
from revturbine.core.entitlements import (
    derive_local_entitlement_from_configured_rules,
)
from revturbine.core.placements import (
    ExportedConfig,
    LocalPlacementDataset,
    create_static_placement_resolver,
)
from revturbine.core.providers import (
    DomainProvider,
    DomainProviderRegistry,
    ResolvedProviderContext,
)
from revturbine.core.state import (
    CapEnforcer,
    ImpressionHistory,
    ImpressionHistoryStore,
    InMemoryImpressionStore,
    InMemoryStorage,
    InteractionTracker,
    RevTurbineStorage,
    RevTurbineTreatmentInteractionInput,
)

__all__ = ["LocalRuntime", "LocalRuntimeInteractionOptions"]


class LocalRuntimeInteractionOptions(TypedDict, total=False):
    """The local-mode-relevant subset of ``InteractionTrackerOptions``.

    Mirrors the TS
    ``Partial<Pick<InteractionTrackerOptions,
    'defaultDismissCooldownMs' | 'defaultRemindLaterMs'>>``
    (``local-runtime.ts:93``). Splatted into ``InteractionTracker`` so
    only explicitly supplied overrides take effect.
    """

    default_dismiss_cooldown_ms: int
    default_remind_later_ms: int


class LocalRuntime:
    """Standard local-only composition of the ported core subsystems.

    Source: local-runtime.ts:100-370
    """

    def __init__(
        self,
        *,
        tenant_id: str,
        user_id: str,
        exported_config: ExportedConfig,
        providers: list[DomainProvider],
        placements: LocalPlacementDataset | None = None,
        custom_resolver: PlacementResolver | None = None,
        storage: RevTurbineStorage | None = None,
        impression_store: ImpressionHistoryStore | None = None,
        engine_options: DecisionEngineOptions | None = None,
        interaction_options: LocalRuntimeInteractionOptions | None = None,
    ) -> None:
        """Compose the runtime.

        Source: local-runtime.ts:112-158
        """
        self.tenant_id = tenant_id
        self._user_id = user_id
        self._exported_config = exported_config

        resolved_storage: RevTurbineStorage = storage if storage is not None else InMemoryStorage()

        # Provider registry
        self.registry = DomainProviderRegistry()
        for provider in providers:
            self.registry.register(provider)

        # Interaction tracker (spread the local-mode option subset)
        itk_opts: LocalRuntimeInteractionOptions = (
            interaction_options if interaction_options is not None else {}
        )
        self.interaction_tracker = InteractionTracker(
            storage=resolved_storage,
            tenant_id=tenant_id,
            user_id=user_id,
            **itk_opts,
        )

        # Cap enforcer
        self.cap_enforcer = CapEnforcer(
            storage=resolved_storage,
            tenant_id=tenant_id,
            user_id=user_id,
        )

        # Impression history
        self.impression_history = ImpressionHistory(
            store=(impression_store if impression_store is not None else InMemoryImpressionStore()),
            user_id=user_id,
        )

        # Placement resolver
        placement_resolver: PlacementResolver = (
            custom_resolver
            if custom_resolver is not None
            else self._build_placement_resolver(placements, exported_config)
        )

        # Registry of placement records the engine looks up by id
        self._registered_placements: dict[str, PlacementRecord] = {}

        # Decision engine
        self.engine = DecisionEngine(
            registry=self.registry,
            interaction_tracker=self.interaction_tracker,
            cap_enforcer=self.cap_enforcer,
            options=engine_options,
            placements=self._registered_placements,
            placement_resolver=placement_resolver,
        )

    # ── Placement registration ────────────────────────────────────────────

    def register_placement(self, record: PlacementRecord) -> None:
        """Register a placement record so the engine can look it up.

        Keyed by ``placement_id`` — the Python ``PlacementRecord`` port
        renamed the TS ``RevTurbinePlacementRecord.id`` field to
        ``placement_id`` (the key ``DecisionEngine`` looks up by).

        Source: local-runtime.ts:164-169
        """
        self._registered_placements[record["placement_id"]] = record

    # ── Decision pipeline ─────────────────────────────────────────────────

    def get_placement_decision(
        self,
        input_data: PlacementDecisionInput,
    ) -> PlacementDecision:
        """Evaluate a single placement decision through the full pipeline:
        suppression → providers → segments → resolver → caps → decision.

        Source: local-runtime.ts:175-183
        """
        return self.engine.evaluate(input_data)

    def get_placement_decisions(
        self,
        inputs: list[PlacementDecisionInput],
    ) -> list[PlacementDecision]:
        """Evaluate multiple placement decisions.

        Source: local-runtime.ts:185-192
        """
        return self.engine.evaluate_batch(inputs)

    # ── Entitlement checking ──────────────────────────────────────────────

    def check_entitlement(
        self,
        handle: str,
        context: dict[str, Any] | None = None,
    ) -> EntitlementCheckResult:
        """Check entitlement access locally.

        Tries the engine (provider context) first; only falls back to
        the ExportedConfig-rule evaluator when no entitlement provider
        is registered. The fallback is the single deferred leaf
        (TASK-13); provider-backed entitlements work today.

        Source: local-runtime.ts:198-214
        """
        engine_result = self.engine.check_entitlement(handle, context)
        if engine_result.get("reason") == "no_entitlement_provider":
            return self._derive_entitlement_from_config(handle, context)
        return engine_result

    # ── Interaction tracking ──────────────────────────────────────────────

    def track_interaction(
        self,
        input_data: RevTurbineTreatmentInteractionInput,
    ) -> None:
        """Record a treatment interaction (dismiss, snooze, cta_clicked).

        Source: local-runtime.ts:220-225
        """
        self.engine.track_interaction(input_data)

    def clear_suppression(
        self,
        placement_id: str,
        user_id: str | None = None,
    ) -> None:
        """Clear suppression for a placement.

        Source: local-runtime.ts:227-232
        """
        self.interaction_tracker.clear_suppression(
            placement_id,
            user_id if user_id is not None else self._user_id,
        )

    # ── Provider context ──────────────────────────────────────────────────

    def resolve_providers(self) -> ResolvedProviderContext:
        """Resolve all domain providers and return the merged context.

        Source: local-runtime.ts:238-243
        """
        return self.registry.resolve_all()

    # ── Segment evaluation (deferred — REQ-14 non-goal) ───────────────────

    def evaluate_segments(
        self,
        traits: dict[str, str | int | bool],
    ) -> list[str]:
        """Evaluate segments for a set of user traits.

        Deferred: ``evaluateSegments`` (segments/controllers/segments.ts)
        is not ported — out of the plan-33 headless server SDK scope
        (REQ-14 browser/segments non-goal).

        Source: local-runtime.ts:249-257
        """
        raise NotImplementedError(
            "LocalRuntime.evaluate_segments requires the segments "
            "evaluator port (evaluateSegments / "
            "segments/controllers/segments.ts) — not part of the "
            "plan-33 headless server SDK scope (REQ-14 browser/segments "
            "non-goal; the narrowed TASK-7 ships only check_entitlement "
            "+ placement decisions)."
        )

    # ── Targeting state (deferred — REQ-14 non-goal) ──────────────────────

    def build_targeting_state(
        self,
        context: dict[str, Any],
        usage_overrides: dict[str, int] | None = None,
    ) -> dict[str, Any]:
        """Build the full targeting state from a user context snapshot.

        Deferred: ``buildTargetingState``
        (user/controllers/user-context.ts) is not ported — out of the
        plan-33 headless server SDK scope (REQ-14 non-goal; a precise
        ``TargetingState`` type would land with it, hence the
        placeholder return annotation).

        Source: local-runtime.ts:263-271
        """
        raise NotImplementedError(
            "LocalRuntime.build_targeting_state requires the "
            "user-context port (buildTargetingState / "
            "user/controllers/user-context.ts) — not part of the "
            "plan-33 headless server SDK scope (REQ-14 non-goal; the "
            "narrowed TASK-7 ships only check_entitlement + placement "
            "decisions)."
        )

    # ── Personalization tokens (deferred — REQ-14 non-goal) ───────────────

    def derive_personalization_tokens(
        self,
        base: dict[str, Any] | None = None,
    ) -> dict[str, str | int]:
        """Derive personalization tokens from current provider state.

        Deferred: ``derivePlacementPersonalizationTokens``
        (placements/controllers/token-derivation.ts) is not ported —
        out of the plan-33 headless server SDK scope (REQ-14 non-goal).

        Source: local-runtime.ts:277-289
        """
        raise NotImplementedError(
            "LocalRuntime.derive_personalization_tokens requires the "
            "token-derivation port "
            "(derivePlacementPersonalizationTokens / "
            "placements/controllers/token-derivation.ts) — not part of "
            "the plan-33 headless server SDK scope (REQ-14 non-goal; "
            "the narrowed TASK-7 ships only check_entitlement + "
            "placement decisions)."
        )

    # ── User identity ─────────────────────────────────────────────────────

    def set_user_id(self, user_id: str) -> None:
        """Switch the active user. Clears impression caches.

        Source: local-runtime.ts:295-301
        """
        self._user_id = user_id
        self.impression_history.set_user_id(user_id)

    def get_user_id(self) -> str:
        """Current user id.

        Source: local-runtime.ts:303-306
        """
        return self._user_id

    # ── Config access ─────────────────────────────────────────────────────

    def get_exported_config(self) -> ExportedConfig:
        """Return the active ExportedConfig snapshot.

        Source: local-runtime.ts:312-315
        """
        return self._exported_config

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def hydrate(self) -> None:
        """Pre-warm caches (impression history) for synchronous access.

        Source: local-runtime.ts:321-326
        """
        self.impression_history.hydrate()

    def update_providers(self, providers: list[DomainProvider]) -> None:
        """Update domain providers. Clears and re-registers.

        Source: local-runtime.ts:328-336
        """
        self.registry.clear()
        for provider in providers:
            self.registry.register(provider)

    # ── Internal ──────────────────────────────────────────────────────────

    def _build_placement_resolver(
        self,
        placements: LocalPlacementDataset | None,
        exported_config: ExportedConfig,
    ) -> PlacementResolver:
        """Build the static placement resolver from the dataset, falling
        back to ``exported_config.placements``.

        Source: local-runtime.ts:342-353
        """
        dataset: LocalPlacementDataset = (
            placements
            if placements is not None
            else {"placements": exported_config.get("placements") or []}
        )
        return create_static_placement_resolver(
            placements=dataset,
            exported_config=exported_config,
            impression_history=self.impression_history,
        )

    def _derive_entitlement_from_config(
        self,
        handle: str,
        context: dict[str, Any] | None = None,
    ) -> EntitlementCheckResult:
        """ExportedConfig-rule entitlement fallback.

        Plan 33 TASK-13: faithful port of the plan-32/34-reconciled
        ``deriveLocalEntitlementFromConfiguredRules``. The TS call site
        passes empty plan/segment/usage context (the engine path already
        applied provider context; this fallback decides purely from the
        config rules), and substitutes a default-allow when the
        evaluator returns ``None`` (no config).

        Source: local-runtime.ts:355-369
        """
        result = derive_local_entitlement_from_configured_rules(
            handle=handle,
            context=context,
            current_plan_handle="",
            segment_ids=set(),
            usage_balances={},
            exported_config=self._exported_config,
        )
        if result is not None:
            return result
        return {
            "status": "allowed",
            "allowed": True,
            "reason": "local_runtime_default_allow",
        }
