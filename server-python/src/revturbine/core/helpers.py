"""Pure utility helpers — Python port of `@revt-eng/core` helpers.

Each helper documents its TS source (file + line range). Behavior is
intended to be bit-identical; the parity test suite (plan 33 TASK-8/9/10)
will gate any drift in CI. Tweaks that look idiomatic in Python — for
example, using ``str.replace`` over a regex — are only safe when the
input domain rules out the divergence (e.g. ASCII-only slugs).

Source: revturbine-scaffold/src/core/helpers.ts
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Literal, TypedDict, TypeGuard

__all__ = [
    "is_record",
    "ensure_array",
    "first_string_value",
    "parse_numberish",
    "normalized_route",
    "sanitize_slug",
    "normalize_event_type",
    "parse_cap_rule",
    "period_window_start",
    "parse_local_lookup_key",
    "plan_target_aliases",
    "placement_target_plan_ids",
    "placement_matches_plan_target",
    "recommend_next_plan_up",
    "resolve_recommended_plan_tokens",
    "usage_token_prefix_from_entitlement_id",
    "sanitize_usage_token_prefix",
    "looks_generic_usage_unit",
    "usage_amounts_from_entries",
    "configured_plan_name_from_exported_config",
    "parse_exported_config_or_throw",
    "category_bucket",
    "placement_score",
    "placement_priority",
    "proximity_score",
    "is_modal_safe_surface_type",
    "server_order",
    "milestone_version",
    "superseded_versions",
    "stable_stringify",
    "validate_trial_status_shape",
    # Type aliases
    "CapPeriod",
    "JsonObject",
    "LocalLookupParts",
    "PlacementCapRule",
    "PlacementOutput",
    "TrialContext",
]


# ── Type aliases (mirror TS @revt-eng/core types) ───────────────────────────

# Loose JSON-object shape — matches TS `JsonObject` (recursive in TS, but
# Python's recursive type aliases are awkward pre-PEP 695 / 3.12, so we
# accept the looser dict[str, Any] for the runtime SDK boundary).
JsonObject = dict[str, Any]

# Loose `PlacementOutput` — the helpers operate on dict shapes pulled from
# the decision-API response. The strongly-typed Pydantic model (from the
# generated `revturbine_types` package) is a downstream concern wired in
# TASK-7 when `RevTurbineCustomerSdk` lands; the helpers themselves stay
# JSON-object pure for parity with the TS originals.
PlacementOutput = dict[str, Any]

CapPeriod = Literal["session", "day", "week", "month", "lifetime"]


class PlacementCapRule(TypedDict):
    """Parsed `{count, period}` cap rule. Source: state/types.ts."""

    count: float
    period: CapPeriod


class _TrialContextRequired(TypedDict):
    in_trial: bool


class TrialContext(_TrialContextRequired, total=False):
    """Normalized trial-status shape returned by ``validate_trial_status_shape``.

    ``day_number`` / ``days_remaining`` are typed ``float`` to match
    JavaScript's unified ``number`` type — TS-side trial APIs may emit
    fractional values for partial-day timings.

    Source: helpers.ts TrialContext interface (lines 442-448).
    """

    trial_type: str
    plan_handle: str
    day_number: float
    days_remaining: float


# ── Type guards ──────────────────────────────────────────────────────────────


def is_record(value: Any) -> TypeGuard[dict[str, Any]]:
    """Return True when ``value`` is a JSON-object-shaped dict.

    Lists, ``None``, and primitives return False — matching the TS
    ``isRecord`` predicate (``typeof === 'object' && !Array.isArray``).
    Annotated with ``TypeGuard`` so mypy narrows the parameter to
    ``dict[str, Any]`` in the True branch.

    Source: helpers.ts:29-31
    """
    return isinstance(value, dict)


# ── Array / string utilities ────────────────────────────────────────────────


def ensure_array(value: list[str] | None = None) -> list[str]:
    """Return ``value`` filtered to non-empty (post-strip) strings.

    Non-list inputs (including ``None``) return ``[]``.

    Source: helpers.ts:35-37
    """
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item.strip()]


def first_string_value(*values: Any) -> str | None:
    """Return the first argument that is a non-empty string after strip.

    Returns ``None`` if no argument qualifies. The TS version returns
    ``undefined``; we use ``None`` (Python convention).

    Source: helpers.ts:39-46
    """
    for value in values:
        if isinstance(value, str) and value.strip():
            return value
    return None


def parse_numberish(value: Any) -> float | None:
    """Coerce ``value`` to a finite number; return ``None`` if not coercible.

    Accepts ``int``, ``float``, or numeric ``str``. Rejects ``NaN`` and
    ``inf``. ``bool`` is rejected explicitly because Python's ``bool`` is
    a subclass of ``int`` — TS's ``typeof value === 'number'`` is False
    for booleans, so we mirror that.

    Source: helpers.ts:48-55
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    if isinstance(value, str):
        try:
            parsed = float(value)
        except (ValueError, TypeError):
            return None
        return parsed if math.isfinite(parsed) else None
    return None


