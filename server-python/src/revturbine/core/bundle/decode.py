"""Bundle -> Playbook decoder (plan 160 TASK-4) — the Python port.

A faithful translation of the TypeScript decoder
(``revturbine-scaffold/src/core/bundle/decode.ts``, shipped in #189). Reads a
compiled ``.rvtb`` FlatBuffer back into the canonical Playbook dict so the
Python server SDK can consume the compact bundle as an on-the-wire optimization
instead of the full JSON Playbook.

Two layers, mirroring the TS decoder:

1. :func:`decode_bundle_to_ir` — a faithful, complete FlatBuffer -> IR read (the
   exact inverse of scaffold's ``encode.ts``). It reads every field the encoder
   writes, including entities a reduced reader would drop.
2. :func:`ir_to_playbook` — the inverse of ``lowerToIR``: resolves table indexes
   back to handles, maps IR enums + the flat ``type_fields`` union back to config
   shapes, and synthesizes the schema-required fields the bundle drops (tier /
   trial ``name`` from handle; credits ``reset_period``). IR entitlement type
   ``unknown`` maps back to ``price_per_unit`` (re-normalizes to ``unknown``),
   preserving the round trip.

:func:`bundle_to_playbook` is the public entry point. The decoded Playbook is fed
to the same evaluator used for JSON configs, so decisions are identical by
construction — enforced by the cross-language parity corpus (TS is canonical).

Parity note: keep this byte-for-byte semantically aligned with ``decode.ts``. A
divergence is a Python-port bug, never a fixture to loosen.
"""

from __future__ import annotations

from typing import Any

from revturbine.bundle.BillingPeriod import BillingPeriod
from revturbine.bundle.CapPeriod import CapPeriod
from revturbine.bundle.CreditsFields import CreditsFields
from revturbine.bundle.Enforcement import Enforcement
from revturbine.bundle.EntitlementType import EntitlementType
from revturbine.bundle.FeatureFields import FeatureFields
from revturbine.bundle.PayloadSourceMode import PayloadSourceMode
from revturbine.bundle.PlacementCategory import PlacementCategory
from revturbine.bundle.PredicateOp import PredicateOp
from revturbine.bundle.RecommendationStrategy import RecommendationStrategy
from revturbine.bundle.RuleBundle import RuleBundle
from revturbine.bundle.RuleTargetKind import RuleTargetKind
from revturbine.bundle.SeatsFields import SeatsFields
from revturbine.bundle.SegmentChipKind import SegmentChipKind
from revturbine.bundle.SegmentCombinator import SegmentCombinator
from revturbine.bundle.TieredFields import TieredFields
from revturbine.bundle.TokenCategory import TokenCategory
from revturbine.bundle.TokenFormat import TokenFormat
from revturbine.bundle.TrialType import TrialType
from revturbine.bundle.TypeFields import TypeFields as TypeFieldsUnion
from revturbine.bundle.UiPathActionType import UiPathActionType
from revturbine.bundle.UsageAllocation import UsageAllocation
from revturbine.bundle.UsageLimitFields import UsageLimitFields

from ...config import Playbook

# uint32-max "no reference" sentinel (mirrors ir.ts ABSENT_INDEX).
ABSENT_INDEX = 0xFFFFFFFF

# ── FB enum int -> IR string reverse mappers (inverse of encode.ts map*) ──────

_ENTITLEMENT_TYPE = {
    EntitlementType.feature: "feature",
    EntitlementType.usage_limit: "usage_limit",
    EntitlementType.credits: "credits",
    EntitlementType.seats: "seats",
    EntitlementType.tiered: "tiered",
}

_ENFORCEMENT = {
    Enforcement.hard_block: "hard_block",
    Enforcement.soft_block: "soft_block",
    Enforcement.degrade: "degrade",
    Enforcement.allow_overage: "allow_overage",
    Enforcement.soft_warn: "soft_warn",
    Enforcement.throttle: "throttle",
    Enforcement.notify: "notify",
}

_ALLOCATION = {
    UsageAllocation.account_pool: "account_pool",
    UsageAllocation.per_instance: "per_instance",
    UsageAllocation.per_user: "per_user",
    UsageAllocation.per_user_pooled: "per_user_pooled",
}

_PREDICATE_OP = {
    PredicateOp.eq: "eq",
    PredicateOp.neq: "neq",
    PredicateOp.gt: "gt",
    PredicateOp.lt: "lt",
    PredicateOp.gte: "gte",
    PredicateOp.lte: "lte",
    PredicateOp.contains: "contains",
    PredicateOp.in_: "in",
}

_RULE_TARGET_KIND = {
    RuleTargetKind.plan: "plan",
    RuleTargetKind.plan_variation: "plan_variation",
    RuleTargetKind.addon: "addon",
    RuleTargetKind.addon_variation: "addon_variation",
}

_PLACEMENT_CATEGORY = {
    PlacementCategory.fixed: "fixed",
    PlacementCategory.gated: "gated",
    PlacementCategory.usage_credit_seat: "usage_credit_seat",
    PlacementCategory.trials: "trials",
    PlacementCategory.other_conversion: "other_conversion",
    PlacementCategory.retention: "retention",
}

_CAP_PERIOD = {
    CapPeriod.session: "session",
    CapPeriod.day: "day",
    CapPeriod.week: "week",
    CapPeriod.month: "month",
    CapPeriod.lifetime: "lifetime",
}

_RECOMMENDATION_STRATEGY = {
    RecommendationStrategy.best_value: "best_value",
    RecommendationStrategy.custom: "custom",
    RecommendationStrategy.next_tier_up: "next_tier_up",
}

_TRIAL_TYPE = {TrialType.free: "free", TrialType.reverse: "reverse"}

_UI_PATH_ACTION = {
    UiPathActionType.open_checkout_modal: "open_checkout_modal",
    UiPathActionType.navigate_to_plans: "navigate_to_plans",
    UiPathActionType.open_upgrade_modal: "open_upgrade_modal",
    UiPathActionType.open_placement: "open_placement",
    UiPathActionType.book_demo: "book_demo",
    UiPathActionType.open_feature_tour: "open_feature_tour",
    UiPathActionType.extend_trial: "extend_trial",
    UiPathActionType.switch_billing_period: "switch_billing_period",
    UiPathActionType.custom_url: "custom_url",
    UiPathActionType.dismiss: "dismiss",
    UiPathActionType.contact_sales: "contact_sales",
    UiPathActionType.complete_onboarding: "complete_onboarding",
    UiPathActionType.invite_teammate: "invite_teammate",
    UiPathActionType.refer_friend: "refer_friend",
    UiPathActionType.verify_work_email: "verify_work_email",
    UiPathActionType.update_payment_method: "update_payment_method",
    UiPathActionType.enable_auto_renewal: "enable_auto_renewal",
    UiPathActionType.manage_subscription: "manage_subscription",
}

_BILLING_PERIOD = {BillingPeriod.monthly: "monthly", BillingPeriod.annual: "annual"}

_TOKEN_CATEGORY = {
    TokenCategory.user: "user",
    TokenCategory.plan: "plan",
    TokenCategory.usage: "usage",
    TokenCategory.trial: "trial",
    TokenCategory.billing: "billing",
    TokenCategory.promotion: "promotion",
    TokenCategory.custom: "custom",
}

