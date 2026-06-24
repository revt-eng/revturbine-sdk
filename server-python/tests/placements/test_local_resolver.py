"""Tests for ``revturbine.core.placements.local_resolver``.

Covers the private coercion/CTA/interpolation helpers plus the public
``create_static_placement_resolver`` factory across candidate,
direct-lookup, enrichment, suppression, and fallback paths. A 10-fixture
pilot block extends the TASK-5 batch-1/2a/2b pilots into the local-mode
resolver surface. Expected values traced from
revturbine-scaffold/src/placements/controllers/local-resolver.ts.
"""

from __future__ import annotations

from typing import Any, cast

import pytest

from revturbine.core.decisions.types import PlacementDecision, PlacementRecord
from revturbine.core.placements import (
    DEFAULT_TEMPLATE_TO_SURFACE,
    create_static_placement_resolver,
)
from revturbine.core.placements.local_resolver import (
    _header_str,
    _interpolate_content_tokens,
    _interpolate_string_tokens,
    _is_finite_number,
    _js_math_round,
    _js_string,
    _normalize_cta_path,
    _read_entitlement_handle_from_trigger,
    _read_slot_id_from_trigger,
)
from revturbine.core.state.impression_history import ImpressionHistory
from revturbine.core.state.impression_history_stores import (
    InMemoryImpressionStore,
)

# ── Fixtures / builders ─────────────────────────────────────────────────────


def _rec(**fields: Any) -> PlacementRecord:
    """Typed ``PlacementRecord`` stand-in for resolver tests.

    The fixtures deliberately pass partial record shapes (a bare
    ``name``/``metadata``/``surface_template_ids``) to exercise the
    resolver's name-lookup and slot-narrowing paths. ``cast`` keeps the
    runtime value byte-identical (it is a no-op) while satisfying the
    ``PlacementResolver`` signature's ``PlacementRecord | None`` second
    parameter — no production type is widened.
    """
    return cast("PlacementRecord", fields)


def _entry(
    *,
    entry_id: str = "pl_foo",
    category: str = "gated",
    order: int = 0,
    trigger: dict[str, Any] | None = None,
    payloads: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "id": entry_id,
        "category": category,
        "order": order,
        "trigger": trigger,
        "payloads": payloads if payloads is not None else [_payload()],
    }


def _payload(
    *,
    payload_id: str = "pay1",
    status: str = "active",
    target: dict[str, Any] | None = None,
    surfaces: list[dict[str, Any] | None] | None = None,
) -> dict[str, Any]:
    return {
        "id": payload_id,
        "status": status,
        "target": target,
        "surfaces": surfaces if surfaces is not None else [_surface()],
    }


def _surface(
    *,
    template_id: str = "modal_overlay",
    fields: dict[str, Any] | None = None,
    ctas: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "template_id": template_id,
        "fields": fields if fields is not None else {"header": "Hello"},
        "ctas": ctas,
    }


def _config(
    *,
    version: str = "v1",
    surface_templates: list[dict[str, Any]] | None = None,
    plans: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "version": version,
        "surface_templates": surface_templates,
        "plans": plans,
    }


def _ctx(
    *,
    plan_handle: str | None = None,
    billing_period: str | None = None,
    usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    providers: dict[str, Any] = {}
    if plan_handle is not None or billing_period is not None:
        plan: dict[str, Any] = {}
        if plan_handle is not None:
            plan["current_plan_handle"] = plan_handle
        if billing_period is not None:
            plan["billing_period"] = billing_period
        providers["plan"] = plan
    if usage is not None:
        providers["entitlements"] = {"usage": usage}
    return {"__providers": providers}


def _impression_history() -> ImpressionHistory:
    return ImpressionHistory(user_id="u1", store=InMemoryImpressionStore())


# ── Private helpers ─────────────────────────────────────────────────────────


class TestCoercionHelpers:
    def test_js_string(self) -> None:
        assert _js_string(None) == "null"
        assert _js_string(True) == "true"
        assert _js_string(False) == "false"
        assert _js_string(1.0) == "1"
        assert _js_string(1.5) == "1.5"
        assert _js_string(7) == "7"
        assert _js_string("x") == "x"

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (0.5, 1),  # half rounds toward +Inf
            (-0.5, 0),
            (2.5, 3),
            (2.4, 2),
            (49.5, 50),
            (0.0, 0),
        ],
    )
    def test_js_math_round(self, value: float, expected: int) -> None:
        assert _js_math_round(value) == expected

    def test_is_finite_number(self) -> None:
        assert _is_finite_number(1) is True
        assert _is_finite_number(1.5) is True
        assert _is_finite_number(True) is False  # bool excluded
        assert _is_finite_number("3") is False  # no coercion
        assert _is_finite_number(float("inf")) is False
        assert _is_finite_number(float("nan")) is False
        assert _is_finite_number(None) is False

    def test_header_str(self) -> None:
        assert _header_str("ok") == "ok"
        assert _header_str(None) == ""
        assert _header_str(42) == ""