# ── Route / slug normalization ──────────────────────────────────────────────


_TRAILING_SLASHES_RE = re.compile(r"/+$")
_NON_SLUG_CHARS_RE = re.compile(r"[^a-z0-9]+")
_LEADING_TRAILING_DASHES_RE = re.compile(r"^-+|-+$")


def normalized_route(pathname: str) -> str:
    """Lowercase, strip, and trim trailing slashes; empty path becomes ``"/"``.

    Source: helpers.ts:59-64
    """
    stripped = _TRAILING_SLASHES_RE.sub("", pathname.strip().lower())
    return stripped or "/"


def sanitize_slug(input_value: str, fallback_suffix: str | None = None) -> str:
    """Slugify ``input_value``; fall back to ``slot-<fallback_suffix>``.

    Empty / whitespace / non-string-coercible inputs produce
    ``slot-unknown`` unless ``fallback_suffix`` overrides the suffix.

    Source: helpers.ts:66-74
    """
    raw = str(input_value or "")
    lowered = _NON_SLUG_CHARS_RE.sub("-", raw.strip().lower())
    normalized = _LEADING_TRAILING_DASHES_RE.sub("", lowered)
    if normalized:
        return normalized
    return f"slot-{fallback_suffix if fallback_suffix is not None else 'unknown'}"


# ── Event normalization ─────────────────────────────────────────────────────


_WHITESPACE_RE = re.compile(r"\s+")
_DASHES_RE = re.compile(r"-+")

_CLICKSTREAM_ALIASES: dict[str, str] = {
    "pageview": "clickstream_page_view",
    "page_view": "clickstream_page_view",
    "click": "clickstream_click",
    "doc_view": "clickstream_doc_view",
    "checkout_started": "clickstream_checkout_started",
    "checkout_completed": "clickstream_checkout_completed",
    "payment_failed": "clickstream_payment_failed",
}


def normalize_event_type(value: str) -> str:
    """Normalize event-type name; map known aliases to ``clickstream_*``.

    Empty / coerced-empty input returns ``"unknown_event"``.

    Source: helpers.ts:78-104
    """
    raw = str(value or "").strip().lower()
    compact = _DASHES_RE.sub("_", _WHITESPACE_RE.sub("_", raw))
    if not compact:
        return "unknown_event"
    return _CLICKSTREAM_ALIASES.get(compact, compact)


# ── Cap / period helpers ────────────────────────────────────────────────────


_CAP_PERIODS: frozenset[str] = frozenset({"session", "day", "week", "month", "lifetime"})


def parse_cap_rule(input_value: Any) -> PlacementCapRule | None:
    """Parse a `{count, period}` cap rule from untyped input.

    Returns ``None`` if the input is not a dict, ``count`` is missing /
    non-positive / non-finite, or ``period`` is not one of the five
    recognized cap-period strings.

    Source: helpers.ts:108-117
    """
    if not is_record(input_value):
        return None
    count_raw = input_value.get("count")
    period = input_value.get("period")
    # TS uses `Number(input.count)` which coerces; mirror by reusing
    # parse_numberish for the unifying coercion semantics, then enforce
    # the positive / finite requirements explicitly.
    count = parse_numberish(count_raw)
    if count is None or count <= 0:
        return None
    if not isinstance(period, str) or period not in _CAP_PERIODS:
        return None
    return PlacementCapRule(count=count, period=period)  # type: ignore[typeddict-item]


_MS_PER_DAY = 24 * 60 * 60 * 1000
_MS_PER_WEEK = 7 * _MS_PER_DAY
_MS_PER_MONTH = 30 * _MS_PER_DAY