_TOKEN_FORMAT = {
    TokenFormat.string_: "string",
    TokenFormat.number: "number",
    TokenFormat.currency: "currency",
    TokenFormat.percentage: "percentage",
    TokenFormat.date: "date",
}


def _int64_or_none(v: int) -> int | None:
    """int64 with the -1 'absent' sentinel -> int | None."""
    return None if v < 0 else v


def _decode_str(v: Any) -> str:
    """FlatBuffer string field -> str ('' when absent)."""
    if v is None:
        return ""
    if isinstance(v, (bytes, bytearray)):
        return v.decode("utf-8")
    return str(v)


# ── FB -> IR (inverse of encode.ts) ──────────────────────────────────────────


def decode_bundle_to_ir(root: RuleBundle) -> dict[str, Any]:
    """Read a compiled bundle root back into a BundleIR dict.

    The exact inverse of scaffold's ``encodeBundle`` — every field the encoder
    writes is read here.
    """

    def pool(i: int) -> str:
        if i < 0 or i >= root.StringPoolLength():
            return ""
        return _decode_str(root.StringPool(i))

    return {
        "header": _read_header(root),
        "predicate_fields": [
            _decode_str(root.PredicateFields(i)) for i in range(root.PredicateFieldsLength())
        ],
        "plans": [_read_plan(root.Plans(i), pool) for i in range(root.PlansLength())],
        "entitlements": [
            _read_entitlement(root.Entitlements(i), pool) for i in range(root.EntitlementsLength())
        ],
        "entitlement_rules": [
            _read_entitlement_rule(root.EntitlementRules(i), pool)
            for i in range(root.EntitlementRulesLength())
        ],
        "segments": [_read_segment(root.Segments(i), pool) for i in range(root.SegmentsLength())],
        "placement_slots": [
            _read_placement_slot(root.PlacementSlots(i), pool)
            for i in range(root.PlacementSlotsLength())
        ],
        "slot_configs": [
            _read_slot_config(root.SlotConfigs(i), pool) for i in range(root.SlotConfigsLength())
        ],
        "surface_templates": [
            _read_surface_template(root.SurfaceTemplates(i), pool)
            for i in range(root.SurfaceTemplatesLength())
        ],
        "placements": [
            _read_placement(root.Placements(i), pool) for i in range(root.PlacementsLength())
        ],
        "placement_payloads": [
            _read_placement_payload(root.PlacementPayloads(i), pool)
            for i in range(root.PlacementPayloadsLength())
        ],
        "content_ui_paths": [
            _read_content_ui_path(root.ContentUiPaths(i), pool)
            for i in range(root.ContentUiPathsLength())
        ],
        "content_promotions": [
            _read_content_promotion(root.ContentPromotions(i), pool)
            for i in range(root.ContentPromotionsLength())
        ],
        "personalization_tokens": [
            _read_personalization_token(root.PersonalizationTokens(i), pool)
            for i in range(root.PersonalizationTokensLength())
        ],
        "message_blocks": [
            _read_message_block(root.MessageBlocks(i), pool)
            for i in range(root.MessageBlocksLength())
        ],
        "slot_placement_index": _read_range_vector(
            root.SlotPlacementIndexLength(), root.SlotPlacementIndex
        ),
        "theme_json": _decode_str(root.ThemeJson()),
        "content_override_keys": [
            _decode_str(root.ContentOverrideKeys(i))
            for i in range(root.ContentOverrideKeysLength())
        ],
        "content_override_entries": [
            _read_content_override_entry(root.ContentOverrideEntries(i), pool)
            for i in range(root.ContentOverrideEntriesLength())
        ],
        "content_override_index": _read_range_vector(
            root.ContentOverrideIndexLength(), root.ContentOverrideIndex
        ),
        "compile_time_segment_keys": [
            _decode_str(root.CompileTimeSegmentKeys(i))
            for i in range(root.CompileTimeSegmentKeysLength())
        ],
        "compile_time_segment_members": [
            root.CompileTimeSegmentMembers(i) for i in range(root.CompileTimeSegmentMembersLength())
        ],
        "compile_time_segment_index": _read_range_vector(
            root.CompileTimeSegmentIndexLength(), root.CompileTimeSegmentIndex
        ),
        "extension_rules": [
            _read_extension_rule(root.ExtensionRules(i), pool)
            for i in range(root.ExtensionRulesLength())
        ],
        "seat_types": [
            _read_seat_type(root.SeatTypes(i), pool) for i in range(root.SeatTypesLength())
        ],
        "enforcement_defaults": [
            _read_enforcement_default(root.EnforcementDefaults(i), pool)
            for i in range(root.EnforcementDefaultsLength())
        ],
        "placement_settings": [
            _read_placement_setting(root.PlacementSettings(i), pool)
            for i in range(root.PlacementSettingsLength())
        ],
        "segment_dimensions": [
            _read_segment_dimension(root.SegmentDimensions(i), pool)
            for i in range(root.SegmentDimensionsLength())
        ],
        "meter_bindings": [
            _read_meter_binding(root.MeterBindings(i), pool)
            for i in range(root.MeterBindingsLength())
        ],
        "free_trial_rules": [
            _read_free_trial_rule(root.FreeTrialRules(i), pool)
            for i in range(root.FreeTrialRulesLength())
        ],
        "reverse_trial_rules": [
            _read_reverse_trial_rule(root.ReverseTrialRules(i), pool)
            for i in range(root.ReverseTrialRulesLength())
        ],
    }


def _read_range_vector(length: int, get: Any) -> list[dict[str, int]]:
    out: list[dict[str, int]] = []
    for i in range(length):
        r = get(i)
        out.append({"start": r.Start() if r else 0, "count": r.Count() if r else 0})
    return out


def _read_header(root: RuleBundle) -> dict[str, Any]:
    h = root.Header()
    if h is None:
        raise ValueError("decode_bundle_to_ir: header missing from bundle")
    return {
        "schema_version": h.SchemaVersion(),
        "runtime_abi": h.RuntimeAbi(),
        "config_version": _decode_str(h.ConfigVersion()),
        "exported_at_ms": h.ExportedAtMs(),
        "built_at_ms": h.BuiltAtMs(),
        "source_sha256": _decode_str(h.SourceSha256()),
        "tenant_id": _decode_str(h.TenantId()),
        "change_set_id": _decode_str(h.ChangeSetId()),
        "package_schema_version": _decode_str(h.PackageSchemaVersion()),
        "environment_id": _decode_str(h.EnvironmentId()),
        "playbook_handle": _decode_str(h.PlaybookHandle()),
    }


def _read_plan(p: Any, pool: Any) -> dict[str, Any]:
    return {
        "source_id": pool(p.SourceId()),
        "unique_handle": pool(p.UniqueHandle()),
        "name": pool(p.Name()),
        "tier_position": p.TierPosition(),
        "sort_order": p.SortOrder(),
    }


