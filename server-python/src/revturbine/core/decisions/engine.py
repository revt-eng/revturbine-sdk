"""DecisionEngine — Python port of @revt-eng/core/decisions/controllers/engine.ts.

Runs the full decision pipeline:

1. Check dismissal suppression (InteractionTracker)
2. Resolve domain providers (DomainProviderRegistry)
3. Build evaluation context
4. Run the placement resolver (when configured)
5. Enforce presentation caps on visible decisions (CapEnforcer)

Sync per Q-5 of plan 33; async-aware variants are a TASK-7 concern.

Source: revturbine-scaffold/src/decisions/controllers/engine.ts
"""

from __future__ import annotations

import time
from typing import Any

from revturbine.core.decisions.types import (
    DecisionContent,
    DecisionEngineOptions,
    EntitlementCheckResult,
    PlacementDecision,
    PlacementDecisionInput,
    PlacementRecord,
    PlacementResolver,
)
from revturbine.core.entitlements.entitlement_check import (
    derive_result_from_rule_type_fields,
    is_rule_shaped_kind,
)
from revturbine.core.entitlements.rules import RuleEvaluationContext, find_matching_entitlement_rule
from revturbine.core.providers.registry import DomainProviderRegistry
from revturbine.core.providers.types import ResolvedProviderContext
from revturbine.core.state.cap_enforcer import CapEnforcer
from revturbine.core.state.interaction_tracker import InteractionTracker
from revturbine.core.state.types import RevTurbineTreatmentInteractionInput

__all__ = ["DecisionEngine"]

_request_counter = 0


def _request_id() -> str:
    """Mirror TS's ``core_${Date.now()}_${++requestCounter}`` shape.

    The counter is module-scoped (matches TS's file-scoped ``let``).
    Tests that need a deterministic id can monkeypatch this module's
    ``_request_counter`` and ``time.time``.

    Source: engine.ts:32-35
    """
    global _request_counter
    _request_counter += 1
    return f"core_{int(time.time() * 1000)}_{_request_counter}"


def _decision_content(header: str, body: str, cta_label: str) -> DecisionContent:
    """TS emits both legacy (``header``/``cta_label``) and canonical
    (``title``/``cta``) field names in synthetic fallback content.

    Source: engine.ts:37-39
    """
    return DecisionContent(
        header=header,
        body=body,
        cta_label=cta_label,
        title=header,
        cta=cta_label,
    )


