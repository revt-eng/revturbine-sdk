"""RevTurbineCustomerSdk — the public headless server SDK class.

Plan 33 TASK-7, narrowed per the 2026-05-16 scope decision: a thin,
**stateless, in-memory** wrapper over the cross-language-parity-locked
decision substrate. Constructed from exactly a *user context* + an
*ExportedConfig* (both supplied by the caller — the server holds them;
the SDK fetches/persists nothing), it exposes the two server-side
decision capabilities:

- ``check_entitlement`` — is a feature/limit allowed for this user?
- ``get_placement_decision`` / ``get_placement_decisions`` — which
  placement payload (if any) should this user see?

It composes the already-shipped, parity-locked pieces —
``create_static_providers`` (TASK-7-b1) → ``LocalRuntime`` (TASK-6) →
the §2.6.5 most-permissive ExportedConfig-rule entitlement evaluator
(TASK-13) — adding **zero** decision logic of its own. Every method is
a pure delegation, so this class's output is byte-identical to
``LocalRuntime``'s and the cross-language parity gate (which drives
this public class, per ``tests/parity/py_runner.py``) stays green by
construction.

Out of scope — the browser ``customer-side.ts`` bespoke decision engine
(plan 33 REQ-14 non-goals; intentionally absent from the headless
*server* library): ``identify``, ``dismiss`` / ``snooze`` /
``convert``, ``track_treatment_interaction``, ``get_trial_status``,
``capture``, ``bootstrap_placement_decisions``, ``get_user_context``,
decision-cache / interaction-state hydration, the HTTP-backed dual-mode
dispatch, and segment / targeting / personalization-token derivation.
The legacy thin-RPC HTTP client at ``revturbine_server`` stays
independently importable and unchanged — it is composable with this
class, not folded into it (the original plan's ``runtime_mode``
dual-mode framing is superseded by the headless-server scope decision).

No persistence beyond memory: ``LocalRuntime`` defaults to
``InMemoryStorage`` / ``InMemoryImpressionStore`` and this class never
injects file-backed storage nor calls ``hydrate()`` — there is
deliberately no storage injection point on the constructor.

Source (canonical, parity-locked): the headless decision surface of
revturbine-scaffold/src/core/runtime/local-runtime.ts, composed exactly
as tests/parity/{ts_runner.ts,py_runner.py} compose it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, TypedDict

from revturbine.config import ConfigArtifact, parse_playbook_or_throw
from revturbine.core.adapters import create_static_providers
from revturbine.core.decisions import (
    EntitlementCheckResult,
    PlacementDecision,
    PlacementDecisionInput,
)
from revturbine.core.providers.types import DomainProvider, DomainProviderName
from revturbine.core.runtime import LocalRuntime
from revturbine.core.trials import evaluate_trial_status as _evaluate_trial_status

__all__ = ["RevTurbineCustomerSdk", "UserContext"]


class _UserContextRequired(TypedDict):
    """Identity required for every decision."""

    tenant_id: str
    user_id: str


class UserContext(_UserContextRequired, total=False):
    """The server-supplied user context.

    Mirrors the parity corpus' ``userContext`` (the headless model:
    plan + usage are supplied at construction, never fetched).

    Required: ``tenant_id``, ``user_id``. Optional:

    - ``plan_handle`` / ``plan_name`` — the user's current plan; feeds
      ``create_static_providers`` (the plan + entitlements providers).
    - ``usage`` — per-entitlement ``{used, limit}`` overrides.
    - ``trial_status`` — already-derived trial state (plan 43 TASK-12).
      The dict mirrors ``UserTrialStatus``: ``in_trial`` /
      ``trial_limit_type`` / ``progress_percent`` / ``state`` /
      ``days_remaining`` / ``day_number`` / ``usage_*``. When present,
      the SDK overlays the corresponding PlanProvider trial fields so
      trial-trigger placements (``trial_progress`` / ``trial_ending``
      / ``trial_ended`` / ``trial_converted``) and milestone
      supersession evaluate correctly.

    Segment-targeted entitlement rules are matched against pre-resolved
    segment ids *inside* the parity-locked evaluator; the headless
    server SDK does not derive segments from raw traits (that is the
    browser/segments machinery — a REQ-14 non-goal; see the module
    docstring).
    """

    plan_handle: str | None
    plan_name: str | None
    usage: dict[str, dict[str, float]] | None
    trial_status: dict[str, Any] | None
    # Billing-recovery signals for the Retention qualifier triggers (§3.7).
    payment_failed: bool | None
    payment_at_risk: bool | None
    # Current tier per capability_tier entitlement handle, for the
    # entitlement_gate.tier_threshold gate (plan 138 TASK-4).
    tiers: dict[str, str] | None


class RevTurbineCustomerSdk:
    """Public, stateless, in-memory headless server SDK.

    Construct once per ``(user_context, exported_config)``, then call
    :meth:`check_entitlement` / :meth:`get_placement_decision` /
    :meth:`get_placement_decisions`. The instance carries no cross-user
    state — construct a fresh one per user context.

    Source: composes ``create_static_providers`` + ``LocalRuntime``
    exactly as the parity runners do (``tests/parity/py_runner.py``);
    every public method is a pure pass-through, so a byte-diff of this
    class's output against the TS ``LocalRuntime`` is a true
    cross-language equivalence check.
    """

    def __init__(
        self,
        *,
        user_context: UserContext,
        exported_config: ConfigArtifact,
    ) -> None:
        """Compose the parity-locked substrate for one user context.

        Raises ``ValueError`` if ``tenant_id`` / ``user_id`` are absent
        or empty (the only required identity). Storage defaults to
        in-memory — there is intentionally no persistence injection
        point.

        Source: local-runtime.ts constructor, via create_static_providers.
        """
        tenant_id = user_context.get("tenant_id") or ""
        user_id = user_context.get("user_id") or ""
        if not tenant_id or not user_id:
            raise ValueError("user_context requires non-empty 'tenant_id' and 'user_id'")

        playbook = parse_playbook_or_throw(
            exported_config,
            "exported_config",
            {
                "tenant_id": tenant_id,
                "environment_id": "default",
            },
        )
        if playbook is None:
            raise ValueError("exported_config is required")

        # Trial-rule arrays for config-driven trial evaluation
        # (:meth:`evaluate_trial_status`). The Playbook carries them as
        # plain dict records; the derivation reads them by field.
        self._free_trial_rules: list[Any] = playbook.get("free_trial_rules") or []
        self._reverse_trial_rules: list[Any] = playbook.get("reverse_trial_rules") or []

        providers = create_static_providers(
            config=playbook,
            plan_handle=user_context.get("plan_handle"),
            plan_name=user_context.get("plan_name"),
            usage=user_context.get("usage"),
            payment_failed=user_context.get("payment_failed"),
            payment_at_risk=user_context.get("payment_at_risk"),
            tiers=user_context.get("tiers"),
        )

        # Plan 43 TASK-12 — overlay PlanProvider trial fields when
        # ``trial_status`` is supplied. Mirrors the TS parity runner's
        # overlay so trial-trigger placements (``trial_progress`` /
        # ``trial_ending`` / etc.) and milestone supersession evaluate
        # against the server-derived trial state. Without this, the
        # PlanProviderState carries no trial fields and trial-trigger
        # gating returns ``False`` for every trial-categorized placement.
        trial_status = user_context.get("trial_status")
        if isinstance(trial_status, dict):
            providers = _overlay_trial_status_on_plan_provider(providers, trial_status)

        # InMemoryStorage / InMemoryImpressionStore by default — no
        # persistence beyond memory (the narrowed-scope contract).
        self._runtime = LocalRuntime(
            tenant_id=tenant_id,
            user_id=user_id,
            exported_config=playbook,
            providers=providers,
        )

    def check_entitlement(
        self,
        handle: str,
        context: dict[str, Any] | None = None,
    ) -> EntitlementCheckResult:
        """Resolve an entitlement for the constructed user.

        Pure delegation to the parity-locked
        ``LocalRuntime.check_entitlement`` — engine/provider path first,
        then the §2.6.5 most-permissive ExportedConfig-rule fallback.

        Source: local-runtime.ts checkEntitlement (parity-locked).
        """
        return self._runtime.check_entitlement(handle, context)

    def get_placement_decision(
        self,
        input_data: PlacementDecisionInput,
    ) -> PlacementDecision:
        """Decide a single placement (visibility + resolved payload).

        Pure delegation to ``LocalRuntime.get_placement_decision``.

        Source: local-runtime.ts getPlacementDecision (parity-locked).
        """
        return self._runtime.get_placement_decision(input_data)

    def get_placement_decisions(
        self,
        inputs: list[PlacementDecisionInput],
    ) -> list[PlacementDecision]:
        """Decide multiple placements, order-preserving.

        The batch form of :meth:`get_placement_decision` — the same
        decision path ("getting placement decisions" in the server
        surface). Pure delegation to
        ``LocalRuntime.get_placement_decisions``.

        Source: local-runtime.ts getPlacementDecisions (parity-locked).
        """
        return self._runtime.get_placement_decisions(inputs)

    def evaluate_trial_status(
        self,
        *,
        instances: Sequence[Mapping[str, Any]],
        now_iso: str,
        base_plan_handle: str | None = None,
        usage_balances: Mapping[str, float] | None = None,
    ) -> dict[str, Any]:
        """Evaluate this tenant's ``free_trial_rules`` /
        ``reverse_trial_rules`` against a customer's trial instances →
        the runtime ``UserTrialStatus``.

        Reads the trial-rule arrays from the exported config this SDK was
        constructed with, resolves the matching rule for the active
        trial instance, and derives the status. Returns
        ``{"trial": <UserTrialStatus dict> | None, "reverse_grants": ...}``.

        Pure + deterministic (caller supplies ``now_iso``); the same
        evaluator runs in the TS core (``@revt-eng/core``'s
        ``evaluateTrialStatus``), so both decide identically.

        Source: trial-status.ts evaluateTrialStatus (parity-locked).
        """
        return _evaluate_trial_status(
            instances=instances,
            now_iso=now_iso,
            free_trial_rules=self._free_trial_rules,
            reverse_trial_rules=self._reverse_trial_rules,
            base_plan_handle=base_plan_handle,
            usage_balances=usage_balances,
        )


# ── Trial-status PlanProvider overlay (plan 43 TASK-12) ────────────────────


class _TrialOverlayPlanProvider:
    """Wraps the static PlanProvider, merging the customer-supplied
    ``trial_status`` onto the resolved PlanProviderState. The trial
    fields drive the placement resolver's ``trial_progress`` /
    ``trial_ending`` / ``trial_ended`` / ``trial_converted`` gating
    plus milestone supersession (see ``trial_gating.py``).

    Mirrors the field-by-field mapping in the TS SDK's
    ``synthesizeProviderContext`` and the parity TS runner's overlay
    helper — keep these aligned when either side adds a field.

    Source: web-sdk/customer-side.ts:1582 (TS reference).
    """

    def __init__(self, base: DomainProvider, trial_status: dict[str, Any]) -> None:
        self._base = base
        self._trial_status = trial_status

    @property
    def domain(self) -> DomainProviderName:
        return self._base.domain

    @property
    def cache_ttl_ms(self) -> int | None:
        return getattr(self._base, "cache_ttl_ms", None)

    def resolve(self) -> Any:
        base_state = self._base.resolve()
        merged: dict[str, Any] = {**base_state} if isinstance(base_state, dict) else {}
        ts = self._trial_status

        in_trial = ts.get("in_trial")
        if in_trial is not None:
            merged["trial_active"] = bool(in_trial)
        limit_type = ts.get("trial_limit_type")
        if limit_type is not None:
            merged["trial_limit_type"] = limit_type
        progress = ts.get("progress_percent")
        if progress is not None:
            merged["trial_progress_percent"] = float(progress)
        days_remaining = ts.get("days_remaining")
        if days_remaining is not None:
            merged["trial_days_remaining"] = float(days_remaining)
        day_number = ts.get("day_number")
        if day_number is not None and days_remaining is not None:
            merged["trial_days_total"] = float(day_number) + float(days_remaining)
        state = ts.get("state")
        if state is not None:
            merged["trial_state"] = state
        usage_entitlement = ts.get("usage_entitlement_handle")
        if usage_entitlement is not None:
            merged["trial_usage_entitlement_handle"] = usage_entitlement
        usage_consumed = ts.get("usage_consumed")
        if usage_consumed is not None:
            merged["trial_usage_consumed"] = float(usage_consumed)
        usage_limit = ts.get("usage_limit")
        if usage_limit is not None:
            merged["trial_usage_limit"] = float(usage_limit)

        return merged


def _overlay_trial_status_on_plan_provider(
    providers: list[DomainProvider],
    trial_status: dict[str, Any],
) -> list[DomainProvider]:
    """Replace the plan provider in ``providers`` with a wrapper that
    overlays ``trial_status`` fields onto the resolved PlanProviderState.

    Pure (returns a new list); no in-place mutation. Non-plan providers
    are passed through untouched. If no plan provider is present (an
    edge case), the input list is returned unchanged — the resolver
    handles missing plan state gracefully.
    """
    return [
        _TrialOverlayPlanProvider(p, trial_status) if p.domain == "plan" else p for p in providers
    ]