class TestTriggerReaders:
    def test_entitlement_handle(self) -> None:
        assert _read_entitlement_handle_from_trigger({"entitlement_handle": "s"}) == "s"
        assert _read_entitlement_handle_from_trigger({"entitlement_handle": 1}) is None
        assert _read_entitlement_handle_from_trigger({"other": "x"}) is None
        assert _read_entitlement_handle_from_trigger(None) is None
        assert _read_entitlement_handle_from_trigger("nope") is None

    def test_slot_id(self) -> None:
        assert _read_slot_id_from_trigger({"slot_id": "sl"}) == "sl"
        assert _read_slot_id_from_trigger({"slot_id": 9}) is None
        assert _read_slot_id_from_trigger({}) is None
        assert _read_slot_id_from_trigger(None) is None


class TestInterpolation:
    def test_string_token_resolved(self) -> None:
        assert _interpolate_string_tokens("Hi {{ name }}!", {"name": "Sam"}) == "Hi Sam!"

    def test_missing_token_left_as_collapsed_literal(self) -> None:
        assert _interpolate_string_tokens("a {{ x }} b", {}) == "a {{x}} b"

    def test_none_token_left_as_literal(self) -> None:
        assert _interpolate_string_tokens("{{x}}", {"x": None}) == "{{x}}"

    def test_falsy_non_none_token_stringified(self) -> None:
        assert _interpolate_string_tokens("{{n}}", {"n": 0}) == "0"
        assert _interpolate_string_tokens("{{b}}", {"b": False}) == "false"
        assert _interpolate_string_tokens("{{s}}", {"s": ""}) == ""

    def test_content_tokens_only_strings_interpolated(self) -> None:
        out = _interpolate_content_tokens({"a": "x={{v}}", "v": "VAL", "n": 5, "lst": [1]})
        assert out == {"a": "x=VAL", "v": "VAL", "n": 5, "lst": [1]}


class TestNormalizeCtaPath:
    def test_no_cta_or_no_path_is_dismiss(self) -> None:
        assert _normalize_cta_path(None) == {"type": "dismiss"}
        assert _normalize_cta_path({}) == {"type": "dismiss"}
        assert _normalize_cta_path({"path": ""}) == {"type": "dismiss"}

    def test_open_checkout_with_and_without_purchase(self) -> None:
        assert _normalize_cta_path({"path": "open_checkout", "config": {"purchase": "pro"}}) == {
            "type": "open_checkout_modal",
            "plan_handle": "pro",
        }
        # Non-string purchase → key omitted (JS undefined drops in JSON).
        assert _normalize_cta_path({"path": "open_checkout"}) == {"type": "open_checkout_modal"}
        assert _normalize_cta_path({"path": "open_checkout", "config": {"purchase": 1}}) == {
            "type": "open_checkout_modal"
        }

    def test_view_plans(self) -> None:
        assert _normalize_cta_path({"path": "view_plans"}) == {"type": "navigate_to_plans"}

    def test_custom_passes_action_name_and_config_through(self) -> None:
        # The authored action name flows through as ``type`` and every config
        # key survives, so a custom CTA's url + params reach the SDK resolver.
        assert _normalize_cta_path(
            {"path": "custom", "config": {"url": "/integrations/crm", "org": "42"}}
        ) == {"type": "custom", "url": "/integrations/crm", "org": "42"}
        assert _normalize_cta_path({"path": "custom"}) == {"type": "custom"}

    def test_snooze_remind_later(self) -> None:
        assert _normalize_cta_path({"path": "snooze_remind_later"}) == {"type": "dismiss"}

    def test_open_rt_placement(self) -> None:
        assert _normalize_cta_path(
            {"path": "open_rt_placement", "config": {"placement_handle": "ph"}}
        ) == {"type": "open_rt_placement", "placement_handle": "ph"}
        assert _normalize_cta_path({"path": "open_rt_placement"}) == {"type": "open_rt_placement"}

    def test_default_spreads_config(self) -> None:
        assert _normalize_cta_path({"path": "navigate", "config": {"url": "/x", "extra": 1}}) == {
            "type": "navigate",
            "url": "/x",
            "extra": 1,
        }

    def test_non_record_config_treated_as_empty(self) -> None:
        assert _normalize_cta_path({"path": "navigate", "config": "nope"}) == {"type": "navigate"}