def _read_entitlement(e: Any, pool: Any) -> dict[str, Any]:
    tier_handles = [pool(e.TierHandles(j)) for j in range(e.TierHandlesLength())]
    return {
        "source_id": pool(e.SourceId()),
        "unique_handle": pool(e.UniqueHandle()),
        "name": pool(e.Name()),
        "type": _ENTITLEMENT_TYPE.get(e.Type(), "unknown"),
        "unit": pool(e.Unit()),
        "tier_handles": tier_handles,
    }


def _read_entitlement_rule(r: Any, pool: Any) -> dict[str, Any]:
    plan_idxs = [r.PlanIdxs(j) for j in range(r.PlanIdxsLength())]
    segment_idxs = [r.SegmentIdxs(j) for j in range(r.SegmentIdxsLength())]
    targets: list[dict[str, str]] = []
    for j in range(r.TargetsLength()):
        t = r.Targets(j)
        if t is not None:
            targets.append(
                {"kind": _RULE_TARGET_KIND.get(t.Kind(), "plan"), "id": _decode_str(t.Id())}
            )
    return {
        "source_id": pool(r.SourceId()),
        "entitlement_idx": r.EntitlementIdx(),
        "plan_idxs": plan_idxs,
        "segment_idxs": segment_idxs,
        "type_fields": _read_type_fields(r, pool),
        "allocation": _ALLOCATION.get(r.Allocation(), "unknown"),
        "targets": targets,
    }


def _read_type_fields(r: Any, pool: Any) -> dict[str, Any]:
    kind = r.TypeFieldsType()
    tbl = r.TypeFields()
    if kind == TypeFieldsUnion.FeatureFields:
        if tbl is None:
            return {"kind": "feature", "enabled": False}
        feat = FeatureFields()
        feat.Init(tbl.Bytes, tbl.Pos)
        return {"kind": "feature", "enabled": feat.Enabled()}
    if kind == TypeFieldsUnion.UsageLimitFields:
        if tbl is None:
            return {"kind": "usage_limit", "limit_value": None, "enforcement": "unknown"}
        usage = UsageLimitFields()
        usage.Init(tbl.Bytes, tbl.Pos)
        return {
            "kind": "usage_limit",
            "limit_value": _int64_or_none(usage.LimitValue()),
            "enforcement": _ENFORCEMENT.get(usage.Enforcement(), "unknown"),
        }
    if kind == TypeFieldsUnion.CreditsFields:
        if tbl is None:
            return {
                "kind": "credits",
                "allowance": None,
                "rollover": False,
                "max_balance": None,
                "initial_grant": None,
                "enforcement": "unknown",
            }
        credits = CreditsFields()
        credits.Init(tbl.Bytes, tbl.Pos)
        return {
            "kind": "credits",
            "allowance": _int64_or_none(credits.Allowance()),
            "rollover": credits.Rollover(),
            "max_balance": _int64_or_none(credits.MaxBalance()),
            "initial_grant": _int64_or_none(credits.InitialGrant()),
            "enforcement": _ENFORCEMENT.get(credits.Enforcement(), "unknown"),
        }
    if kind == TypeFieldsUnion.SeatsFields:
        if tbl is None:
            return {"kind": "seats", "included_count": None, "seat_type_source_id": ""}
        seats = SeatsFields()
        seats.Init(tbl.Bytes, tbl.Pos)
        return {
            "kind": "seats",
            "included_count": _int64_or_none(seats.IncludedCount()),
            "seat_type_source_id": pool(seats.SeatTypeSourceId()),
        }
    if kind == TypeFieldsUnion.TieredFields:
        if tbl is None:
            return {"kind": "tiered", "tier_value": ""}
        tiered = TieredFields()
        tiered.Init(tbl.Bytes, tbl.Pos)
        return {"kind": "tiered", "tier_value": pool(tiered.TierValue())}
    return {"kind": "feature", "enabled": False}


def _read_segment(s: Any, pool: Any) -> dict[str, Any]:
    predicates: list[dict[str, Any]] = []
    for j in range(s.PredicatesLength()):
        p = s.Predicates(j)
        if p is None:
            continue
        predicates.append(
            {
                "field_idx": p.FieldIdx(),
                "op": _PREDICATE_OP.get(p.Op(), "unknown"),
                "value": pool(p.Value()),
            }
        )
    return {
        "source_id": pool(s.SourceId()),
        "name": pool(s.Name()),
        "slug": pool(s.Slug()),
        "combinator": "or" if s.Combinator() == SegmentCombinator.or_ else "and",
        "predicates": predicates,
        "dimension_id": pool(s.DimensionId()),
    }


def _read_placement_slot(s: Any, pool: Any) -> dict[str, Any]:
    return {
        "source_id": pool(s.SourceId()),
        "label": pool(s.Label()),
        "description": pool(s.Description()),
        "surface_type": pool(s.SurfaceType()),
        "placement_handle": pool(s.PlacementHandle()),
        "template": pool(s.Template()),
    }


def _read_slot_config(c: Any, pool: Any) -> dict[str, Any]:
    triggers = [pool(c.Triggers(j)) for j in range(c.TriggersLength())]
    return {"slot_idx": c.SlotIdx(), "active": c.Active(), "triggers": triggers}


def _read_surface_template(t: Any, pool: Any) -> dict[str, Any]:
    fields: list[dict[str, Any]] = []
    for j in range(t.FieldsLength()):
        f = t.Fields(j)
        if f is None:
            continue
        fields.append({"name": pool(f.Name()), "type": pool(f.Type()), "required": f.Required()})
    return {
        "source_id": pool(t.SourceId()),
        "surface_type": pool(t.SurfaceType()),
        "fields": fields,
    }


def _read_placement(p: Any, pool: Any) -> dict[str, Any]:
    payloads = [_read_studio_payload(p.Payloads(j), pool) for j in range(p.PayloadsLength())]
    return {
        "source_id": pool(p.SourceId()),
        "name": pool(p.Name()),
        "category": _PLACEMENT_CATEGORY.get(p.Category(), "unknown"),
        "trigger": _read_trigger(p.Trigger(), pool),
        "payloads": payloads,
        "order": p.Order(),
    }


def _read_trigger(t: Any, pool: Any) -> dict[str, Any]:
    if t is None:
        return {"kind": "unknown"}
    from revturbine.bundle.TriggerType import TriggerType

    kind = t.Type()
    if kind == TriggerType.surface_render:
        return {"kind": "surface_render", "slot_idx": t.SlotIdx()}
    if kind == TriggerType.entitlement_gate:
        return {
            "kind": "entitlement_gate",
            "entitlement_idx": t.EntitlementIdx(),
            "tier_threshold": pool(t.TierThreshold()),
        }
    if kind == TriggerType.usage_threshold:
        return {
            "kind": "usage_threshold",
            "entitlement_idx": t.EntitlementIdx(),
            "threshold_percent": t.ThresholdPercent(),
        }
    if kind == TriggerType.credit_threshold:
        return {
            "kind": "credit_threshold",
            "entitlement_idx": t.EntitlementIdx(),
            "threshold_percent": t.ThresholdPercent(),
        }
    if kind == TriggerType.seat_threshold:
        return {
            "kind": "seat_threshold",
            "entitlement_idx": t.EntitlementIdx(),
            "threshold_percent": t.ThresholdPercent(),
        }
    if kind == TriggerType.trial_started:
        return {"kind": "trial_started", "trial_type": _TRIAL_TYPE.get(t.TrialType(), "none")}
    if kind == TriggerType.trial_progress:
        return {"kind": "trial_progress", "progress_percent": t.ProgressPercent()}
    if kind == TriggerType.trial_ending:
        return {"kind": "trial_ending", "days_before_end": t.DaysBeforeEnd()}
    if kind == TriggerType.trial_ended:
        return {"kind": "trial_ended"}
    if kind == TriggerType.trial_converted:
        return {"kind": "trial_converted"}
    if kind == TriggerType.qualifier:
        return {"kind": "qualifier", "qualifier": pool(t.Qualifier())}
    return {"kind": "unknown"}


