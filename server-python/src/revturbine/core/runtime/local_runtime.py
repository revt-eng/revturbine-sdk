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

``Playbook`` stays loosely typed (``dict[str, Any]``) — the same
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

``check_entitlement`` (D-61, Kent 2026-10-06) is the ONE effective
entitlement answer: the shared Playbook + user-context evaluator merged
with app-mirrored data (``user_entitlements`` grants and any app
entitlement provider) — see
:mod:`revturbine.core.entitlements.effective_entitlement`. The built-in
placement resolver reads the same effective map, so a server-side Access
Gate fires for a rule-denied user.

Source: revturbine-scaffold/src/core/runtime/local-runtime.ts
"""

from __future__ import annotations

import math
import warnings
from collections.abc import Callable, Mapping
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
from revturbine.core.entitlements.effective_entitlement import (
    AppEntitlementInputs,
    EffectiveEntitlementBase,
    EntitlementMergeOptions,
    MirroredEntitlement,
    derive_effective_entitlement,
    derive_effective_entitlements,
    reverse_trial_grants,
)
from revturbine.core.placements import (
    LocalPlacementDataset,
    Playbook,
    create_static_placement_resolver,
    resolve_placement_component_type,
)
from revturbine.core.providers import (
    DomainProvider,
    DomainProviderRegistry,
    ResolvedProviderContext,
)
from revturbine.core.segments import evaluate_segments
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
from revturbine.core.user_context import (
    build_targeting_state as _build_targeting_state,
)
from revturbine.playbook_option import (
    require_playbook_option,
    warn_deprecated_playbook_alias_once,
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
        playbook: Playbook | None = None,
        exported_config: Playbook | None = None,
        providers: list[DomainProvider],
        placements: LocalPlacementDataset | None = None,
        custom_resolver: PlacementResolver | None = None,
        storage: RevTurbineStorage | None = None,
        impression_store: ImpressionHistoryStore | None = None,
        engine_options: DecisionEngineOptions | None = None,
        interaction_options: LocalRuntimeInteractionOptions | None = None,
        user_entitlements: Mapping[str, MirroredEntitlement] | None = None,
        trial_status: Mapping[str, Any] | None = None,
        entitlement_merge: EntitlementMergeOptions | None = None,
        on_unknown_entitlement: Callable[[str], None] | None = None,
    ) -> None:
        """Compose the runtime.

        D-61 Entitlement Mirroring options:

        - ``user_entitlements`` — the user context's own entitlement data
          (``UserContext.entitlements``), merged with the Playbook evaluation.
        - ``trial_status`` — the user's trial status (``UserTrialStatus``;
          ``in_trial`` / ``trial_type`` / ``plan_handle`` are read), so
          reverse-trial grants evaluate exactly as in the browser.
        - ``entitlement_merge`` — how app-supplied entitlement data merges
          with the Playbook result. Default: app wins.
        - ``on_unknown_entitlement`` — called once per entitlement handle that
          neither the Playbook nor the app knows (it is denied). The runtime
          also emits a :class:`RuntimeWarning`. Wire telemetry here.

        Source: local-runtime.ts:112-158
        """
        self.tenant_id = tenant_id
        self._user_id = user_id
        # One resolver, so `playbook` vs the deprecated `exported_config`
        # cannot be decided differently here than anywhere else (BL-0156).
        self._playbook = require_playbook_option(playbook, exported_config, "LocalRuntime")
        self._user_entitlements: dict[str, MirroredEntitlement] = dict(user_entitlements or {})
        self._trial_status = trial_status
        self._entitlement_merge = entitlement_merge
        self._on_unknown_entitlement = on_unknown_entitlement
        self._reported_unknown_entitlements: set[str] = set()

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
            else self._build_placement_resolver(placements, self._playbook)
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

    def get_placement(
        self,
        config: dict[str, Any],
    ) -> PlacementDecision | None:
        """Resolve the winning placement for a surface slot + user context
        (plan 147 REQ-11) — the surface-keyed counterpart to
        :meth:`get_placement_decision`. The slot is resolved from the
        config's ``placement_slots`` registry into a placement record whose
        ``surface_template_ids`` drive candidate gathering, then the same
        resolver pipeline runs. Returns ``None`` when no slot matches.

        Config keys arrive snake_case (the parity harness snake-cases the
        canonical camelCase fixture args): ``slot_id`` / ``component_type`` /
        deprecated ``surface_type`` /
        ``entitlement_handle`` / ``placement_handle`` / ``fixed_only``.

        Source: local-runtime.ts:195-225
        """
        record = self._slot_record_for_config(config)
        if record is None:
            return None
        self.register_placement(record)
        return self.get_placement_decision(
            {"placement_id": record["placement_id"], "user_id": self._user_id}
        )

    # ── Entitlement checking ──────────────────────────────────────────────

    def check_entitlement(
        self,
        handle: str,
        context: dict[str, Any] | None = None,
    ) -> EntitlementCheckResult:
        """Check entitlement access locally (D-61): the shared evaluator
        decides from the Playbook + user context, then app-mirrored data
        (user-context grants and any app entitlement provider) merges per
        the runtime's precedence (default: app wins). The browser SDK runs
        the same function on the same inputs, so the server verifies
        exactly what the browser showed. An entitlement nobody knows is
        denied, warned and reported.

        Source: local-runtime.ts (checkEntitlement)
        """
        providers = self.engine.resolve_providers()
        app = self._app_inputs_by_handle(providers).get(handle)
        effective = derive_effective_entitlement(
            **self._effective_base(providers, context),
            handle=handle,
            app=app,
        )
        if effective["unknown_handle"]:
            self._report_unknown_entitlement(handle)
        return effective["result"]

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
        assignments: dict[str, str] | None = None,
    ) -> list[str]:
        """Evaluate segments for a set of user traits.

        Ported in plan 233: segment targeting is a decision input in every
        runtime now, so a headless SDK that could not derive membership could
        not make the same selection the browser SDK does. Parity is asserted
        byte-for-byte by tests/parity.

        Source: local-runtime.ts:249-257
        """
        segments = self._playbook.get("segments") or []
        return evaluate_segments(segments, traits, assignments)

    # ── Targeting state (deferred — REQ-14 non-goal) ──────────────────────

    def build_targeting_state(
        self,
        context: dict[str, Any],
        usage_overrides: dict[str, float] | None = None,
    ) -> dict[str, Any]:
        """Build the full targeting state from a user context snapshot.

        Delegates to the pure ``core.user_context.build_targeting_state``
        (plan 234 TASK-8b - the REQ-14 deferral is closed; segment parity
        upgrades from "agrees given the same traits" to "agrees given the
        same user context").

        Source: local-runtime.ts (buildTargetingState)
        """
        return _build_targeting_state(context, self.get_playbook(), usage_overrides)

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

    def get_playbook(self) -> Playbook:
        """Return the active Playbook snapshot.

        Source: local-runtime.ts:312-315
        """
        return self._playbook

    def get_exported_config(self) -> Playbook:
        """Deprecated alias of :meth:`get_playbook` (BL-0156).

        ``ExportedConfig`` is dead vocabulary. Identical behaviour; removed in
        ``0.12.0``.
        """
        warn_deprecated_playbook_alias_once(
            "`LocalRuntime.get_exported_config()` is deprecated; use `get_playbook()`."
        )
        return self.get_playbook()

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

    def _slot_record_for_config(
        self,
        config: dict[str, Any],
    ) -> PlacementRecord | None:
        """Resolve the placement record for a surface-keyed request. Prefers
        a slot already registered by the caller; otherwise derives it from
        the config's ``placement_slots`` registry — the headless server/CLI
        path, where there is no mounted ``<Slot>`` to self-register. Returns
        ``None`` when no slot matches the config.

        The derived record carries the metadata the resolver's slot branch
        reads: ``surface_template_ids`` (from the slot's ``template``) drives
        candidate gathering; ``surface_slot_id`` / ``entitlement_handle`` /
        ``fixed_only`` narrow it. Metadata keys are snake_case to match the
        resolver's ``meta.get(...)`` reads — the TS record's one camelCase
        key (``fixedOnly``) is ``fixed_only`` here.

        Source: local-runtime.ts:375-416
        """
        slot_id = config.get("slot_id")
        if slot_id:
            existing = self._registered_placements.get(slot_id)
            if existing is not None:
                return existing

        component_type = resolve_placement_component_type(config)
        slots = self._playbook.get("placement_slots") or []

        def _matches(s: dict[str, Any]) -> bool:
            if slot_id:
                return bool(s.get("id") == slot_id)
            if component_type:
                return bool(s.get("surface_type") == component_type)
            return False

        slot = next((s for s in slots if _matches(s)), None)
        if slot is None:
            return None

        template = slot.get("template")
        metadata: dict[str, Any] = {
            "surface_slot_id": slot["id"],
            "surface_type": slot["surface_type"],
            "surface_template_ids": [template] if template else [],
        }
        entitlement_handle = config.get("entitlement_handle")
        if entitlement_handle:
            metadata["entitlement_handle"] = entitlement_handle
        if config.get("fixed_only"):
            metadata["fixed_only"] = True

        placement_handle = config.get("placement_handle")
        name = placement_handle if placement_handle is not None else slot.get("placement_handle")
        record: PlacementRecord = {
            "placement_id": slot["id"],
            "name": name,
            "route": "",
            "metadata": metadata,
        }
        return record

    def _build_placement_resolver(
        self,
        placements: LocalPlacementDataset | None,
        playbook: Playbook,
    ) -> PlacementResolver:
        """Build the static placement resolver from the dataset, falling
        back to ``playbook.placements``.

        D-61: the resolver's gates read the SAME effective entitlements that
        :meth:`check_entitlement` returns, not the providers' raw entries.

        Source: local-runtime.ts (buildPlacementResolver)
        """
        dataset: LocalPlacementDataset = (
            placements
            if placements is not None
            else {"placements": playbook.get("placements") or []}
        )
        resolve = create_static_placement_resolver(
            placements=dataset,
            playbook=playbook,
            impression_history=self.impression_history,
        )

        def _resolve_with_effective_entitlements(
            input_data: PlacementDecisionInput,
            placement: PlacementRecord | None,
            context: dict[str, Any],
        ) -> PlacementDecision:
            raw_providers = context.get("__providers")
            providers: ResolvedProviderContext = (
                raw_providers if isinstance(raw_providers, dict) else {}  # type: ignore[assignment]
            )
            entries = derive_effective_entitlements(
                self._effective_base(providers, None),
                self._app_inputs_by_handle(providers),
            )
            entitlements: dict[str, Any] = {
                **(providers.get("entitlements") or {}),
                "entries": entries,
            }
            # TS writes `origin: undefined`: the effective map is no longer a
            # blanket default, so the marker does not travel with it.
            entitlements.pop("origin", None)
            return resolve(
                input_data,
                placement,
                {**context, "__providers": {**providers, "entitlements": entitlements}},
            )

        return _resolve_with_effective_entitlements

    def _effective_base(
        self,
        providers: ResolvedProviderContext,
        context: dict[str, Any] | None,
    ) -> EffectiveEntitlementBase:
        """Evaluator inputs from the resolved providers — the same facts the
        browser SDK uses.

        Source: local-runtime.ts (effectiveBase)
        """
        usage_balances: dict[str, float] = {}
        entitlements_state = providers.get("entitlements")
        raw_usage: Mapping[str, Any] = (
            (entitlements_state.get("usage") or {}) if entitlements_state is not None else {}
        )
        for usage_handle, entry in raw_usage.items():
            used = entry.get("used") if isinstance(entry, dict) else None
            # `Number.isFinite(entry.used)`: a real, finite number — never a bool.
            if isinstance(used, bool) or not isinstance(used, (int, float)):
                continue
            if math.isfinite(used):
                usage_balances[usage_handle] = used
        segments = providers.get("segments")
        segment_ids: set[str] = set()
        if segments is not None:
            segment_ids.update(segments.get("segment_slugs") or [])
            segment_ids.update(segments.get("segment_ids") or [])
        plan = providers.get("plan")
        raw_plan_handle = plan.get("current_plan_handle") if plan is not None else None
        # `String(providers.plan?.currentPlanHandle ?? '').toLowerCase()`
        plan_handle = "" if raw_plan_handle is None else str(raw_plan_handle)
        base: EffectiveEntitlementBase = {
            "context": context,
            "current_plan_handle": plan_handle.lower(),
            "segment_ids": segment_ids,
            "usage_balances": usage_balances,
            "playbook": self._playbook,
        }
        grants = reverse_trial_grants(self._playbook, self._trial_status)
        if "trial_granted_entitlement_handles" in grants:
            base["trial_granted_entitlement_handles"] = grants["trial_granted_entitlement_handles"]
        if "effective_plan_handle" in grants:
            base["effective_plan_handle"] = grants["effective_plan_handle"]
        if self._entitlement_merge:
            base["merge"] = self._entitlement_merge
        return base

    def _app_inputs_by_handle(
        self,
        providers: ResolvedProviderContext,
    ) -> dict[str, AppEntitlementInputs]:
        """App-mirrored data per handle: user-context grants plus
        non-default provider entries.

        Source: local-runtime.ts (appInputsByHandle)
        """
        out: dict[str, AppEntitlementInputs] = {}
        for grant_handle, grant in self._user_entitlements.items():
            out[grant_handle] = {"user_context": grant}
        state = providers.get("entitlements")
        if state is not None and state.get("origin") != "playbook_default":
            for entry_handle, entry in (state.get("entries") or {}).items():
                merged: AppEntitlementInputs = {**out.get(entry_handle, {}), "provider": entry}
                out[entry_handle] = merged
        return out

    def _report_unknown_entitlement(self, handle: str) -> None:
        """Warn once per handle and hand it to ``on_unknown_entitlement``.

        Source: local-runtime.ts (reportUnknownEntitlement)
        """
        if handle in self._reported_unknown_entitlements:
            return
        self._reported_unknown_entitlements.add(handle)
        warnings.warn(
            f'[revturbine] entitlement "{handle}" is not in the Playbook and no app data '
            "was supplied for it; denying (entitlement_not_in_playbook).",
            RuntimeWarning,
            stacklevel=3,
        )
        if self._on_unknown_entitlement is not None:
            self._on_unknown_entitlement(handle)