# ── Resolver: index construction ────────────────────────────────────────────


class TestResolverIndex:
    def test_inactive_payload_skipped(self) -> None:
        resolver = create_static_placement_resolver(
            {"placements": [_entry(payloads=[_payload(status="draft")])]},
            _config(),
        )
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            _rec(name="pl_foo"),
            _ctx(),
        )
        assert decision["visible"] is False
        assert decision["reason_codes"] == ["placement_not_found"]

    def test_no_surface_skipped(self) -> None:
        resolver = create_static_placement_resolver(
            {"placements": [_entry(payloads=[_payload(surfaces=[])])]},
            _config(),
        )
        decision = resolver({"placement_id": "p1", "user_id": "u"}, _rec(name="pl_foo"), _ctx())
        assert decision["reason_codes"] == ["placement_not_found"]

    def test_falsy_first_surface_skipped(self) -> None:
        # surfaces=[None] mirrors TS `payload.surfaces[0]` being null →
        # `if (!surface) continue`.
        resolver = create_static_placement_resolver(
            {"placements": [_entry(payloads=[_payload(surfaces=[None])])]},
            _config(),
        )
        decision = resolver({"placement_id": "p1", "user_id": "u"}, _rec(name="pl_foo"), _ctx())
        assert decision["reason_codes"] == ["placement_not_found"]

    def test_short_name_strips_pl_prefix(self) -> None:
        resolver = create_static_placement_resolver(
            {"placements": [_entry(entry_id="pl_foo")]}, _config()
        )
        # Looked up by the pl_-stripped short name.
        decision = resolver({"placement_id": "p1", "user_id": "u"}, _rec(name="foo"), _ctx())
        assert decision["visible"] is True
        assert decision["output"]["output_id"] == "pay1"

    def test_surface_type_from_default_map_then_config_then_custom(self) -> None:
        resolver = create_static_placement_resolver(
            {
                "placements": [
                    _entry(
                        entry_id="pl_a",
                        payloads=[_payload(surfaces=[_surface(template_id="email")])],
                    ),
                    _entry(
                        entry_id="pl_b",
                        payloads=[
                            _payload(
                                payload_id="pb",
                                surfaces=[_surface(template_id="cfg_tpl")],
                            )
                        ],
                    ),
                    _entry(
                        entry_id="pl_c",
                        payloads=[
                            _payload(
                                payload_id="pc",
                                surfaces=[_surface(template_id="unknown_tpl")],
                            )
                        ],
                    ),
                ]
            },
            _config(surface_templates=[{"id": "cfg_tpl", "surface_type": "tooltip"}]),
        )
        a = resolver({"placement_id": "p", "user_id": "u"}, _rec(name="pl_a"), _ctx())
        b = resolver({"placement_id": "p", "user_id": "u"}, _rec(name="pl_b"), _ctx())
        c = resolver({"placement_id": "p", "user_id": "u"}, _rec(name="pl_c"), _ctx())
        assert a["output"]["surface"]["type"] == "email"  # DEFAULT map
        assert b["output"]["surface"]["type"] == "tooltip"  # config override
        assert c["output"]["surface"]["type"] == "custom"  # unknown → custom
        assert DEFAULT_TEMPLATE_TO_SURFACE["modal_overlay"] == "modal"