def _read_studio_payload(p: Any, pool: Any) -> dict[str, Any]:
    surfaces = [_read_surface(p.Surfaces(j), pool) for j in range(p.SurfacesLength())]
    surface_slot_ids = [pool(p.SurfaceSlotIds(j)) for j in range(p.SurfaceSlotIdsLength())]
    return {
        "source_id": pool(p.SourceId()),
        "target": _read_target(p.Target(), pool),
        "surfaces": surfaces,
        "caps": _read_caps(p.Caps()),
        "created_at": pool(p.CreatedAt()),
        "recommendation_strategy": _RECOMMENDATION_STRATEGY.get(
            p.RecommendationStrategy(), "next_tier_up"
        ),
        "recommendation_plan_override": pool(p.RecommendationPlanOverride()),
        "surface_slot_ids": surface_slot_ids,
    }


def _read_target(t: Any, pool: Any) -> dict[str, Any]:
    if t is None:
        return {"plan_idxs": [], "segment_chips": [], "billing_cadences": []}
    plan_idxs = [t.PlanIdxs(j) for j in range(t.PlanIdxsLength())]
    chips: list[dict[str, Any]] = []
    for j in range(t.SegmentChipsLength()):
        c = t.SegmentChips(j)
        if c is None:
            continue
        chips.append(_read_chip(c, pool))
    cadences = [pool(t.BillingCadences(j)) for j in range(t.BillingCadencesLength())]
    return {"plan_idxs": plan_idxs, "segment_chips": chips, "billing_cadences": cadences}


def _read_chip(c: Any, pool: Any) -> dict[str, Any]:
    kind = c.Kind()
    if kind == SegmentChipKind.segment:
        return {"kind": "segment", "segment_idx": c.SegmentIdx()}
    if kind == SegmentChipKind.plan:
        return {"kind": "plan", "plan_idx": c.PlanIdx()}
    if kind == SegmentChipKind.literal:
        return {"kind": "literal", "value": pool(c.Literal())}
    return {"kind": "literal", "value": ""}


def _read_caps(c: Any) -> dict[str, Any]:
    if c is None:
        return {
            "has_max_per_period": False,
            "max_per_period_count": 0,
            "max_per_period": "unknown",
            "cooldown_days": -1,
        }
    return {
        "has_max_per_period": c.HasMaxPerPeriod(),
        "max_per_period_count": c.MaxPerPeriodCount(),
        "max_per_period": _CAP_PERIOD.get(c.MaxPerPeriod(), "unknown"),
        "cooldown_days": c.CooldownDays(),
    }


def _read_surface(s: Any, pool: Any) -> dict[str, Any]:
    fields: dict[str, str] = {}
    for j in range(s.FieldsLength()):
        f = s.Fields(j)
        if f is None:
            continue
        fields[pool(f.Key())] = pool(f.Value())
    ctas: list[dict[str, Any]] = []
    for j in range(s.CtasLength()):
        c = s.Ctas(j)
        if c is None:
            continue
        config: dict[str, str] = {}
        n = min(c.ConfigKeysLength(), c.ConfigValuesLength())
        for k in range(n):
            config[pool(c.ConfigKeys(k))] = pool(c.ConfigValues(k))
        ctas.append({"label": pool(c.Label()), "path": pool(c.Path()), "config": config})
    return {
        "template_idx": s.TemplateIdx(),
        "template_source_id": pool(s.TemplateSourceId()),
        "fields": fields,
        "ctas": ctas,
    }


def _read_placement_payload(p: Any, pool: Any) -> dict[str, Any]:
    surfaces = [_read_surface(p.Surfaces(j), pool) for j in range(p.SurfacesLength())]
    surface_slot_ids = [pool(p.SurfaceSlotIds(j)) for j in range(p.SurfaceSlotIdsLength())]
    cl = p.ContentLink()
    content_link = {
        "message_block_idx": cl.MessageBlockIdx() if cl else ABSENT_INDEX,
        "ui_path_idx": cl.UiPathIdx() if cl else 0,
        "promotion_idx": cl.PromotionIdx() if cl else 0,
        "content_payload_source_id": pool(cl.ContentPayloadSourceId()) if cl else "",
    }
    return {
        "source_id": pool(p.SourceId()),
        "placement_idx": p.PlacementIdx(),
        "placement_source_id": pool(p.PlacementSourceId()),
        "target": _read_target(p.Target(), pool),
        "caps": _read_caps(p.Caps()),
        "created_at": pool(p.CreatedAt()),
        "updated_at": pool(p.UpdatedAt()),
        "source_mode": "content_linked"
        if p.SourceMode() == PayloadSourceMode.content_linked
        else "inline",
        "surfaces": surfaces,
        "content_link": content_link,
        "surface_slot_ids": surface_slot_ids,
    }


def _read_content_ui_path(u: Any, pool: Any) -> dict[str, Any]:
    return {
        "name": pool(u.Name()),
        "action_type": _UI_PATH_ACTION.get(u.ActionType(), "unknown"),
        "plan_handle": pool(u.PlanHandle()),
        "promotion_idx": u.PromotionIdx(),
        "placement_handle": pool(u.PlacementHandle()),
        "url": pool(u.Url()),
        "tour_id": pool(u.TourId()),
        "target_billing_period": _BILLING_PERIOD.get(u.TargetBillingPeriod(), "unknown"),
        "description": pool(u.Description()),
    }


def _read_content_promotion(p: Any, pool: Any) -> dict[str, Any]:
    return {
        "source_id": pool(p.SourceId()),
        "name": pool(p.Name()),
        "discount": pool(p.Discount()),
        "type": pool(p.Type()),
        "status": pool(p.Status()),
    }


def _read_personalization_token(t: Any, pool: Any) -> dict[str, Any]:
    value_map: dict[str, str] = {}
    for j in range(t.ValueMapLength()):
        e = t.ValueMap(j)
        if e is None:
            continue
        value_map[pool(e.Key())] = pool(e.Value())
    return {
        "token": pool(t.Token()),
        "label": pool(t.Label()),
        "description": pool(t.Description()),
        "category": _TOKEN_CATEGORY.get(t.Category(), "unknown"),
        "data_source": pool(t.DataSource()),
        "example_value": pool(t.ExampleValue()),
        "value_map": value_map,
        "format": _TOKEN_FORMAT.get(t.Format(), "unknown"),
    }