def period_window_start(period: CapPeriod, now_ms: float) -> float:
    """Return the epoch-ms window start for ``period`` anchored on ``now_ms``.

    ``session`` and ``lifetime`` always start at ``0`` (whole-history window).
    ``day`` = 24h, ``week`` = 7d, otherwise = 30d (TS treats unrecognized
    inputs as ``month`` via the trailing fall-through).

    Source: helpers.ts:119-124
    """
    if period in ("session", "lifetime"):
        return 0
    if period == "day":
        return now_ms - _MS_PER_DAY
    if period == "week":
        return now_ms - _MS_PER_WEEK
    return now_ms - _MS_PER_MONTH


# ── Lookup key parsing ──────────────────────────────────────────────────────


class LocalLookupParts(dict[str, str]):
    """Parsed ``::``-delimited local-placement lookup key.

    Behaves as a dict for parity with the TS object shape, with five
    string slots: ``slot_id``, ``surface_type``, ``entitlement_handle``,
    ``plan_handle``, ``placement_handle``. Missing trailing segments
    default to ``""``.

    Source: helpers.ts:128-145
    """

    __slots__ = ()

    @property
    def slot_id(self) -> str:
        return self["slot_id"]

    @property
    def surface_type(self) -> str:
        return self["surface_type"]

    @property
    def entitlement_handle(self) -> str:
        return self["entitlement_handle"]

    @property
    def plan_handle(self) -> str:
        return self["plan_handle"]

    @property
    def placement_handle(self) -> str:
        return self["placement_handle"]


def parse_local_lookup_key(key: str) -> LocalLookupParts:
    """Split ``::``-delimited lookup key into its five named fields.

    Source: helpers.ts:136-145
    """
    parts = key.split("::")

    def at(index: int) -> str:
        if index < len(parts) and parts[index]:
            return parts[index]
        return ""

    return LocalLookupParts(
        slot_id=at(0),
        surface_type=at(1),
        entitlement_handle=at(2),
        plan_handle=at(3),
        placement_handle=at(4),
    )


# ── Plan target matching ────────────────────────────────────────────────────


def plan_target_aliases(plan_handle: str) -> list[str]:
    """Return canonical aliases for ``plan_handle`` (e.g. ``starter`` ↔ ``free``).

    Returns ``[]`` for empty / whitespace-only handles; ``[normalized]``
    for unknown handles.

    Source: helpers.ts:149-164
    """
    normalized = plan_handle.strip().lower()
    if not normalized:
        return []
    if normalized in ("starter", "free"):
        return ["starter", "free"]
    if normalized in ("professional", "pro"):
        return ["professional", "pro"]
    if normalized == "enterprise":
        return ["enterprise"]
    return [normalized]


def placement_target_plan_ids(output: PlacementOutput) -> list[str]:
    """Resolve plan-id targeting from a PlacementOutput.

    Reads ``output.target.plan_ids`` first (canonical location); falls back
    to ``output.content.__target_plan_ids`` (legacy embedded form). Returns
    ``[]`` if neither path holds an array of strings.

    Source: helpers.ts:166-179
    """
    target = output.get("target")
    if is_record(target):
        plan_ids = target.get("plan_ids")
        if isinstance(plan_ids, list):
            direct = [item for item in plan_ids if isinstance(item, str)]
            if direct:
                return direct

    content = output.get("content")
    if not is_record(content):
        return []
    embedded = content.get("__target_plan_ids")
    if not isinstance(embedded, list):
        return []
    return [item for item in embedded if isinstance(item, str)]


def placement_matches_plan_target(
    output: PlacementOutput,
    plan_handle: str | None = None,
) -> bool:
    """Whether ``plan_handle`` satisfies the placement's plan-target restrictions.

    Returns True when no target restrictions are set, or when an alias of
    ``plan_handle`` matches any of the target plan ids (case-insensitive,
    plus the TS suffix/substring fallbacks).

    Source: helpers.ts:181-196
    """
    target_plan_ids = placement_target_plan_ids(output)
    if not target_plan_ids or not plan_handle:
        return True

    aliases = plan_target_aliases(plan_handle)
    if not aliases:
        return True

    for target in target_plan_ids:
        normalized_target = target.lower()
        for alias in aliases:
            if (
                normalized_target == alias
                or normalized_target.endswith(f"_{alias}")
                or alias in normalized_target
            ):
                return True
    return False