# ── Resolver: candidate path ────────────────────────────────────────────────


class TestResolverCandidatePath:
    def _resolver(self, entries: list[dict[str, Any]], **cfg: Any) -> Any:
        return create_static_placement_resolver({"placements": entries}, _config(**cfg))

    def test_no_candidates_for_template(self) -> None:
        resolver = self._resolver([_entry()])
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            {"metadata": {"surface_template_ids": ["nonexistent"]}},
            _ctx(),
        )
        assert decision["visible"] is False
        assert decision["reason_codes"] == ["no_candidates_for_template"]
        assert decision["content"]["header"] == "No placements configured for this surface template"

    def test_candidate_selected_and_sorted_by_order(self) -> None:
        resolver = self._resolver(
            [
                _entry(entry_id="pl_low", order=5, category="gated"),
                _entry(
                    entry_id="pl_high",
                    order=1,
                    category="gated",
                    payloads=[_payload(payload_id="phigh")],
                ),
            ]
        )
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            _rec(metadata={"surface_template_ids": ["modal_overlay"]}),
            _ctx(),
        )
        # Lower order wins (sorted ascending, first eligible picked).
        assert decision["output"]["output_id"] == "phigh"

    def test_entitlement_handle_narrowing(self) -> None:
        resolver = self._resolver(
            [
                _entry(
                    entry_id="pl_seats",
                    trigger={"entitlement_handle": "seats"},
                    payloads=[_payload(payload_id="p_seats")],
                ),
                _entry(
                    entry_id="pl_other",
                    trigger={"entitlement_handle": "storage"},
                    payloads=[_payload(payload_id="p_other")],
                ),
            ]
        )
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            {
                "metadata": {
                    "surface_template_ids": ["modal_overlay"],
                    "entitlement_handle": "storage",
                }
            },
            _ctx(),
        )
        assert decision["output"]["output_id"] == "p_other"

    def test_slot_id_narrowing(self) -> None:
        resolver = self._resolver(
            [
                _entry(
                    entry_id="pl_s1",
                    trigger={"slot_id": "slotA"},
                    payloads=[_payload(payload_id="pa")],
                ),
                _entry(
                    entry_id="pl_s2",
                    trigger={"slot_id": "slotB"},
                    payloads=[_payload(payload_id="pb")],
                ),
            ]
        )
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            {
                "metadata": {
                    "surface_template_ids": ["modal_overlay"],
                    "surface_slot_id": "slotB",
                }
            },
            _ctx(),
        )
        assert decision["output"]["output_id"] == "pb"

    def test_category_narrowing_triggered(self) -> None:
        resolver = self._resolver(
            [
                _entry(entry_id="pl_g", category="gated"),
                _entry(
                    entry_id="pl_t",
                    category="retention",
                    payloads=[_payload(payload_id="pt")],
                ),
            ]
        )
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            {
                "metadata": {
                    "surface_template_ids": ["modal_overlay"],
                    "surface_slot_category": "triggered",
                }
            },
            _ctx(),
        )
        assert decision["output"]["output_id"] == "pt"

    def test_fixed_category_skips_category_narrowing(self) -> None:
        # slot_category 'fixed' must NOT apply category narrowing; both
        # candidates remain and the first (by order) eligible wins.
        resolver = self._resolver(
            [
                _entry(entry_id="pl_x", order=0, category="gated"),
                _entry(
                    entry_id="pl_y",
                    order=1,
                    category="fixed",
                    payloads=[_payload(payload_id="py")],
                ),
            ]
        )
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            {
                "metadata": {
                    "surface_template_ids": ["modal_overlay"],
                    "surface_slot_category": "fixed",
                }
            },
            _ctx(),
        )
        assert decision["output"]["output_id"] == "pay1"  # pl_x, order 0

    def test_impression_history_filters_hidden(self) -> None:
        history = _impression_history()
        history.record_dismissal("pl_hidden")
        resolver = create_static_placement_resolver(
            {
                "placements": [
                    _entry(entry_id="pl_hidden", order=0),
                    _entry(
                        entry_id="pl_visible",
                        order=1,
                        payloads=[_payload(payload_id="pv")],
                    ),
                ]
            },
            _config(),
            impression_history=history,
        )
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            _rec(metadata={"surface_template_ids": ["modal_overlay"]}),
            _ctx(),
        )
        assert decision["output"]["output_id"] == "pv"

    def test_no_eligible_candidate(self) -> None:
        resolver = self._resolver(
            [
                _entry(
                    payloads=[_payload(target={"plan_ids": ["plan_only"]})],
                )
            ],
            plans=[{"unique_handle": "free", "id": "plan_free"}],
        )
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            _rec(metadata={"surface_template_ids": ["modal_overlay"]}),
            _ctx(plan_handle="free"),
        )
        assert decision["visible"] is False
        assert decision["reason_codes"] == ["no_eligible_candidate"]


