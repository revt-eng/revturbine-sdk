"""TASK-5 batch-1 pilot corpus — 10 hand-curated fixtures asserting that
``DecisionEngine.check_entitlement`` produces TS-equivalent output.

Scope of the pilot: entitlement-check parity only. Placement-decision
parity ships with batch 2 of TASK-5 once the placement resolver lands.

Each fixture is a hand-derived expected output, traced from a careful
read of ``revturbine-scaffold/src/decisions/controllers/engine.ts``
(specifically ``deriveEntitlementResult``, lines 186-229). The full
shared-corpus + cross-language diff orchestrator is TASK-8/9/10.
"""

from __future__ import annotations

from typing import Any

import pytest

from revturbine.core.decisions import DecisionEngine
from revturbine.core.decisions.types import DecisionEngineOptions, EntitlementCheckResult
from revturbine.core.providers.registry import DomainProviderRegistry


class _Provider:
    def __init__(self, *, domain: str, value: Any) -> None:
        self.domain = domain
        self._value = value

    def resolve(self) -> Any:
        return self._value


def _engine(
    *,
    entitlement_state: dict[str, Any] | None = None,
    options: DecisionEngineOptions | None = None,
) -> DecisionEngine:
    reg = DomainProviderRegistry()
    if entitlement_state is not None:
        reg.register(_Provider(domain="entitlements", value=entitlement_state))
    return DecisionEngine(registry=reg, options=options)


# Each tuple: (label, engine_factory, handle, context, expected_result).
# The fixture id is also the parametrize id so a failure surfaces with
# the human-readable scenario name.
_FIXTURES: list[
    tuple[
        str,
        dict[str, Any] | None,  # entitlement provider state, or None
        DecisionEngineOptions | None,  # engine options
        str,  # handle
        dict[str, Any] | None,  # context
        EntitlementCheckResult,  # expected
    ]
] = [
    # 1 — Allowed, no usage → bare {status, allowed}.
    (
        "allowed_no_usage",
        {"entries": {"feat": {"status": "allowed", "allowed": True}}},
        None,
        "feat",
        None,
        {"status": "allowed", "allowed": True},
    ),
    # 2 — Denied with reason carried through.
    (
        "denied_with_reason",
        {
            "entries": {
                "feat": {"status": "denied", "allowed": False, "reason": "plan_too_low"},
            },
        },
        None,
        "feat",
        None,
        {"status": "denied", "allowed": False, "reason": "plan_too_low"},
    ),
    # 3 — `limited` status passes through verbatim.
    (
        "limited_passes_through",
        {"entries": {"feat": {"status": "limited", "allowed": False}}},
        None,
        "feat",
        None,
        {"status": "limited", "allowed": False},
    ),
    # 4 — No entitlement provider + default policy 'allow' (the default).
    (
        "no_provider_default_allow",
        None,
        None,
        "feat",
        None,
        {
            "status": "allowed",
            "allowed": True,
            "reason": "no_entitlement_provider",
        },
    ),
    # 5 — No entitlement provider + explicit deny policy.
    (
        "no_provider_default_deny",
        None,
        {"default_entitlement_policy": "deny"},
        "feat",
        None,
        {
            "status": "denied",
            "allowed": False,
            "reason": "no_entitlement_provider_default_deny",
        },
    ),
    # 6 — Provider exists but handle missing + default 'allow'.
    (
        "handle_not_found_default_allow",
        {"entries": {}},
        None,
        "missing",
        None,
        {
            "status": "allowed",
            "allowed": True,
            "reason": "entitlement_not_found_default_allow",
        },
    ),
    # 7 — Provider exists but handle missing + default 'deny'.
    (
        "handle_not_found_default_deny",
        {"entries": {}},
        {"default_entitlement_policy": "deny"},
        "missing",
        None,
        {
            "status": "denied",
            "allowed": False,
            "reason": "entitlement_not_found_default_deny",
        },
    ),
    # 8 — Usage limit exceeded short-circuits with usage_limit_exceeded
    # and the limit/used/remaining triple.
    (
        "usage_limit_exceeded",
        {
            "entries": {"feat": {"status": "allowed", "allowed": True}},
            "usage": {"feat": {"used": 100, "limit": 100, "remaining": 0}},
        },
        None,
        "feat",
        {"used": 100},
        {
            "status": "denied",
            "allowed": False,
            "reason": "usage_limit_exceeded",
            "limit": 100,
            "used": 100,
            "remaining": 0,
        },
    ),
    # 9 — Usage below limit returns the entry's status enriched with the
    # full usage triple (matches the TS reads of usage?.{limit,used,remaining}).
    (
        "usage_below_limit_enriches",
        {
            "entries": {"feat": {"status": "allowed", "allowed": True}},
            "usage": {"feat": {"used": 30, "limit": 100, "remaining": 70}},
        },
        None,
        "feat",
        {"used": 30},
        {
            "status": "allowed",
            "allowed": True,
            "limit": 100,
            "used": 30,
            "remaining": 70,
        },
    ),
    # 10 — limit == 0 means "no limit" per TS (`if (usage.limit > 0 && ...)`).
    # Heavy `used` doesn't trigger the usage_limit_exceeded branch.
    (
        "usage_limit_zero_skips_enforcement",
        {
            "entries": {"feat": {"status": "allowed", "allowed": True}},
            "usage": {"feat": {"used": 9999, "limit": 0, "remaining": 0}},
        },
        None,
        "feat",
        {"used": 9999},
        {
            "status": "allowed",
            "allowed": True,
            "limit": 0,
            "used": 9999,
            "remaining": 0,
        },
    ),
]


@pytest.mark.parametrize(
    ("entitlement_state", "options", "handle", "context", "expected"),
    [(t[1], t[2], t[3], t[4], t[5]) for t in _FIXTURES],
    ids=[t[0] for t in _FIXTURES],
)
def test_entitlement_pilot_corpus(
    entitlement_state: dict[str, Any] | None,
    options: DecisionEngineOptions | None,
    handle: str,
    context: dict[str, Any] | None,
    expected: EntitlementCheckResult,
) -> None:
    engine = _engine(entitlement_state=entitlement_state, options=options)
    actual = engine.check_entitlement(handle, context=context)
    assert actual == expected, f"\nfixture diverged:\n  expected: {expected}\n  actual:   {actual}"


def test_pilot_corpus_has_ten_fixtures() -> None:
    """Plan 33 TASK-5 acceptance: 10 hand-curated fixtures."""
    assert len(_FIXTURES) == 10