def recommend_next_plan_up(
    current_plan_handle: str,
    plans: list[dict[str, Any]],
) -> str | None:
    """Return the ``unique_handle`` of the plan one tier above ``current_plan_handle``.

    Walks the plan hierarchy in ascending order by
    ``tier_position`` -> ``sort_order`` -> ``source_id``
    (plans-entitlements-studio-ui.md §2.2 + line 599). Returns ``None`` when
    the current plan is at the top of the ladder, not present in ``plans``,
    or ``plans`` is empty.

    Cross-language parity mirror of TypeScript ``recommendNextPlanUp``
    (revturbine-scaffold/src/core/helpers.ts). The two implementations
    must produce byte-identical output for the same input — see
    revturbine-sdk-internal/tests/parity/.

    Source: helpers.ts:217-237 (plan #46 TASK-2)
    """
    if not plans:
        return None

    sorted_plans = sorted(
        plans,
        key=lambda p: (
            int(p.get("tier_position") or 0),
            int(p.get("sort_order") or 0),
            str(p.get("source_id") or ""),
        ),
    )

    current_idx = -1
    for idx, plan in enumerate(sorted_plans):
        if plan.get("unique_handle") == current_plan_handle:
            current_idx = idx
            break

    if current_idx == -1:
        return None
    if current_idx == len(sorted_plans) - 1:
        return None

    next_handle = sorted_plans[current_idx + 1].get("unique_handle")
    return next_handle if isinstance(next_handle, str) else None


def resolve_recommended_plan_tokens(
    strategy: str,
    plan_override: str | None,
    current_plan_handle: str,
    plans: list[dict[str, Any]],
) -> dict[str, str]:
    """Resolve the ``recommended_plan_handle`` / ``recommended_plan_name`` tokens
    for one placement, dispatching on its authored ``recommendation_strategy``
    (placement-studio-ui.md Appendix C.3 / plan #47):

    - ``next_tier_up`` (default): the next plan up the hierarchy via
      :func:`recommend_next_plan_up`.
    - ``custom``: the plan forced by ``plan_override`` (a ``unique_handle``).
    - ``best_value``: reserved; falls back to ``next_tier_up`` until its
      scoring model ships.

    Edge cases resolve to empty strings (the top-of-ladder convention): empty
    plan list, unknown current plan, top of the hierarchy, and — for
    ``custom`` — a missing/unknown override or an override equal to the current
    plan. Matching is exact on ``unique_handle``.

    Cross-language parity mirror of TypeScript ``resolveRecommendedPlanTokens``
    (revturbine-sdk-internal/web-sdk/placements/recommendation.ts). The two must produce
    byte-identical output for the same input — see
    revturbine-sdk-internal/tests/parity/fixtures/plan_recommendation_custom_*.
    """
    empty = {"recommended_plan_handle": "", "recommended_plan_name": ""}
    if not plans:
        return empty

    if strategy == "custom":
        override = plan_override or ""
        if override == "" or override == current_plan_handle:
            return empty
        plan = next((p for p in plans if p.get("unique_handle") == override), None)
        if plan is None:
            return empty
        return {
            "recommended_plan_handle": str(plan.get("unique_handle") or ""),
            "recommended_plan_name": str(plan.get("name") or ""),
        }

    # 'next_tier_up' (default) and 'best_value' both resolve via the hierarchy.
    # best_value falls back here until its scoring model ships (plan #48).
    if current_plan_handle == "":
        return empty
    next_handle = recommend_next_plan_up(current_plan_handle, plans)
    if next_handle is None:
        return empty
    nxt = next((p for p in plans if p.get("unique_handle") == next_handle), None)
    name = nxt.get("name") if nxt else None
    return {
        "recommended_plan_handle": next_handle,
        "recommended_plan_name": name if isinstance(name, str) else next_handle,
    }


# ── Usage token helpers ─────────────────────────────────────────────────────


_USAGE_SUFFIX_RE = re.compile(r"_(minutes|minute|credits|credit|seats|seat)$", re.IGNORECASE)
_USAGE_USAGE_SUFFIX_RE = re.compile(r"_usage$", re.IGNORECASE)


def usage_token_prefix_from_entitlement_id(entitlement_id: str) -> str:
    """Derive a usage-token prefix by stripping unit/``_usage`` suffixes.

    Source: helpers.ts:200-206
    """
    stripped = _USAGE_USAGE_SUFFIX_RE.sub("", _USAGE_SUFFIX_RE.sub("", entitlement_id))
    return stripped.strip().lower()