# ── Resolver: direct-lookup path ────────────────────────────────────────────


class TestResolverDirectLookup:
    def test_placement_retired(self) -> None:
        history = _impression_history()
        history.record_dismissal("pl_foo")
        resolver = create_static_placement_resolver(
            {"placements": [_entry()]}, _config(), impression_history=history
        )
        decision = resolver({"placement_id": "p1", "user_id": "u"}, _rec(name="pl_foo"), _ctx())
        assert decision["reason_codes"] == ["placement_retired"]

    def test_plan_target_mismatch(self) -> None:
        resolver = create_static_placement_resolver(
            {"placements": [_entry(payloads=[_payload(target={"plan_ids": ["x"]})])]},
            _config(plans=[{"unique_handle": "free", "id": "plan_free"}]),
        )
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            _rec(name="pl_foo"),
            _ctx(plan_handle="free"),
        )
        assert decision["reason_codes"] == ["plan_target_mismatch"]

    def test_placement_not_found(self) -> None:
        resolver = create_static_placement_resolver({"placements": [_entry()]}, _config())
        decision = resolver({"placement_id": "p1", "user_id": "u"}, _rec(name="missing"), _ctx())
        assert decision["reason_codes"] == ["placement_not_found"]

    def test_no_placement_record_is_not_found(self) -> None:
        resolver = create_static_placement_resolver({"placements": [_entry()]}, _config())
        decision = resolver({"placement_id": "p1", "user_id": "u"}, None, _ctx())
        assert decision["reason_codes"] == ["placement_not_found"]

    def test_flattened_record_shape_reads_top_level(self) -> None:
        # No nested ``metadata`` — surface_template_ids read off the record.
        resolver = create_static_placement_resolver({"placements": [_entry()]}, _config())
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            _rec(surface_template_ids=["modal_overlay"]),
            _ctx(),
        )
        assert decision["visible"] is True
        assert decision["output"]["output_id"] == "pay1"


# ── Resolver: enrichment + suppression ──────────────────────────────────────