def _read_message_block_content(c: Any, pool: Any) -> dict[str, Any]:
    if c is None:
        return {"header": "", "body": "", "cta_label": "", "secondary_cta_label": "", "extra": {}}
    extra: dict[str, str] = {}
    for j in range(c.ExtraLength()):
        f = c.Extra(j)
        if f is None:
            continue
        extra[pool(f.Key())] = pool(f.Value())
    return {
        "header": pool(c.Header()),
        "body": pool(c.Body()),
        "cta_label": pool(c.CtaLabel()),
        "secondary_cta_label": pool(c.SecondaryCtaLabel()),
        "extra": extra,
    }


def _read_message_block(b: Any, pool: Any) -> dict[str, Any]:
    from revturbine.bundle.MessageBlockStatus import MessageBlockStatus

    status_map = {
        MessageBlockStatus.draft: "draft",
        MessageBlockStatus.active: "active",
        MessageBlockStatus.archived: "archived",
    }
    overrides: list[dict[str, Any]] = []
    for j in range(b.SegmentOverridesLength()):
        o = b.SegmentOverrides(j)
        if o is None:
            continue
        overrides.append(
            {
                "segment_value": pool(o.SegmentValue()),
                "content": _read_message_block_content(o.Content(), pool),
            }
        )
    children: list[dict[str, Any]] = []
    for j in range(b.ChildBlocksLength()):
        c = b.ChildBlocks(j)
        if c is None:
            continue
        children.append(
            {
                "slot": pool(c.Slot()),
                "block_idx": c.BlockIdx(),
                "block_source_id": pool(c.BlockSourceId()),
            }
        )
    tokens_used = [pool(b.TokensUsed(j)) for j in range(b.TokensUsedLength())]
    return {
        "source_id": pool(b.SourceId()),
        "tenant_id": pool(b.TenantId()),
        "name": pool(b.Name()),
        "surface_template_idx": b.SurfaceTemplateIdx(),
        "default_content": _read_message_block_content(b.DefaultContent(), pool),
        "segment_overrides": overrides,
        "child_blocks": children,
        "tokens_used": tokens_used,
        "status": status_map.get(b.Status(), "unknown"),
        "created_at": pool(b.CreatedAt()),
        "updated_at": pool(b.UpdatedAt()),
    }


def _read_content_override_entry(e: Any, pool: Any) -> dict[str, str]:
    return {"key": pool(e.Key()), "value": pool(e.Value())}


def _read_extension_rule(e: Any, pool: Any) -> dict[str, Any]:
    length = e.ConfigLength()
    config = bytes(e.Config(i) for i in range(length))
    return {"kind": pool(e.Kind()), "schema_version": e.SchemaVersion(), "config": config}


def _read_seat_type(s: Any, pool: Any) -> dict[str, Any]:
    handles = [pool(s.EntitlementHandles(j)) for j in range(s.EntitlementHandlesLength())]
    return {
        "handle": pool(s.Handle()),
        "name": pool(s.Name()),
        "is_default": s.IsDefault(),
        "entitlement_handles": handles,
    }


def _read_enforcement_default(e: Any, pool: Any) -> dict[str, Any]:
    channels = [pool(e.NotificationChannels(j)) for j in range(e.NotificationChannelsLength())]
    return {
        "handle": pool(e.Handle()),
        "entitlement_handle": pool(e.EntitlementHandle()),
        "soft_limit_percent": _int64_or_none(e.SoftLimitPercent()),
        "hard_limit_percent": _int64_or_none(e.HardLimitPercent()),
        "soft_limit_action": pool(e.SoftLimitAction()),
        "hard_limit_action": pool(e.HardLimitAction()),
        "grace_period_hours": _int64_or_none(e.GracePeriodHours()),
        "notification_channels": channels,
        "is_active": e.IsActive(),
    }


def _read_placement_setting(p: Any, pool: Any) -> dict[str, Any]:
    return {
        "handle": pool(p.Handle()),
        "global_frequency_cap": pool(p.GlobalFrequencyCap()),
        "global_frequency_cap_period": pool(p.GlobalFrequencyCapPeriod()),
        "suppress_for_paid": p.SuppressForPaid(),
        "suppress_for_trial": p.SuppressForTrial(),
        "default_dismiss_cooldown_hours": _int64_or_none(p.DefaultDismissCooldownHours()),
        "allow_stacking": p.AllowStacking(),
        "priority_collision_strategy": pool(p.PriorityCollisionStrategy()),
    }


def _read_segment_dimension(d: Any, pool: Any) -> dict[str, Any]:
    return {
        "handle": pool(d.Handle()),
        "name": pool(d.Name()),
        "category": pool(d.Category()),
        "visibility_toggle": d.VisibilityToggle(),
        "source_type": pool(d.SourceType()),
    }


def _read_meter_binding(m: Any, pool: Any) -> dict[str, Any]:
    return {
        "handle": pool(m.Handle()),
        "entitlement_handle": pool(m.EntitlementHandle()),
        "meter_handle": pool(m.MeterHandle()),
        "limit": _int64_or_none(m.Limit()),
        "reset_period": pool(m.ResetPeriod()),
    }


def _read_free_trial_rule(t: Any, pool: Any) -> dict[str, Any]:
    return {
        "source_id": pool(t.SourceId()),
        "handle": pool(t.Handle()),
        "plan_id": pool(t.PlanId()),
        "usage_entitlement_handle": pool(t.UsageEntitlementHandle()),
        "usage_limit_value": _int64_or_none(t.UsageLimitValue()),
    }


def _read_reverse_trial_rule(t: Any, pool: Any) -> dict[str, Any]:
    ents = [pool(t.EntitlementsDuringTrial(j)) for j in range(t.EntitlementsDuringTrialLength())]
    return {
        "source_id": pool(t.SourceId()),
        "handle": pool(t.Handle()),
        "premium_plan_id": pool(t.PremiumPlanId()),
        "fallback_plan_id": pool(t.FallbackPlanId()),
        "entitlements_during_trial": ents,
        "is_active": t.IsActive(),
        "usage_entitlement_handle": pool(t.UsageEntitlementHandle()),
        "usage_limit_value": _int64_or_none(t.UsageLimitValue()),
    }


# ── IR -> Playbook (inverse of lowerToIR) ────────────────────────────────────

# config EntitlementTypeSchema names. IR `unknown` -> `price_per_unit` (a config
# type that re-normalizes to `unknown`, so the round trip holds).
_CONFIG_ENTITLEMENT_TYPE = {
    "feature": "feature",
    "usage_limit": "usage_limit",
    "credits": "credits",
    "seats": "seat",
    "tiered": "capability_tier",
}
_CONFIG_ENFORCEMENT = {"hard_block", "soft_block", "degrade", "allow_overage"}


