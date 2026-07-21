"""Python port of scaffold's ``qualifier-gating.ts`` shared evaluation.

Byte-faithful port. Keep aligned with the TS when either side changes.

Qualifiers are category-specific (placement-studio-ui.md §3.6): a qualifier
used outside its category never matches. The category -> valid-qualifier map
is ``QUALIFIERS_BY_CATEGORY`` (scaffold TASK-2, ported verbatim here — the
Python side has no access to the scaffold Zod schema that defines it in TS).

Evaluability:
    none_always_on   — always passes
    payment_failed   — §3.7; fires on plan["payment_failed"] is True
    payment_at_risk  — §3.7; fires on plan["payment_at_risk"] is True
    overage_vs_upgrade / time_bound — not yet evaluable -> pass through

The two payment qualifiers fail closed on absent state; the two
undeterminable ones pass through (see qualifier-gating.ts for the rationale).

Plan 138 (parity for the TS gate shipped in scaffold #160).
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

# Ported verbatim from scaffold's placements/models/schema.ts
# QUALIFIERS_BY_CATEGORY (§3.6 Conversion/Expansion, §3.7 Retention).
QUALIFIERS_BY_CATEGORY: dict[str, tuple[str, ...]] = {
    "other_conversion": ("none_always_on", "overage_vs_upgrade", "time_bound"),
    "retention": ("payment_failed", "payment_at_risk"),
}


def qualifiers_for_category(category: str) -> tuple[str, ...]:
    """Qualifier options offered for a category — empty when it carries none."""
    return QUALIFIERS_BY_CATEGORY.get(category, ())


def is_qualifier_valid_for_category(qualifier: str, category: str) -> bool:
    """Whether a qualifier may be used on a placement of this category.
    ``False`` for a cross-category qualifier (§3.6) or a category with none.
    """
    return qualifier in qualifiers_for_category(category)


class QualifierTriggerShape(TypedDict):
    kind: Literal["qualifier"]
    qualifier: str


def matches_qualifier_trigger(
    trigger: QualifierTriggerShape | None,
    category: str,
    plan: dict[str, Any] | None,
) -> bool:
    """Non-qualifier triggers (``None``) pass through. A cross-category
    qualifier never matches (§3.6). Within its category, evaluable qualifiers
    gate on their signal; the not-yet-evaluable ones pass through. Source:
    qualifier-gating.ts matchesQualifierTrigger.
    """
    if trigger is None:
        return True

    if not is_qualifier_valid_for_category(trigger["qualifier"], category):
        return False

    qualifier = trigger["qualifier"]
    if qualifier == "none_always_on":
        return True
    if qualifier == "payment_failed":
        return isinstance(plan, dict) and plan.get("payment_failed") is True
    if qualifier == "payment_at_risk":
        return isinstance(plan, dict) and plan.get("payment_at_risk") is True
    # overage_vs_upgrade / time_bound: not yet determinable — pass through.
    return True