class TestResolverEnrichment:
    def test_usage_injection_and_percent_rounding(self) -> None:
        resolver = create_static_placement_resolver(
            {
                "placements": [
                    _entry(
                        trigger={"entitlement_handle": "seats"},
                        payloads=[
                            _payload(
                                surfaces=[_surface(fields={"header": "Used {{usage_percent}}%"})]
                            )
                        ],
                    )
                ]
            },
            _config(),
        )
        decision = resolver(
            {"placement_id": "p1", "user_id": "u"},
            _rec(name="pl_foo"),
            _ctx(
                usage={
                    "seats": {
                        "used": 1,
                        "limit": 3,
                        "remaining": 2,
                        "reset_date": "2026-06-01",
                    }
                }
            ),
        )
        out = decision["output"]["content"]
        assert out["usage_remaining"] == 2
        assert out["usage_limit"] == 3
        assert out["usage_current"] == 1
        # round(1/3*100) = round(33.33) = 33
        assert out["usage_percent"] == 33
        assert out["reset_date"] == "2026-06-01"
        # Token interpolated into the header content + decision content.
        assert out["header"] == "Used 33%"
        assert decision["content"]["header"] == "Used 33%"
        assert decision["content"]["title"] == "Used 33%"

    def test_usage_percent_clamped_to_100_and_limit_zero(self) -> None:
        resolver = create_static_placement_resolver(
            {"placements": [_entry(trigger={"entitlement_handle": "seats"})]},
            _config(),
        )
        over = resolver(
            {"placement_id": "p", "user_id": "u"},
            _rec(name="pl_foo"),
            _ctx(usage={"seats": {"used": 999, "limit": 10, "remaining": 0}}),
        )
        assert over["output"]["content"]["usage_percent"] == 100
        zero = resolver(
            {"placement_id": "p", "user_id": "u"},
            _rec(name="pl_foo"),
            _ctx(usage={"seats": {"used": 5, "limit": 0, "remaining": 0}}),
        )
        assert zero["output"]["content"]["usage_percent"] == 0

    def test_entitlement_handle_from_content_entitlement_field(self) -> None:
        resolver = create_static_placement_resolver(
            {
                "placements": [
                    _entry(
                        payloads=[
                            _payload(
                                surfaces=[_surface(fields={"header": "h", "entitlement": "api"})]
                            )
                        ]
                    )
                ]
            },
            _config(),
        )
        decision = resolver(
            {"placement_id": "p", "user_id": "u"},
            _rec(name="pl_foo"),
            _ctx(usage={"api": {"used": 2, "limit": 4, "remaining": 2}}),
        )
        assert decision["output"]["content"]["usage_current"] == 2

    def test_non_finite_usage_coerced_to_zero(self) -> None:
        resolver = create_static_placement_resolver(
            {"placements": [_entry(trigger={"entitlement_handle": "seats"})]},
            _config(),
        )
        decision = resolver(
            {"placement_id": "p", "user_id": "u"},
            _rec(name="pl_foo"),
            _ctx(
                usage={
                    "seats": {
                        "used": float("nan"),
                        "limit": float("inf"),
                        "remaining": float("nan"),
                    }
                }
            ),
        )
        out = decision["output"]["content"]
        assert out["usage_remaining"] == 0
        assert out["usage_limit"] == 0
        assert out["usage_current"] == 0
        assert out["usage_percent"] == 0

    def test_upsell_enterprise_rejected_by_eligibility(self) -> None:
        # evaluate_plan_eligibility suppresses upsell/trial_conversion for
        # the enterprise handle, so the candidate fails the eligibility
        # gate *before* the visible/plan_tier_suppressed branch — the
        # enterprise suppression surfaces as an eligibility-rejection
        # fallback, never as a selected-but-invisible output. (The
        # `plan_tier_suppressed` branch is defensive parity code that is
        # unreachable through this flow, faithfully mirroring the TS.)
        resolver = create_static_placement_resolver(
            {"placements": [_entry(category="upsell")]},
            _config(plans=[{"unique_handle": "enterprise", "id": "plan_ent"}]),
        )
        direct = resolver(
            {"placement_id": "p", "user_id": "u"},
            _rec(name="pl_foo"),
            _ctx(plan_handle="enterprise"),
        )
        assert direct["visible"] is False
        assert direct["reason_codes"] == ["plan_target_mismatch"]
        assert "output" not in direct

        candidate = resolver(
            {"placement_id": "p", "user_id": "u"},
            _rec(metadata={"surface_template_ids": ["modal_overlay"]}),
            _ctx(plan_handle="enterprise"),
        )
        assert candidate["visible"] is False
        assert candidate["reason_codes"] == ["no_eligible_candidate"]

    def test_request_id_prefixed_local(self) -> None:
        resolver = create_static_placement_resolver({"placements": [_entry()]}, _config())
        decision = resolver({"placement_id": "p", "user_id": "u"}, _rec(name="pl_foo"), _ctx())
        assert decision["request_id"].startswith("local_")
        assert decision["decision_source"] == "fallback"

    def test_cta_label_and_secondary_from_surface_ctas(self) -> None:
        resolver = create_static_placement_resolver(
            {
                "placements": [
                    _entry(
                        payloads=[
                            _payload(
                                surfaces=[
                                    _surface(
                                        ctas=[
                                            {"label": "Primary", "path": "view_plans"},
                                            {"label": "Secondary"},
                                        ]
                                    )
                                ]
                            )
                        ]
                    )
                ]
            },
            _config(),
        )
        decision = resolver({"placement_id": "p", "user_id": "u"}, _rec(name="pl_foo"), _ctx())
        out = decision["output"]["content"]
        assert out["cta_label"] == "Primary"
        assert out["secondary_cta_label"] == "Secondary"
        assert decision["output"]["cta_path"] == {"type": "navigate_to_plans"}
        assert decision["content"]["cta_label"] == "Primary"

    def test_target_plan_ids_gate_eligibility(self) -> None:
        resolver = create_static_placement_resolver(
            {"placements": [_entry(payloads=[_payload(target={"plan_ids": ["plan_pro"]})])]},
            _config(plans=[{"unique_handle": "pro", "id": "plan_pro"}]),
        )
        ok = resolver(
            {"placement_id": "p", "user_id": "u"},
            _rec(name="pl_foo"),
            _ctx(plan_handle="pro"),
        )
        assert ok["visible"] is True
        assert ok["output"]["content"]["__target_plan_ids"] == ["plan_pro"]