def ir_to_playbook(ir: dict[str, Any]) -> dict[str, Any]:
    """Reconstruct the canonical Playbook dict from a decoded BundleIR.

    The inverse of ``lowerToIR``: table indexes resolve back to handles, IR enums
    and the flat ``type_fields`` union map back to config shapes, and fields the
    bundle drops but the schema requires (tier / trial ``name``, credits
    ``reset_period``) are synthesized.
    """
    plans = ir["plans"]
    entitlements = ir["entitlements"]
    segments = ir["segments"]
    slots = ir["placement_slots"]
    blocks = ir["message_blocks"]
    promotions = ir["content_promotions"]
    ui_paths = ir["content_ui_paths"]

    def plan_handle(i: int) -> str:
        return plans[i]["unique_handle"] if 0 <= i < len(plans) else ""

    def ent_handle(i: int) -> str:
        return entitlements[i]["unique_handle"] if 0 <= i < len(entitlements) else ""

    def seg_slug(i: int) -> str:
        return segments[i]["slug"] if 0 <= i < len(segments) else ""

    def slot_id(i: int) -> str:
        return slots[i]["source_id"] if 0 <= i < len(slots) else ""

    def block_id(i: int) -> str:
        return blocks[i]["source_id"] if 0 <= i < len(blocks) else ""

    def promo_id(i: int) -> str:
        return promotions[i]["source_id"] if 0 <= i < len(promotions) else ""

    def ui_path_name(i: int) -> str:
        return ui_paths[i]["name"] if 0 <= i < len(ui_paths) else ""

    h = ir["header"]
    raw: dict[str, Any] = {
        "artifact_type": "playbook",
        "format_version": h["config_version"],
        "playbook_version_id": None if h["change_set_id"] == "" else h["change_set_id"],
    }
    if h["playbook_handle"]:
        raw["playbook_handle"] = h["playbook_handle"]
    if h["environment_id"]:
        raw["environment_id"] = h["environment_id"]
    if h["tenant_id"]:
        raw["tenant_id"] = h["tenant_id"]
    if h["package_schema_version"]:
        raw["schema_version"] = h["package_schema_version"]
    if h["exported_at_ms"]:
        raw["exported_at"] = _ms_to_iso(h["exported_at_ms"])

    raw["plans"] = [
        {
            "unique_handle": p["unique_handle"],
            "name": p["name"],
            "tier_position": p["tier_position"],
            "sort_order": p["sort_order"],
        }
        for p in plans
    ]

    raw["entitlements"] = [_entitlement_to_config(e) for e in entitlements]

    raw["entitlement_rules"] = [
        _rule_to_config(r, ent_handle, plan_handle, seg_slug) for r in ir["entitlement_rules"]
    ]

    raw["segments"] = [_segment_to_config(s, ir["predicate_fields"]) for s in segments]

    raw["content_ui_paths"] = [_ui_path_to_config(u, promo_id) for u in ui_paths]

    if slots:
        raw["placement_slots"] = [_slot_to_config(s) for s in slots]

    if ir["surface_templates"]:
        raw["surface_templates"] = [_surface_template_to_config(t) for t in ir["surface_templates"]]

    if ir["placements"]:
        raw["placements"] = [
            _placement_to_config(p, slot_id, ent_handle, plan_handle, seg_slug)
            for p in ir["placements"]
        ]

    if ir["placement_payloads"]:
        raw["placement_payloads"] = [
            _placement_payload_to_config(p, plan_handle, seg_slug, block_id, promo_id, ui_path_name)
            for p in ir["placement_payloads"]
        ]

    if promotions:
        raw["content_promotions"] = [
            {
                "id": p["source_id"],
                "name": p["name"],
                "discount": p["discount"],
                "type": p["type"],
                "status": p["status"],
            }
            for p in promotions
        ]

    if ir["personalization_tokens"]:
        raw["personalization_tokens"] = [_token_to_config(t) for t in ir["personalization_tokens"]]

    if blocks:
        raw["message_blocks"] = [
            _block_to_config(b, ir["surface_templates"], block_id) for b in blocks
        ]

    if ir["slot_configs"]:
        raw["slot_configs"] = [
            {
                "slot_id": slot_id(c["slot_idx"]),
                "active": c["active"],
                "triggers": list(c["triggers"]),
            }
            for c in ir["slot_configs"]
        ]

    if ir["seat_types"]:
        raw["seat_types"] = [
            {
                "handle": s["handle"],
                "name": s["name"],
                "is_default": s["is_default"],
                "entitlement_handles": list(s["entitlement_handles"]),
            }
            for s in ir["seat_types"]
        ]

    if ir["enforcement_defaults"]:
        raw["enforcement_defaults"] = [
            {
                "handle": e["handle"],
                "entitlement_handle": None
                if e["entitlement_handle"] == ""
                else e["entitlement_handle"],
                "soft_limit_percent": e["soft_limit_percent"],
                "hard_limit_percent": e["hard_limit_percent"],
                "soft_limit_action": e["soft_limit_action"],
                "hard_limit_action": e["hard_limit_action"],
                "grace_period_hours": e["grace_period_hours"],
                "notification_channels": list(e["notification_channels"]),
                "is_active": e["is_active"],
            }
            for e in ir["enforcement_defaults"]
        ]

    if ir["placement_settings"]:
        raw["placement_settings"] = [
            _placement_setting_to_config(p) for p in ir["placement_settings"]
        ]

    if ir["segment_dimensions"]:
        raw["segment_dimensions"] = [
            {
                "handle": d["handle"],
                "name": d["name"],
                "category": None if d["category"] == "" else d["category"],
                "visibility_toggle": d["visibility_toggle"],
                "source_type": None if d["source_type"] == "" else d["source_type"],
            }
            for d in ir["segment_dimensions"]
        ]

    if ir["meter_bindings"]:
        raw["meter_bindings"] = [
            {
                "handle": m["handle"],
                "entitlement_handle": m["entitlement_handle"],
                "meter_handle": m["meter_handle"],
                "limit": m["limit"],
                "reset_period": None if m["reset_period"] == "" else m["reset_period"],
            }
            for m in ir["meter_bindings"]
        ]

    if ir["free_trial_rules"]:
        raw["free_trial_rules"] = [_free_trial_to_config(t) for t in ir["free_trial_rules"]]

    if ir["reverse_trial_rules"]:
        raw["reverse_trial_rules"] = [
            _reverse_trial_to_config(t) for t in ir["reverse_trial_rules"]
        ]

    if ir["theme_json"]:
        import json

        raw["theme"] = json.loads(ir["theme_json"])

    if ir["content_override_keys"]:
        overrides: dict[str, dict[str, str]] = {}
        for i, key in enumerate(ir["content_override_keys"]):
            rng = ir["content_override_index"][i] if i < len(ir["content_override_index"]) else None
            inner: dict[str, str] = {}
            if rng:
                for j in range(rng["start"], rng["start"] + rng["count"]):
                    entry = ir["content_override_entries"][j]
                    inner[entry["key"]] = entry["value"]
            overrides[key] = inner
        raw["content_overrides"] = overrides

    return raw