_NON_TOKEN_CHARS_RE = re.compile(r"[^a-z0-9_]")


def sanitize_usage_token_prefix(value: str) -> str:
    """Normalize a usage-token prefix to ``[a-z0-9_]+``.

    Source: helpers.ts:208-214
    """
    collapsed = _WHITESPACE_RE.sub("_", value.strip().lower())
    return _NON_TOKEN_CHARS_RE.sub("", collapsed)


_GENERIC_USAGE_UNITS: frozenset[str] = frozenset(
    {"minutes", "minute", "credits", "credit", "seats", "seat", "units", "unit"}
)


def looks_generic_usage_unit(unit: str) -> bool:
    """Whether ``unit`` is one of the platform-wide generic usage units.

    Source: helpers.ts:216-225
    """
    return unit in _GENERIC_USAGE_UNITS


# ── Usage extraction ────────────────────────────────────────────────────────


def usage_amounts_from_entries(
    usage: dict[str, Any] | None,
) -> dict[str, float]:
    """Flatten a ``UserUsageEntry`` dict to ``{handle: amount}``.

    Each entry may be either a dict with an ``amount`` number field, or a
    bare number (legacy shape). Non-conforming entries are skipped silently
    (mirrors the TS guard chain).

    Source: helpers.ts:229-240
    """
    if not usage:
        return {}
    amounts: dict[str, float] = {}
    for key, entry in usage.items():
        if is_record(entry):
            amount = entry.get("amount")
            if isinstance(amount, (int, float)) and not isinstance(amount, bool):
                amounts[key] = float(amount)
        elif isinstance(entry, (int, float)) and not isinstance(entry, bool):
            amounts[key] = float(entry)
    return amounts


# ── Config plan name lookup ─────────────────────────────────────────────────


def configured_plan_name_from_exported_config(
    exported_config: JsonObject | None,
    plan_value: str | JsonObject | None,
) -> str | None:
    """Look up a plan's display name from an ``ExportedConfig`` plans list.

    Accepts either a raw plan id/handle string or a ``UserPlanContext``
    dict (in which case ``plan_value["id"]`` is used). Matches by id,
    unique_handle, or the ``_handle`` suffix fallback the TS implements.

    Source: helpers.ts:244-276
    """
    if not exported_config:
        return None
    plans = exported_config.get("plans")
    if not isinstance(plans, list):
        return None

    plan_id: str | None = None
    if isinstance(plan_value, str) and plan_value.strip():
        plan_id = plan_value.strip()
    elif is_record(plan_value):
        candidate = plan_value.get("id")
        if isinstance(candidate, str) and candidate.strip():
            plan_id = candidate.strip()
    if not plan_id:
        return None

    normalized_plan = plan_id.lower()

    for raw_plan in plans:
        if not is_record(raw_plan):
            continue
        plan_id_field = raw_plan.get("id")
        id_str = plan_id_field.lower() if isinstance(plan_id_field, str) else ""
        handle_field = raw_plan.get("unique_handle")
        handle_str = handle_field.lower() if isinstance(handle_field, str) else ""

        if (
            id_str == normalized_plan
            or handle_str == normalized_plan
            or id_str.endswith(f"_{normalized_plan}")
        ):
            name = raw_plan.get("name")
            if isinstance(name, str) and name.strip():
                return name.strip()
    return None


# ── Config validation ───────────────────────────────────────────────────────


_REQUIRED_EXPORTED_CONFIG_ARRAY_FIELDS: tuple[str, ...] = (
    "plans",
    "entitlements",
    "entitlement_rules",
    "segments",
    "content_ui_paths",
    "surface_templates",
)


def parse_exported_config_or_throw(raw: Any, source: str) -> JsonObject | None:
    """Validate an ``ExportedConfig`` shape; raise ``ValueError`` on bad input.

    Mirrors the TS helper that throws at the SDK boundary when the input is
    not undefined but malformed. ``None`` (the TS ``undefined`` analog)
    passes through silently — used by callers that treat missing config as
    "remote mode" rather than an error.

    Source: helpers.ts:289-306
    """
    if raw is None:
        return None
    if not is_record(raw):
        raise ValueError(f"Invalid {source}: expected top-level object")
    if not isinstance(raw.get("version"), str):
        raise ValueError(f'Invalid {source}: missing string "version"')
    if not isinstance(raw.get("exported_at"), str):
        raise ValueError(f'Invalid {source}: missing string "exported_at"')
    for key in _REQUIRED_EXPORTED_CONFIG_ARRAY_FIELDS:
        if not isinstance(raw.get(key), list):
            raise ValueError(f'Invalid {source}: missing array "{key}"')
    return raw