# ── Pilot corpus (local-resolver surface) ───────────────────────────────────


def _decide(
    entries: list[dict[str, Any]],
    record: PlacementRecord | None,
    ctx: dict[str, Any],
    *,
    cfg: dict[str, Any] | None = None,
) -> PlacementDecision:
    resolver = create_static_placement_resolver(
        {"placements": entries}, cfg if cfg is not None else _config()
    )
    return resolver({"placement_id": "p", "user_id": "u"}, record, ctx)


class TestLocalResolverPilotCorpus:
    """10 hand-derived fixtures for the local-mode resolver surface,
    extending the TASK-5 batch-1 (entitlement), 2a (payload), and 2b
    (decision-lifecycle) pilots. Each expected value traced from
    local-resolver.ts.
    """

    _FIXTURES: list[tuple[str, bool]] = [
        (
            "default_cta_dismiss",
            _normalize_cta_path(None) == {"type": "dismiss"},
        ),
        (
            "open_checkout_plan_handle",
            _normalize_cta_path({"path": "open_checkout", "config": {"purchase": "pro"}})
            == {"type": "open_checkout_modal", "plan_handle": "pro"},
        ),
        (
            "custom_passthrough_config",
            _normalize_cta_path({"path": "custom", "config": {"url": "/x", "org": "42"}})
            == {"type": "custom", "url": "/x", "org": "42"},
        ),
        (
            "math_round_half_up",
            _js_math_round(2.5) == 3 and _js_math_round(-0.5) == 0,
        ),
        (
            "missing_token_collapsed_literal",
            _interpolate_string_tokens("{{ x }}", {}) == "{{x}}",
        ),
        (
            "js_string_integral_float",
            _js_string(2.0) == "2" and _js_string(None) == "null",
        ),
        (
            "unknown_template_is_custom",
            _decide(
                [_entry(payloads=[_payload(surfaces=[_surface(template_id="zz")])])],
                _rec(name="pl_foo"),
                _ctx(),
            )["output"]["surface"]["type"]
            == "custom",
        ),
        (
            "no_candidates_fallback",
            _decide(
                [_entry()],
                _rec(metadata={"surface_template_ids": ["none"]}),
                _ctx(),
            )["reason_codes"]
            == ["no_candidates_for_template"],
        ),
        (
            "enterprise_upsell_suppressed",
            _decide(
                [_entry(category="upsell")],
                _rec(name="pl_foo"),
                _ctx(plan_handle="enterprise"),
                cfg=_config(plans=[{"unique_handle": "enterprise", "id": "pe"}]),
            )["visible"]
            is False,
        ),
        (
            "usage_percent_clamped",
            _decide(
                [_entry(trigger={"entitlement_handle": "seats"})],
                _rec(name="pl_foo"),
                _ctx(usage={"seats": {"used": 50, "limit": 10, "remaining": 0}}),
            )["output"]["content"]["usage_percent"]
            == 100,
        ),
    ]

    @pytest.mark.parametrize(
        "assertion",
        [t[1] for t in _FIXTURES],
        ids=[t[0] for t in _FIXTURES],
    )
    def test_pilot(self, assertion: bool) -> None:
        assert assertion is True

    def test_corpus_has_ten_fixtures(self) -> None:
        assert len(self._FIXTURES) == 10