def _ms_to_iso(ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + (
        f"{ms % 1000:03d}Z"
    )


def _config_enforcement(e: str) -> str | None:
    return e if e in _CONFIG_ENFORCEMENT else None


def _entitlement_to_config(e: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "unique_handle": e["unique_handle"],
        "name": e["name"],
        "type": _CONFIG_ENTITLEMENT_TYPE.get(e["type"], "price_per_unit"),
    }
    if e["unit"]:
        out["unit"] = e["unit"]
    if e["tier_handles"]:
        out["tier_definitions"] = [
            {"handle": handle, "name": handle} for handle in e["tier_handles"]
        ]
    return out


def _assign_type_fields(out: dict[str, Any], tf: dict[str, Any]) -> None:
    kind = tf["kind"]
    if kind == "feature":
        out["enabled"] = tf["enabled"]
    elif kind == "usage_limit":
        out["limit_value"] = "unlimited" if tf["limit_value"] is None else tf["limit_value"]
        enf = _config_enforcement(tf["enforcement"])
        if enf:
            out["enforcement"] = enf
    elif kind == "credits":
        if tf["allowance"] is not None:
            out["allowance_value"] = tf["allowance"]
            # The credits refine requires a reset cadence for a non-zero recurring
            # allowance. `reset_period` is not lowered into the bundle, so synthesize
            # a valid cadence — IR-round-trip-safe (lowerToIR drops it again).
            if tf["allowance"] > 0:
                out["reset_period"] = "month"
        out["rollover_enabled"] = tf["rollover"]
        out["max_balance"] = tf["max_balance"]
        if tf["initial_grant"] is not None:
            out["initial_grant"] = tf["initial_grant"]
        enf = _config_enforcement(tf["enforcement"])
        if enf:
            out["enforcement"] = enf
    elif kind == "seats":
        out["included_count"] = (
            "unlimited" if tf["included_count"] is None else tf["included_count"]
        )
        if tf["seat_type_source_id"]:
            out["seat_type_id"] = tf["seat_type_source_id"]
    elif kind == "tiered" and tf["tier_value"]:
        out["tier_value"] = tf["tier_value"]


def _rule_to_config(
    r: dict[str, Any], ent_handle: Any, plan_handle: Any, seg_slug: Any
) -> dict[str, Any]:
    out: dict[str, Any] = {"id": r["source_id"], "entitlement_id": ent_handle(r["entitlement_idx"])}
    out["targets"] = (
        [{"kind": t["kind"], "id": t["id"]} for t in r["targets"]]
        if r["targets"]
        else [{"kind": "plan", "id": plan_handle(i)} for i in r["plan_idxs"]]
    )
    out["segment_ids"] = [seg_slug(i) for i in r["segment_idxs"]]
    if r["allocation"] != "unknown":
        out["allocation"] = r["allocation"]
    _assign_type_fields(out, r["type_fields"])
    return out


def _segment_to_config(s: dict[str, Any], predicate_fields: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "name": s["name"],
        "handle": s["slug"],
        "predicates": [
            {
                "field": predicate_fields[p["field_idx"]]
                if p["field_idx"] < len(predicate_fields)
                else "",
                "operator": "eq" if p["op"] == "unknown" else p["op"],
                "value": p["value"],
            }
            for p in s["predicates"]
        ],
    }
    if s["dimension_id"]:
        out["dimension_id"] = s["dimension_id"]
    return out


def _ui_path_to_config(u: dict[str, Any], promo_id: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "name": u["name"],
        "action_type": "custom_url" if u["action_type"] == "unknown" else u["action_type"],
    }
    if u["plan_handle"]:
        out["plan_handle"] = u["plan_handle"]
    if u["promotion_idx"] != ABSENT_INDEX:
        out["promotion_id"] = promo_id(u["promotion_idx"])
    if u["placement_handle"]:
        out["placement_handle"] = u["placement_handle"]
    if u["url"]:
        out["url"] = u["url"]
    if u["tour_id"]:
        out["tour_id"] = u["tour_id"]
    if u["target_billing_period"] != "unknown":
        out["target_billing_period"] = u["target_billing_period"]
    if u["description"]:
        out["description"] = u["description"]
    return out


def _slot_to_config(s: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": s["source_id"],
        "label": s["label"],
        "description": s["description"],
        "surface_type": s["surface_type"],
        "placement_handle": s["placement_handle"],
    }
    if s["template"]:
        out["template"] = s["template"]
    return out


def _surface_template_to_config(t: dict[str, Any]) -> dict[str, Any]:
    fields: list[dict[str, Any]] = []
    for f in t["fields"]:
        item: dict[str, Any] = {"name": f["name"], "required": f["required"]}
        if f["type"]:
            item["type"] = f["type"]
        fields.append(item)
    return {"id": t["source_id"], "surface_type": t["surface_type"], "fields": fields}


def _trigger_to_config(t: dict[str, Any], slot_id: Any, ent_handle: Any) -> dict[str, Any]:
    kind = t["kind"]
    if kind == "surface_render":
        return {"type": "surface_render", "slot_id": slot_id(t["slot_idx"])}
    if kind == "entitlement_gate":
        out: dict[str, Any] = {
            "type": "entitlement_gate",
            "entitlement_handle": ent_handle(t["entitlement_idx"]),
        }
        if t["tier_threshold"]:
            out["tier_threshold"] = t["tier_threshold"]
        return out
    if kind in ("usage_threshold", "credit_threshold", "seat_threshold"):
        return {
            "type": kind,
            "entitlement_handle": ent_handle(t["entitlement_idx"]),
            "threshold_percent": t["threshold_percent"],
        }
    if kind == "trial_started":
        out2: dict[str, Any] = {"type": "trial_started"}
        if t["trial_type"] != "none":
            out2["trial_type"] = t["trial_type"]
        return out2
    if kind == "trial_progress":
        return {"type": "trial_progress", "progress_percent": t["progress_percent"]}
    if kind == "trial_ending":
        return {"type": "trial_ending", "days_before_end": t["days_before_end"]}
    if kind == "trial_ended":
        return {"type": "trial_ended"}
    if kind == "trial_converted":
        return {"type": "trial_converted"}
    if kind == "qualifier":
        return {"type": "qualifier", "qualifier": t["qualifier"]}
    return {"type": "surface_render", "slot_id": ""}


def _target_to_config(t: dict[str, Any], plan_handle: Any, seg_slug: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "plan_ids": [plan_handle(i) for i in t["plan_idxs"]],
        "segment_chips": [
            seg_slug(c["segment_idx"])
            if c["kind"] == "segment"
            else plan_handle(c["plan_idx"])
            if c["kind"] == "plan"
            else c["value"]
            for c in t["segment_chips"]
        ],
    }
    if t["billing_cadences"]:
        out["billing_cadences"] = list(t["billing_cadences"])
    return out


def _surface_to_config(s: dict[str, Any]) -> dict[str, Any]:
    ctas: list[dict[str, Any]] = []
    for c in s["ctas"]:
        item: dict[str, Any] = {"label": c["label"], "path": c["path"]}
        if c["config"]:
            item["config"] = dict(c["config"])
        ctas.append(item)
    return {"template_id": s["template_source_id"], "fields": dict(s["fields"]), "ctas": ctas}


def _caps_to_config(c: dict[str, Any]) -> dict[str, Any] | None:
    out: dict[str, Any] = {}
    if c["has_max_per_period"] and c["max_per_period"] != "unknown":
        out["max_per_period"] = {"count": c["max_per_period_count"], "period": c["max_per_period"]}
    if c["cooldown_days"] != -1:
        out["cooldown_days"] = c["cooldown_days"]
    return out or None


def _studio_payload_to_config(p: dict[str, Any], plan_handle: Any, seg_slug: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": p["source_id"],
        "target": _target_to_config(p["target"], plan_handle, seg_slug),
        "surfaces": [_surface_to_config(s) for s in p["surfaces"]],
    }
    caps = _caps_to_config(p["caps"])
    if caps:
        out["caps"] = caps
    if p["created_at"]:
        out["created_at"] = p["created_at"]
    if p["recommendation_strategy"] != "next_tier_up":
        out["recommendation_strategy"] = p["recommendation_strategy"]
    if p["recommendation_plan_override"]:
        out["recommendation_plan_override"] = p["recommendation_plan_override"]
    if p["surface_slot_ids"]:
        out["surface_slot_ids"] = list(p["surface_slot_ids"])
    return out


def _placement_to_config(
    p: dict[str, Any], slot_id: Any, ent_handle: Any, plan_handle: Any, seg_slug: Any
) -> dict[str, Any]:
    return {
        "id": p["source_id"],
        "name": p["name"],
        "category": "fixed" if p["category"] == "unknown" else p["category"],
        "trigger": _trigger_to_config(p["trigger"], slot_id, ent_handle),
        "payloads": [
            _studio_payload_to_config(pay, plan_handle, seg_slug) for pay in p["payloads"]
        ],
        "order": p["order"],
    }


def _placement_payload_to_config(
    p: dict[str, Any],
    plan_handle: Any,
    seg_slug: Any,
    block_id: Any,
    promo_id: Any,
    ui_path_name: Any,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "payload_id": p["source_id"],
        "placement_id": p["placement_source_id"],
        "target": _target_to_config(p["target"], plan_handle, seg_slug),
        "created_at": p["created_at"],
        "source_mode": p["source_mode"],
        "surfaces": [_surface_to_config(s) for s in p["surfaces"]],
    }
    if p["updated_at"]:
        out["updated_at"] = p["updated_at"]
    caps = _caps_to_config(p["caps"])
    if caps:
        out["caps"] = caps
    if p["surface_slot_ids"]:
        out["surface_slot_ids"] = list(p["surface_slot_ids"])
    cl = p["content_link"]
    link: dict[str, Any] = {}
    if cl["message_block_idx"] != ABSENT_INDEX:
        link["message_block_id"] = block_id(cl["message_block_idx"])
    if cl["ui_path_idx"] != ABSENT_INDEX:
        link["ui_path_id"] = ui_path_name(cl["ui_path_idx"])
    if cl["promotion_idx"] != ABSENT_INDEX:
        link["promotion_id"] = promo_id(cl["promotion_idx"])
    if cl["content_payload_source_id"]:
        link["content_payload_id"] = cl["content_payload_source_id"]
    if link:
        out["content_link"] = link
    return out


def _token_to_config(t: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"token": t["token"], "label": t["label"]}
    if t["description"]:
        out["description"] = t["description"]
    if t["category"] != "unknown":
        out["category"] = t["category"]
    if t["data_source"]:
        out["data_source"] = t["data_source"]
    if t["example_value"]:
        out["example_value"] = t["example_value"]
    if t["value_map"]:
        out["value_map"] = dict(t["value_map"])
    if t["format"] != "unknown":
        out["format"] = t["format"]
    return out


def _content_to_config(c: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = dict(c["extra"])
    if c["header"]:
        out["header"] = c["header"]
    if c["body"]:
        out["body"] = c["body"]
    if c["cta_label"]:
        out["cta_label"] = c["cta_label"]
    if c["secondary_cta_label"]:
        out["secondary_cta_label"] = c["secondary_cta_label"]
    return out


def _block_to_config(
    b: dict[str, Any], surface_templates: list[dict[str, Any]], block_id: Any
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "block_id": b["source_id"],
        "tenant_id": b["tenant_id"],
        "name": b["name"],
        "default_content": _content_to_config(b["default_content"]),
        "status": "draft" if b["status"] == "unknown" else b["status"],
        "created_at": b["created_at"],
        "updated_at": b["updated_at"],
    }
    if b["surface_template_idx"] != ABSENT_INDEX:
        idx = b["surface_template_idx"]
        out["surface_template_id"] = (
            surface_templates[idx]["source_id"] if 0 <= idx < len(surface_templates) else ""
        )
    if b["segment_overrides"]:
        out["segment_overrides"] = [
            {"segment_value_id": o["segment_value"], "content": _content_to_config(o["content"])}
            for o in b["segment_overrides"]
        ]
    if b["child_blocks"]:
        out["child_blocks"] = [
            {
                "slot": c["slot"],
                "block_id": c["block_source_id"]
                if c["block_idx"] == ABSENT_INDEX
                else block_id(c["block_idx"]),
            }
            for c in b["child_blocks"]
        ]
    if b["tokens_used"]:
        out["tokens_used"] = list(b["tokens_used"])
    return out


def _placement_setting_to_config(p: dict[str, Any]) -> dict[str, Any]:
    import json

    return {
        "handle": p["handle"],
        "global_frequency_cap": None
        if p["global_frequency_cap"] == ""
        else json.loads(p["global_frequency_cap"]),
        "global_frequency_cap_period": None
        if p["global_frequency_cap_period"] == ""
        else p["global_frequency_cap_period"],
        "suppress_for_paid": p["suppress_for_paid"],
        "suppress_for_trial": p["suppress_for_trial"],
        "default_dismiss_cooldown_hours": p["default_dismiss_cooldown_hours"],
        "allow_stacking": p["allow_stacking"],
        "priority_collision_strategy": None
        if p["priority_collision_strategy"] == ""
        else p["priority_collision_strategy"],
    }


def _free_trial_to_config(t: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"id": t["source_id"], "handle": t["handle"], "name": t["handle"]}
    if t["plan_id"]:
        out["plan_id"] = t["plan_id"]
    if t["usage_entitlement_handle"]:
        out["usage_entitlement_handle"] = t["usage_entitlement_handle"]
    if t["usage_limit_value"] is not None:
        out["usage_limit_value"] = t["usage_limit_value"]
    return out


def _reverse_trial_to_config(t: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": t["source_id"],
        "handle": t["handle"],
        "name": t["handle"],
        "premium_plan_id": t["premium_plan_id"],
        "fallback_plan_id": t["fallback_plan_id"],
        "is_active": t["is_active"],
    }
    if t["entitlements_during_trial"]:
        out["entitlements_during_trial"] = list(t["entitlements_during_trial"])
    if t["usage_entitlement_handle"]:
        out["usage_entitlement_handle"] = t["usage_entitlement_handle"]
    if t["usage_limit_value"] is not None:
        out["usage_limit_value"] = t["usage_limit_value"]
    return out


# ── Public API ───────────────────────────────────────────────────────────────


def bundle_to_playbook(data: bytes) -> Playbook:
    """Decode a compiled ``.rvtb`` bundle back to the canonical Playbook dict.

    The Python mirror of scaffold's ``bundleToPlaybook`` — the server SDK
    downloads the compact bundle, decodes it here, and feeds the result to the
    same evaluator used for JSON configs, so decisions are identical by
    construction (enforced by the cross-language parity corpus).
    """
    root = RuleBundle.GetRootAs(bytes(data), 0)
    return ir_to_playbook(decode_bundle_to_ir(root))