# ── Placement scoring ───────────────────────────────────────────────────────


def category_bucket(category: str) -> int:
    """Map a placement category string to a priority-bucket integer.

    Lower bucket = higher priority. ``0`` = gated/entitlement (always
    first per spec); ``99`` = unknown.

    Source: helpers.ts:310-321
    """
    normalized = str(category or "").strip().lower()
    if not normalized:
        return 99

    if "gated" in normalized or "entitlement" in normalized:
        return 0
    if "fixed" in normalized:
        return 1
    if any(token in normalized for token in ("usage", "credit", "seat", "quota")):
        return 2
    if "trial" in normalized:
        return 3
    if any(token in normalized for token in ("conversion", "expansion", "upsell")):
        return 4
    if any(token in normalized for token in ("retention", "winback", "churn")):
        return 5
    return 99


def placement_score(output: PlacementOutput) -> float:
    """First numeric of ``score``, ``ltv_propensity_score``, ``content.score``,
    ``content.ltv_propensity_score``, ``content.ranking_score``; else ``0``.

    Source: helpers.ts:323-336
    """
    content_raw = output.get("content")
    content: dict[str, Any] = content_raw if is_record(content_raw) else {}
    candidates = (
        parse_numberish(output.get("score")),
        parse_numberish(output.get("ltv_propensity_score")),
        parse_numberish(content.get("score")),
        parse_numberish(content.get("ltv_propensity_score")),
        parse_numberish(content.get("ranking_score")),
    )
    for value in candidates:
        if value is not None:
            return value
    return 0


def placement_priority(output: PlacementOutput) -> float:
    """First numeric of ``priority``, ``placement_priority``, and content variants;
    else ``0``.

    Source: helpers.ts:338-350
    """
    content_raw = output.get("content")
    content: dict[str, Any] = content_raw if is_record(content_raw) else {}
    candidates = (
        parse_numberish(output.get("priority")),
        parse_numberish(output.get("placement_priority")),
        parse_numberish(content.get("priority")),
        parse_numberish(content.get("placement_priority")),
    )
    for value in candidates:
        if value is not None:
            return value
    return 0


def proximity_score(output: PlacementOutput) -> float:
    """Proximity-to-constraint score for priority-tier placements.

    Reads ``usage_percent`` → ``trial_percent_elapsed`` → ``threshold_percent``
    from the content bag. Higher value = closer to constraint = higher
    priority. Falls back to ``placement_score`` when no proximity data is
    available.

    Source: helpers.ts:359-369
    """
    content_raw = output.get("content")
    content: dict[str, Any] = content_raw if is_record(content_raw) else {}
    candidates = (
        parse_numberish(content.get("usage_percent")),
        parse_numberish(content.get("trial_percent_elapsed")),
        parse_numberish(content.get("threshold_percent")),
    )
    for value in candidates:
        if value is not None:
            return value
    return placement_score(output)


def is_modal_safe_surface_type(surface_type: str) -> bool:
    """Whether a surface type is safe for unprompted rendering.

    Modal and full_page are interruptive and only render at safe
    moments. All other surface types are safe.

    Source: helpers.ts:377-380
    """
    normalized = surface_type.strip().lower()
    return normalized not in ("modal", "full_page")


def server_order(output: PlacementOutput) -> float | None:
    """First numeric of ``server_order``, ``order``, ``rank``, ``order_index``
    (root then content); else ``None``.

    Source: helpers.ts:382-396
    """
    content_raw = output.get("content")
    content: dict[str, Any] = content_raw if is_record(content_raw) else {}
    candidates = (
        parse_numberish(output.get("server_order")),
        parse_numberish(output.get("order")),
        parse_numberish(output.get("rank")),
        parse_numberish(output.get("order_index")),
        parse_numberish(content.get("server_order")),
        parse_numberish(content.get("order")),
        parse_numberish(content.get("rank")),
        parse_numberish(content.get("order_index")),
    )
    for value in candidates:
        if value is not None:
            return value
    return None