class DecisionEngine:
    """Isomorphic placement-decision pipeline.

    Source: engine.ts:56-230
    """

    def __init__(
        self,
        *,
        registry: DomainProviderRegistry,
        interaction_tracker: InteractionTracker | None = None,
        cap_enforcer: CapEnforcer | None = None,
        options: DecisionEngineOptions | None = None,
        placements: dict[str, PlacementRecord] | None = None,
        placement_resolver: PlacementResolver | None = None,
    ) -> None:
        self._registry = registry
        self._interaction_tracker = interaction_tracker
        self._cap_enforcer = cap_enforcer
        self._options: DecisionEngineOptions = options if options is not None else {}
        self._placements: dict[str, PlacementRecord] = placements if placements is not None else {}
        self._placement_resolver = placement_resolver

    # ── Public API ─────────────────────────────────────────────────────────

    def evaluate(self, input_data: PlacementDecisionInput) -> PlacementDecision:
        """Evaluate a single placement decision.

        Source: engine.ts:79-147
        """
        rid = _request_id()
        placement = self._placements.get(input_data["placement_id"])

        # 1. Dismissal / interaction suppression
        if self._interaction_tracker is not None:
            suppression = self._interaction_tracker.check_suppression(
                input_data["placement_id"],
                input_data["user_id"],
            )
            if suppression["suppressed"]:
                reason = suppression.get("reason")
                fallback_name = placement["name"] if placement else input_data["placement_id"]
                decision: PlacementDecision = PlacementDecision(
                    placement_id=input_data["placement_id"],
                    request_id=rid,
                    visible=False,
                    decision_source="cache",
                    reason_codes=[reason] if reason else [],
                    content=_decision_content(
                        f"{fallback_name} suppressed",
                        "Suppressed due to recent interaction state.",
                        "Continue",
                    ),
                )
                if reason:
                    decision["suppression_reason"] = reason
                return decision

        # 2. Resolve providers
        providers = self._registry.resolve_all()

        # 3. Build context for the resolver
        context: dict[str, Any] = {"__providers": providers}
        if "traits" in input_data:
            context["traits"] = input_data["traits"]

        # 4. Run resolver if available
        if self._placement_resolver is not None:
            decision = self._placement_resolver(input_data, placement, context)
            # 5. Cap enforcement on visible decisions (default-on; opt-out via
            #    options.enable_caps_enforcement = False).
            enable_caps = self._options.get("enable_caps_enforcement", True)
            if (
                decision["visible"]
                and "output" in decision
                and self._cap_enforcer is not None
                and enable_caps is not False
            ):
                cap_result = self._cap_enforcer.enforce(decision["output"])
                if not cap_result["allowed"]:
                    cap_reason = cap_result.get("reason", "suppressed_by_cap")
                    decision["visible"] = False
                    decision["reason_codes"] = [*decision["reason_codes"], cap_reason]
                    decision["suppression_reason"] = cap_reason
                    return decision
            return decision

        # No resolver — invisible fallback. Mirrors the TS branch.
        return PlacementDecision(
            placement_id=input_data["placement_id"],
            request_id=rid,
            visible=False,
            decision_source="fallback",
            reason_codes=["no_resolver_configured"],
            content=_decision_content(
                "No resolver",
                "No placement resolver configured.",
                "",
            ),
        )

    def evaluate_batch(
        self,
        inputs: list[PlacementDecisionInput],
    ) -> list[PlacementDecision]:
        """Evaluate a batch of placement decisions sequentially.

        TS uses ``Promise.all`` over an async map; the Python port is
        sync per Q-5, so the calls run sequentially. An ``aevaluate_batch``
        async variant could land in TASK-7.

        Source: engine.ts:152-154
        """
        return [self.evaluate(input_data) for input_data in inputs]

    def check_entitlement(
        self,
        handle: str,
        context: dict[str, Any] | None = None,
    ) -> EntitlementCheckResult:
        """Check entitlement access for a given handle.

        Walks the resolved provider context's ``entitlements`` slot (or
        falls back to the configured default policy when no provider is
        registered or the handle is unknown). When usage context
        (``context["used"]``) is provided alongside a ``usage`` entry,
        the limit is enforced and the result is enriched with
        limit/used/remaining fields.

        Source: engine.ts:162-229
        """
        providers = self._registry.resolve_all()
        return self._derive_entitlement_result(handle, providers, context)

    def track_interaction(self, input_data: RevTurbineTreatmentInteractionInput) -> None:
        """Delegate to the configured ``InteractionTracker``.

        Source: engine.ts:173-175
        """
        if self._interaction_tracker is not None:
            self._interaction_tracker.track(input_data)

    def resolve_providers(self) -> ResolvedProviderContext:
        """Convenience accessor for the merged provider context.

        Source: engine.ts:180-182
        """
        return self._registry.resolve_all()

    # ── Internal ───────────────────────────────────────────────────────────

    def _derive_entitlement_result(
        self,
        handle: str,
        providers: ResolvedProviderContext,
        context: dict[str, Any] | None,
    ) -> EntitlementCheckResult:
        """Source: engine.ts:186-229"""
        policy = self._options.get("default_entitlement_policy", "allow")

        entitlements = providers.get("entitlements")
        if entitlements is None:
            return self._policy_default(
                policy,
                allowed_reason="no_entitlement_provider",
                denied_reason="no_entitlement_provider_default_deny",
            )

        entry = entitlements.get("entries", {}).get(handle)
        if entry is None:
            return self._policy_default(
                policy,
                allowed_reason="entitlement_not_found_default_allow",
                denied_reason="entitlement_not_found_default_deny",
            )

        usage = (entitlements.get("usage") or {}).get(handle)

        # Plan 133: a configured entitlement rule is authoritative over the
        # provider entry's default-policy status. Consult the rules provider
        # with the single-sourced §2.6.5 matcher; a matched rule's
        # `type_fields` shape the result (kind semantics + limit/used/
        # remaining) via the same shaper the ExportedConfig evaluator uses.
        rules = providers.get("rules")
        if rules is not None:
            plan = providers.get("plan")
            segments = providers.get("segments")
            rule_context: RuleEvaluationContext = {
                "segment_ids": list(segments["segment_ids"]) if segments is not None else [],
            }
            plan_handle = plan.get("current_plan_handle") if plan is not None else None
            if plan_handle is not None:
                rule_context["current_plan_handle"] = plan_handle
            billing_period = plan.get("billing_period") if plan is not None else None
            if billing_period is not None:
                rule_context["billing_period"] = billing_period
            matched = find_matching_entitlement_rule(rules, handle, rule_context)
            if matched is not None:
                # Snapshot `kind` seeds the shaper for providers whose
                # `fields` omit it; a `fields.kind` wins via merge order —
                # the two agree wherever both exist.
                type_fields: dict[str, Any] = {"kind": matched["kind"]}
                type_fields.update(matched.get("fields") or {})
                if is_rule_shaped_kind(type_fields.get("kind")):
                    ctx_used = context.get("used") if context is not None else None
                    if ctx_used is None and usage is not None:
                        ctx_used = usage.get("used")
                    return derive_result_from_rule_type_fields(
                        type_fields,
                        float(ctx_used) if ctx_used is not None else 0.0,
                    )
                # A matched rule of a kind the shaper doesn't model (e.g.
                # legacy 'metered') proves the plan assignment exists — fall
                # through to the provider entry/usage logic below.
            else:
                # Kent's 2026-07-13 ruling (supersedes the initial plan-133
                # fail-open stance): a CONFIGURED entitlement with no rule
                # assigning it to the user's plan is DENIED — aligned with
                # the ExportedConfig evaluator's plan-#39 posture and reason
                # string. Unknown handles (no entry, handled above) and
                # engines without a rules provider keep the default-policy
                # behavior.
                return EntitlementCheckResult(
                    status="denied",
                    allowed=False,
                    reason="no_matching_entitlement_rule",
                )

        if usage is not None and context is not None and "used" in context:
            used = context["used"]
            limit = usage.get("limit", 0)
            if limit > 0 and used >= limit:
                return EntitlementCheckResult(
                    status="denied",
                    allowed=False,
                    reason="usage_limit_exceeded",
                    limit=limit,
                    used=used,
                    remaining=max(0, limit - used),
                )

        result: EntitlementCheckResult = EntitlementCheckResult(
            status=entry["status"],
            allowed=entry["status"] == "allowed",
        )
        entry_reason = entry.get("reason")
        if entry_reason is not None:
            result["reason"] = entry_reason
        if usage is not None:
            if "limit" in usage:
                result["limit"] = usage["limit"]
            if "used" in usage:
                result["used"] = usage["used"]
            if "remaining" in usage:
                result["remaining"] = usage["remaining"]
        return result

    @staticmethod
    def _policy_default(
        policy: str,
        *,
        allowed_reason: str,
        denied_reason: str,
    ) -> EntitlementCheckResult:
        if policy == "allow":
            return EntitlementCheckResult(status="allowed", allowed=True, reason=allowed_reason)
        return EntitlementCheckResult(status="denied", allowed=False, reason=denied_reason)
