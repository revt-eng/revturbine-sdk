"""revturbine.core.decisions — Python port of @revt-eng/core/decisions.

The decision pipeline orchestrator. ``DecisionEngine`` wires together
the provider registry, interaction tracker, cap enforcer, and an
optional placement resolver to produce per-placement and
per-entitlement decisions. Sync per Q-5 of plan 33.

Batch 1 of TASK-5 ports the engine and entitlement-check path. The
``placement_resolver`` argument is callable but unwired by default —
calling ``evaluate()`` without one returns the
``no_resolver_configured`` invisible fallback. The actual resolver
implementation (placement-decision.ts + local-resolver.ts +
payload-resolution.ts, ~1700 LOC) lands in batch 2.
"""

from revturbine.core.decisions.engine import DecisionEngine
from revturbine.core.decisions.types import (
    DecisionContent,
    DecisionEngineOptions,
    EntitlementCheckResult,
    EvaluationContext,
    PlacementDecision,
    PlacementDecisionInput,
    PlacementRecord,
    PlacementResolver,
)

__all__ = [
    "DecisionContent",
    "DecisionEngine",
    "DecisionEngineOptions",
    "EntitlementCheckResult",
    "EvaluationContext",
    "PlacementDecision",
    "PlacementDecisionInput",
    "PlacementRecord",
    "PlacementResolver",
]