# ── Milestone version helpers ───────────────────────────────────────────────


def milestone_version(output: PlacementOutput) -> str | None:
    """Resolve ``content.template_version`` (string or numeric), falling back
    to ``content.milestone_version``. Numeric inputs are stringified.

    Source: helpers.ts:400-411
    """
    content_raw = output.get("content")
    content: dict[str, Any] = content_raw if is_record(content_raw) else {}

    direct = content.get("template_version")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    direct_num = parse_numberish(direct)
    if direct_num is not None:
        return _stringify_number(direct_num)

    fallback = content.get("milestone_version")
    if isinstance(fallback, str) and fallback.strip():
        return fallback.strip()
    fallback_num = parse_numberish(fallback)
    if fallback_num is not None:
        return _stringify_number(fallback_num)
    return None


def superseded_versions(output: PlacementOutput) -> list[str]:
    """Resolve ``content.supersedes_template_version`` to a list of strings.

    Accepts a string, a number, or a list of either; non-conforming entries
    are skipped. Mirrors the TS shape rather than normalizing schema.

    Source: helpers.ts:413-425
    """
    content_raw = output.get("content")
    content: dict[str, Any] = content_raw if is_record(content_raw) else {}
    raw = content.get("supersedes_template_version")

    if isinstance(raw, list):
        results: list[str] = []
        for item in raw:
            if isinstance(item, str) and item.strip():
                results.append(item.strip())
                continue
            num = parse_numberish(item)
            if num is not None:
                results.append(_stringify_number(num))
        return results

    if isinstance(raw, str) and raw.strip():
        return [raw.strip()]
    num = parse_numberish(raw)
    return [_stringify_number(num)] if num is not None else []


def _stringify_number(value: float) -> str:
    """Match JS ``String(n)``: integral values render without a decimal point.

    Python's ``str(1.0) == "1.0"`` while JS's ``String(1) == "1"``. The
    parity suite would catch this divergence; pre-empt it by stripping
    a trailing ``.0`` when the value is an integer.
    """
    if value.is_integer():
        return str(int(value))
    return repr(value) if "e" in repr(value) else str(value)


# ── Stable JSON stringify ───────────────────────────────────────────────────


def stable_stringify(value: Any) -> str:
    """Deterministic JSON stringify — object keys sorted at every level.

    Output matches ``JSON.stringify`` with sorted keys: no whitespace,
    standard JSON syntax. Used as cache-key input where two semantically
    equal payloads must produce the same string. Sort uses Python's
    default lexicographic order, which matches JavaScript's
    ``localeCompare`` for the ASCII identifier keys our schemas use; if
    we ever introduce non-ASCII keys, the parity suite will flag the
    divergence.

    Source: helpers.ts:429-438
    """
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


# ── Trial status validation ─────────────────────────────────────────────────


def validate_trial_status_shape(data: Any) -> TrialContext:
    """Coerce unknown trial-status data into a typed ``TrialContext`` dict.

    Non-dict inputs collapse to ``{"in_trial": False}``. Optional fields
    are included only when the source value has the expected type; nothing
    else is invented.

    Note: Python's ``bool`` subclasses ``int``, so the ``day_number`` /
    ``days_remaining`` numeric checks explicitly reject ``bool`` to match
    TS's ``typeof === 'number'`` semantics (which is False for booleans).

    Source: helpers.ts:450-459
    """
    if not is_record(data):
        return TrialContext(in_trial=False)

    in_trial_raw = data.get("in_trial")
    in_trial = in_trial_raw if isinstance(in_trial_raw, bool) else False

    result: TrialContext = TrialContext(in_trial=in_trial)
    trial_type = data.get("trial_type")
    if isinstance(trial_type, str):
        result["trial_type"] = trial_type
    plan_handle = data.get("plan_handle")
    if isinstance(plan_handle, str):
        result["plan_handle"] = plan_handle
    day_number = data.get("day_number")
    if isinstance(day_number, (int, float)) and not isinstance(day_number, bool):
        result["day_number"] = float(day_number)
    days_remaining = data.get("days_remaining")
    if isinstance(days_remaining, (int, float)) and not isinstance(days_remaining, bool):
        result["days_remaining"] = float(days_remaining)
    return result
