"""Static placement resolver — Python port of
@revt-eng/placements/controllers/local-resolver.ts.

Builds a sync :data:`PlacementResolver` from a static dataset
(``ExportedConfig`` + a placement list). Decides locally without a
server: plan-target filtering, slot-metadata narrowing, impression-
history suppression, usage-token injection, and content token
interpolation.

Per Q-5 the resolver is sync (the TS source is ``async`` only because
its signature allows ``Promise``; the body has no awaits). HTTP-mode
async resolution would add an ``aresolve`` variant in TASK-7.

``ExportedConfig`` / placement entries stay loosely typed
(``dict[str, Any]``) — the strongly-typed Pydantic models would couple
this module to the generated ``revturbine_types`` package, which
server-python doesn't vendor until TASK-7. The parity suite
(TASK-8/9/10) is the backstop against schema drift.

Source: revturbine-scaffold/src/placements/controllers/local-resolver.ts
"""

from __future__ import annotations

import math
import re
import time
from typing import Any, TypedDict

from revturbine.core.decisions.types import (
    DecisionContent,
    PlacementDecision,
    PlacementDecisionInput,
    PlacementRecord,
    PlacementResolver,
)
from revturbine.core.helpers import PlacementOutput, is_record
from revturbine.core.placements.payload_resolution import (
    PlacementContentLookupProvider,
    create_static_placement_content_lookup_provider,
    resolve_payload_for_user_with_provider,
)
from revturbine.core.placements.trial_gating import (
    TrialCandidate,
    apply_milestone_supersession,
    compute_user_elapsed_percent,
    matches_trial_trigger,
    normalize_json_trigger,
)
from revturbine.core.rules.plan_eligibility import evaluate_plan_eligibility
from revturbine.core.state.impression_history import ImpressionHistory

__all__ = [
    "ExportedConfig",
    "LocalPlacementDataset",
    "LocalPlacementEntry",
    "create_static_placement_resolver",
]

# Loose aliases — tightened to generated Pydantic models in TASK-7.
ExportedConfig = dict[str, Any]
LocalPlacementEntry = dict[str, Any]


class LocalPlacementDataset(TypedDict):
    """The static placement list. Mirrors the TS
    ``LocalPlacementDataset { placements: LocalPlacementEntry[] }``.
    """

    placements: list[LocalPlacementEntry]


class _CandidateOutput(TypedDict):
    """Index entry — a built output plus the entry hints used to narrow
    candidates. Mirrors the TS ``CandidateOutput`` interface.

    ``trial_trigger`` is the normalized TrialTriggerShape produced by
    ``normalize_json_trigger``; ``None`` for non-trial triggers — those
    pass through trial-gating untouched.

    Source: local-resolver.ts:148-155 + trial-gating.ts:36 (plan 43)
    """

    output: PlacementOutput
    entry_order: Any
    entry_category: Any
    trigger_entitlement_handle: str | None
    trigger_slot_id: str | None
    trial_trigger: Any  # TrialTriggerShape | None — see trial_gating.py


# Source: local-resolver.ts:51-60
DEFAULT_TEMPLATE_TO_SURFACE: dict[str, str] = {
    "modal_overlay": "modal",
    "banner_placement": "banner",
    "in_page_card": "in_page",
    "inline_gate_message": "in_page",
    "usage_counter": "in_page",
    "button": "button",
    "email": "email",
    "full_page": "full_page",
}


def _read_entitlement_handle_from_trigger(trigger: Any) -> str | None:
    """Source: local-resolver.ts:28-34"""
    if not is_record(trigger) or "entitlement_handle" not in trigger:
        return None
    value = trigger["entitlement_handle"]
    return value if isinstance(value, str) else None


def _read_slot_id_from_trigger(trigger: Any) -> str | None:
    """Source: local-resolver.ts:36-42"""
    if not is_record(trigger) or "slot_id" not in trigger:
        return None
    value = trigger["slot_id"]
    return value if isinstance(value, str) else None


def _js_string(value: Any) -> str:
    """JavaScript ``String(value)`` coercion for token substitution.

    ``None`` is never reached here (the caller leaves the literal token
    in place for ``null``/``undefined``), but it is handled for parity
    with the shared ``_js_string`` in ``payload_resolution``.
    """
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _js_math_round(value: float) -> int:
    """JS ``Math.round`` — round half toward +Infinity.

    ``Math.round(0.5) === 1``, ``Math.round(-0.5) === 0``,
    ``Math.round(2.5) === 3``. ``math.floor(x + 0.5)`` reproduces this
    for every finite input (Python's built-in ``round`` is banker's
    rounding and would diverge on ``.5`` ties).
    """
    return math.floor(value + 0.5)


_TOKEN_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")


def _interpolate_string_tokens(template: str, tokens: dict[str, Any]) -> str:
    """Replace ``{{ token }}`` markers from ``tokens``. An absent or
    ``None`` value leaves the (whitespace-collapsed) literal in place,
    matching the TS ``value === undefined || value === null`` guard.

    Source: local-resolver.ts:62-67
    """

    def _sub(match: re.Match[str]) -> str:
        key = match.group(1)
        value = tokens.get(key)
        return f"{{{{{key}}}}}" if value is None else _js_string(value)

    return _TOKEN_RE.sub(_sub, template)


def _interpolate_content_tokens(content: dict[str, Any]) -> dict[str, Any]:
    """Interpolate only string-valued content fields, using the content
    dict itself as the token source. Non-string values pass through
    untouched.

    Source: local-resolver.ts:69-79
    """
    resolved: dict[str, Any] = {}
    for key, value in content.items():
        if isinstance(value, str):
            resolved[key] = _interpolate_string_tokens(value, content)
            continue
        resolved[key] = value
    return resolved


def _normalize_cta_path(cta: Any) -> dict[str, Any]:
    """Map a raw CTA ``{path, config}`` to the resolved ``cta_path``
    shape. ``plan_handle`` / ``placement_handle`` are omitted (not set
    to ``None``) when the source config field isn't a string — this
    matches JS ``JSON.stringify`` dropping ``undefined`` properties so
    serialized parity holds.

    Source: local-resolver.ts:81-118
    """
    if not is_record(cta) or not cta.get("path"):
        return {"type": "dismiss"}

    raw_path = cta["path"]
    config = cta.get("config")
    if not is_record(config):
        config = {}

    if raw_path == "open_checkout":
        result: dict[str, Any] = {"type": "open_checkout_modal"}
        purchase = config.get("purchase")
        if isinstance(purchase, str):
            result["plan_handle"] = purchase
        return result

    if raw_path == "view_plans":
        return {"type": "navigate_to_plans"}

    if raw_path == "snooze_remind_later":
        return {"type": "dismiss"}

    if raw_path == "open_rt_placement":
        rt_result: dict[str, Any] = {"type": "open_rt_placement"}
        placement_handle = config.get("placement_handle")
        if isinstance(placement_handle, str):
            rt_result["placement_handle"] = placement_handle
        return rt_result

    # Custom and any other unmapped action: pass the authored action name
    # through as ``type`` and spread its config so a custom CTA's params reach
    # the SDK resolver. Mirrors local-resolver.ts.
    return {"type": raw_path, **config}


def _decision_content(header: str, body: str, cta_label: str) -> DecisionContent:
    """Header/body/cta mirrored across legacy + canonical naming, same
    shape the TS resolver emits (``title``=header, ``cta``=cta_label).
    """
    return DecisionContent(
        header=header,
        body=body,
        cta_label=cta_label,
        title=header,
        cta=cta_label,
    )


def _header_str(value: Any) -> str:
    """TS ``headerStr`` — coerce non-strings to ``''``."""
    return value if isinstance(value, str) else ""


def _is_finite_number(value: Any) -> bool:
    """JS ``Number.isFinite`` — true only for finite real numbers (no
    string coercion, ``bool`` excluded)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _build_json_content_provider(
    exported_config: ExportedConfig,
    placements: LocalPlacementDataset,
) -> PlacementContentLookupProvider | None:
    """Python port of local-resolver.ts ``buildJsonContentProvider`` (plan 77).

    The export carries content-linked payloads in the studio shape
    (``placement_payloads[]`` with a ``content_link.message_block_id``) plus
    the ``message_blocks[]`` they point at. Adapt each content-linked studio
    payload into the ``ContentPlacementPayload`` shape the lookup provider
    consumes, keying its ``surface_template_id`` off the linked placement's
    surface template (so a ``list_payloads(surface_template_id)`` lookup
    matches the selected candidate). Returns ``None`` when the config carries
    no content-linked payloads or message blocks — callers then keep the
    inline surface content.

    Source: local-resolver.ts buildJsonContentProvider
    """
    message_blocks = exported_config.get("message_blocks")
    studio_payloads = exported_config.get("placement_payloads")
    if not isinstance(message_blocks, list) or not message_blocks:
        return None
    if not isinstance(studio_payloads, list) or not studio_payloads:
        return None

    # placement id → surface template id, from the placement's first active
    # payload surface (the same surface the inline candidate is built from).
    placement_template: dict[str, str] = {}
    for entry in placements["placements"]:
        active_payload = next(
            (
                p
                for p in (entry.get("payloads") or [])
                if is_record(p) and p.get("status") == "active"
            ),
            None,
        )
        if not is_record(active_payload):
            continue
        surfaces = active_payload.get("surfaces")
        surface = surfaces[0] if isinstance(surfaces, list) and surfaces else None
        template_id = surface.get("template_id") if is_record(surface) else None
        entry_id = entry.get("id")
        if isinstance(template_id, str) and isinstance(entry_id, str):
            placement_template[entry_id] = template_id

    payloads: list[dict[str, Any]] = []
    for p in studio_payloads:
        if not is_record(p):
            continue
        content_link = p.get("content_link")
        if not is_record(content_link):
            continue  # inline payload — no content-linked block
        block_id = content_link.get("message_block_id")
        if not block_id:
            continue
        placement_id = p.get("placement_id")
        surface_template_id = (
            placement_template.get(placement_id) if isinstance(placement_id, str) else None
        )
        if not surface_template_id:
            continue
        status = p.get("status")
        payloads.append(
            {
                "payload_id": p.get("payload_id"),
                "tenant_id": "",
                "name": p.get("payload_id"),
                "surface_template_id": surface_template_id,
                "default_message_block_id": block_id,
                "ui_path_id": content_link.get("ui_path_id"),
                "promotion_id": content_link.get("promotion_id"),
                "status": (
                    "active" if status == "active" else "draft" if status == "draft" else "inactive"
                ),
            }
        )
    if not payloads:
        return None

    return create_static_placement_content_lookup_provider(
        payloads=payloads,
        message_blocks=message_blocks,
        ui_paths=exported_config.get("content_ui_paths"),
        promotions=exported_config.get("content_promotions"),
        tokens=exported_config.get("personalization_tokens"),
    )


def create_static_placement_resolver(
    placements: LocalPlacementDataset,
    exported_config: ExportedConfig,
    impression_history: ImpressionHistory | None = None,
) -> PlacementResolver:
    """Create a placement resolver from a static dataset.

    Supports plan-target filtering from payload targets, token
    interpolation from payload content, usage-token injection from the
    resolved provider context, and suppression of upsell /
    trial-conversion categories for the enterprise plan.

    Source: local-resolver.ts:129-449
    """
    template_to_surface: dict[str, str] = {**DEFAULT_TEMPLATE_TO_SURFACE}
    for template in exported_config.get("surface_templates") or []:
        if is_record(template):
            surface_type_value = template.get("surface_type")
            if isinstance(surface_type_value, str):
                template_to_surface[template["id"]] = surface_type_value

    plan_handle_to_id: dict[str, str] = {}
    for plan in exported_config.get("plans") or []:
        if is_record(plan):
            plan_handle_to_id[plan["unique_handle"]] = plan["id"]

    config_version = exported_config.get("version")

    # Content-linked content provider (plan 77). Built once per resolver from
    # the config's content-linked payloads + message blocks. When present, the
    # selected candidate's display copy is resolved against the user's segments
    # at decision time; when absent, candidates keep their inline surface
    # content.
    content_provider = _build_json_content_provider(exported_config, placements)

    # ── Index: template_id → candidate outputs (sorted by entry order) ──
    outputs_by_template: dict[str, list[_CandidateOutput]] = {}
    outputs_by_name: dict[str, PlacementOutput] = {}

    for entry in placements["placements"]:
        payload = next(
            (
                p
                for p in (entry.get("payloads") or [])
                if is_record(p) and p.get("status") == "active"
            ),
            None,
        )
        if payload is None:
            continue

        surfaces = payload.get("surfaces")
        if not isinstance(surfaces, list) or not surfaces:
            continue
        surface = surfaces[0]
        if not surface:
            continue

        template_id = surface["template_id"]
        mapped_surface = template_to_surface.get(template_id)
        surface_type = mapped_surface if mapped_surface is not None else "custom"

        fields = surface.get("fields")
        content: dict[str, Any] = {**fields} if is_record(fields) else {}

        ctas = surface.get("ctas")
        cta0 = ctas[0] if isinstance(ctas, list) and len(ctas) >= 1 else None
        cta1 = ctas[1] if isinstance(ctas, list) and len(ctas) >= 2 else None
        if cta0 is not None:
            content["cta_label"] = cta0.get("label") if is_record(cta0) else None
        if cta1 is not None:
            content["secondary_cta_label"] = cta1.get("label") if is_record(cta1) else None

        cta_path = _normalize_cta_path(cta0)

        entry_id = entry.get("id")
        output: PlacementOutput = {
            "output_id": payload.get("id"),
            "category": entry.get("category"),
            "surface": {
                "template": template_id,
                "type": surface_type,
                "slot_id": entry_id,
            },
            "content": content,
            "cta_path": cta_path,
            "rule_id": entry_id,
            "decision_id": payload.get("id"),
            "config_version": config_version,
            "present_upsell": True,
        }

        target = payload.get("target")
        if target is not None:
            plan_ids = target.get("plan_ids") if is_record(target) else None
            output["content"] = {
                **output["content"],
                "__target_plan_ids": plan_ids if isinstance(plan_ids, list) else [],
            }

        trigger = entry.get("trigger")
        trigger_entitlement_handle = _read_entitlement_handle_from_trigger(trigger)
        if trigger_entitlement_handle:
            output["content"] = {
                **output["content"],
                "__trigger_entitlement_handle": trigger_entitlement_handle,
            }

        trigger_slot_id = _read_slot_id_from_trigger(trigger)
        trial_trigger = normalize_json_trigger(trigger)

        if trial_trigger:
            trigger_kind = trial_trigger.get("kind") if is_record(trial_trigger) else None
            if trigger_kind:
                output["content"] = {
                    **output["content"],
                    "__trigger_kind": trigger_kind,
                }

        entry_order = entry.get("order")
        candidate: _CandidateOutput = {
            "output": output,
            "entry_order": entry_order if entry_order is not None else 0,
            "entry_category": entry.get("category"),
            "trigger_entitlement_handle": trigger_entitlement_handle,
            "trigger_slot_id": trigger_slot_id,
            "trial_trigger": trial_trigger,
        }
        outputs_by_template.setdefault(template_id, []).append(candidate)

        if isinstance(entry_id, str):
            outputs_by_name[re.sub(r"^pl_", "", entry_id)] = output
            outputs_by_name[entry_id] = output

    for bucket in outputs_by_template.values():
        bucket.sort(key=lambda c: c["entry_order"])

    # ── Eligibility helper ──────────────────────────────────────────────
    def _is_eligible_for_plan(
        output: PlacementOutput,
        current_plan_id: str | None,
        plan_handle: str | None,
        billing_period: str | None = None,
    ) -> bool:
        oc = output.get("content")
        oc = oc if is_record(oc) else {}
        tpi = oc.get("__target_plan_ids")
        target_plan_ids = [x for x in tpi if isinstance(x, str)] if isinstance(tpi, list) else []
        tbp = oc.get("__target_billing_periods")
        target_billing_periods = (
            [x for x in tbp if isinstance(x, str)] if isinstance(tbp, list) else []
        )
        return evaluate_plan_eligibility(
            {
                "target_plan_ids": target_plan_ids,
                "target_billing_periods": target_billing_periods,
                "category": output.get("category"),
            },
            {
                "current_plan_id": current_plan_id,
                "plan_handle": plan_handle,
                "billing_period": billing_period,
            },
        )["eligible"]

    # ── Resolve closure ─────────────────────────────────────────────────
    def _resolve(
        input_data: PlacementDecisionInput,
        placement: PlacementRecord | None = None,
        context: dict[str, Any] | None = None,
    ) -> PlacementDecision:
        request_id = f"local_{int(time.time() * 1000)}"

        providers = context.get("__providers") if is_record(context) else None
        plan = providers.get("plan") if is_record(providers) else None
        plan_handle = plan.get("current_plan_handle") if is_record(plan) else None
        billing_period = plan.get("billing_period") if is_record(plan) else None
        current_plan_id = plan_handle_to_id.get(plan_handle) if plan_handle else None

        # Slot metadata. The TS record nests these under ``metadata``; the
        # Python ``PlacementRecord`` flattens them. Read the nested dict
        # when present, else the record top-level — works with both shapes.
        meta = placement.get("metadata") if is_record(placement) else None
        if not is_record(meta):
            meta = placement if is_record(placement) else {}

        stids = meta.get("surface_template_ids")
        allowed_template_ids = stids if isinstance(stids, list) else None

        selected_output: PlacementOutput | None = None
        reason_codes: list[str] = []

        if allowed_template_ids:
            candidates: list[_CandidateOutput] = []
            for tid in allowed_template_ids:
                bucket = outputs_by_template.get(tid)
                if bucket:
                    candidates.extend(bucket)

            if not candidates:
                return PlacementDecision(
                    placement_id=input_data["placement_id"],
                    request_id=request_id,
                    visible=False,
                    decision_source="fallback",
                    reason_codes=["no_candidates_for_template"],
                    content=_decision_content(
                        "No placements configured for this surface template",
                        "",
                        "",
                    ),
                )

            candidates.sort(key=lambda c: c["entry_order"])

            slot_entitlement_handle = meta.get("entitlement_handle")
            slot_category = meta.get("surface_slot_category")

            category_map: dict[str, list[str]] = {
                "gated": ["gated"],
                "fixed": ["fixed"],
                "triggered": [
                    "usage_credit_seat",
                    "trials",
                    "other_conversion",
                    "retention",
                ],
            }
            preferred_categories = category_map.get(slot_category) if slot_category else None

            filtered = candidates
            if slot_entitlement_handle:
                ent_filtered = [
                    c
                    for c in candidates
                    if c["trigger_entitlement_handle"] == slot_entitlement_handle
                ]
                if ent_filtered:
                    filtered = ent_filtered

            slot_id = meta.get("surface_slot_id")
            if slot_id:
                slot_filtered = [c for c in filtered if c["trigger_slot_id"] == slot_id]
                if slot_filtered:
                    filtered = slot_filtered

            if preferred_categories and slot_category != "fixed" and len(filtered) > 1:
                cat_filtered = [c for c in filtered if c["entry_category"] in preferred_categories]
                if cat_filtered:
                    filtered = cat_filtered

            if impression_history is not None:
                filtered = [
                    c
                    for c in filtered
                    if not impression_history.is_hidden_sync(c["output"].get("rule_id") or "")
                ]

            # Trial-trigger gating + milestone supersession (plan 43
            # TASK-12). Shared logic with the TS resolver via
            # ``trial_gating.py`` (byte-faithful port of
            # ``trial-gating.ts``).
            filtered = [c for c in filtered if matches_trial_trigger(c.get("trial_trigger"), plan)]

            supersession_winner: TrialCandidate | None = None
            superseded_ids: list[str] = []
            user_elapsed_percent = compute_user_elapsed_percent(plan)
            if user_elapsed_percent is not None and len(filtered) > 1:
                trial_candidates: list[TrialCandidate] = [
                    {
                        "rule_id": c["output"].get("rule_id"),
                        "entry_order": c["entry_order"],
                        "trial_trigger": c.get("trial_trigger"),
                        "output": c["output"],
                    }
                    for c in filtered
                ]
                result = apply_milestone_supersession(trial_candidates, user_elapsed_percent)
                if result is not None:
                    supersession_winner = result["winner"]
                    superseded_ids = result["superseded_ids"]
                    winner_rule_id = supersession_winner["rule_id"]
                    filtered = [
                        c
                        for c in filtered
                        if (c.get("trial_trigger") or {}).get("kind") != "trial_progress"
                        or c["output"].get("rule_id") == winner_rule_id
                    ]

            selected_candidate: _CandidateOutput | None = None
            for cand in filtered:
                if _is_eligible_for_plan(
                    cand["output"], current_plan_id, plan_handle, billing_period
                ):
                    selected_output = cand["output"]
                    selected_candidate = cand
                    break

            if (
                selected_candidate is not None
                and selected_output is not None
                and supersession_winner is not None
                and supersession_winner["rule_id"] == selected_candidate["output"].get("rule_id")
                and superseded_ids
            ):
                # Attach the supersession diagnostic, matching the TS
                # resolver's ``__superseded_placement_ids`` content key.
                prev_content = selected_output.get("content")
                merged_content: dict[str, Any] = (
                    {**prev_content} if isinstance(prev_content, dict) else {}
                )
                merged_content["__superseded_placement_ids"] = superseded_ids
                selected_output = {**selected_output, "content": merged_content}

            if selected_output is None:
                reason_codes = ["no_eligible_candidate"]
        else:
            # Direct lookup: try placement.name first (registered surface-slot
            # path), then fall back to input.placementId. The fallback lets
            # callers resolve placements directly by id without prior
            # `register_placement` — every placement comes from
            # `exported_config.placements`. Plan 43 TASK-12.
            name = placement.get("name") if is_record(placement) else None
            direct_output = outputs_by_name.get(name) if name else None
            if direct_output is None:
                direct_output = outputs_by_name.get(input_data["placement_id"])

            # Find the matching candidate so we can read its trial trigger
            # (outputs_by_name stores only the output, not the normalized
            # trigger — re-derive from the bucket index).
            direct_candidate: _CandidateOutput | None = None
            if direct_output is not None:
                for bucket in outputs_by_template.values():
                    found = next(
                        (c for c in bucket if c["output"] is direct_output),
                        None,
                    )
                    if found is not None:
                        direct_candidate = found
                        break

            if direct_output and (
                impression_history is not None
                and impression_history.is_hidden_sync(direct_output.get("rule_id") or "")
            ):
                reason_codes = ["placement_retired"]
            elif direct_output and not matches_trial_trigger(
                direct_candidate.get("trial_trigger") if direct_candidate else None,
                plan,
            ):
                # Plan 43 TASK-12: symmetric with the slot-based path.
                reason_codes = ["trial_trigger_unmet"]
            elif direct_output and _is_eligible_for_plan(
                direct_output, current_plan_id, plan_handle, billing_period
            ):
                selected_output = direct_output
            elif direct_output:
                reason_codes = ["plan_target_mismatch"]
            else:
                reason_codes = ["placement_not_found"]

        if selected_output is None:
            code = reason_codes[0] if reason_codes else "placement_not_found"
            return PlacementDecision(
                placement_id=input_data["placement_id"],
                request_id=request_id,
                visible=False,
                decision_source="fallback",
                reason_codes=[code],
                content=_decision_content("Placement not configured", "", ""),
            )

        # ── Segment-aware content (plan 77) ──────────────────────────────
        # If the config ships content-linked payloads + message blocks for the
        # winning surface template, resolve the copy variant against the user's
        # segments via the content-lookup provider and overlay it onto the
        # selected candidate's content. Selection is unchanged — only display
        # fields are swapped; the ``__``-prefixed meta keys (read by the usage
        # enrichment below) are preserved by spreading the existing content
        # first. No content-linked match → inline content stands.
        surface = selected_output.get("surface")
        surface_template_id = surface.get("template") if is_record(surface) else None
        if content_provider is not None and surface_template_id:
            segments = providers.get("segments") if is_record(providers) else None
            raw_segment_ids = segments.get("segment_ids") if is_record(segments) else None
            segment_ids: list[str] = (
                [s for s in raw_segment_ids if isinstance(s, str)]
                if isinstance(raw_segment_ids, list)
                else []
            )
            resolved_payload = resolve_payload_for_user_with_provider(
                surface_template_id, {"segment_ids": segment_ids}, content_provider, {}
            )
            if resolved_payload is not None:
                prev = selected_output.get("content")
                prev = prev if is_record(prev) else {}
                selected_output = {
                    **selected_output,
                    "content": {**prev, **resolved_payload["resolved_content"]},
                }

        # ── Enrich with usage data & interpolation ───────────────────────
        oc_src = selected_output.get("content")
        output_content: dict[str, Any] = {**oc_src} if is_record(oc_src) else {}

        entitlement = output_content.get("entitlement")
        trig_handle = output_content.get("__trigger_entitlement_handle")
        if isinstance(entitlement, str):
            entitlement_handle: str | None = entitlement
        elif isinstance(trig_handle, str):
            entitlement_handle = trig_handle
        else:
            entitlement_handle = None

        entitlements = providers.get("entitlements") if is_record(providers) else None
        usage_map = entitlements.get("usage") if is_record(entitlements) else None
        usage_entry = (
            usage_map.get(entitlement_handle)
            if entitlement_handle and is_record(usage_map)
            else None
        )

        if usage_entry:
            remaining = usage_entry.get("remaining")
            limit = usage_entry.get("limit")
            used = usage_entry.get("used")
            output_content["usage_remaining"] = remaining if _is_finite_number(remaining) else 0
            output_content["usage_limit"] = limit if _is_finite_number(limit) else 0
            output_content["usage_current"] = used if _is_finite_number(used) else 0
            if _is_finite_number(limit) and limit > 0:
                # TS divides raw ``used``; non-finite ``used`` would yield
                # NaN there. Real corpora always carry finite usage, so we
                # treat non-finite ``used`` as 0 to keep JSON-serializable
                # parity (the parity suite guards the edge).
                used_num = used if _is_finite_number(used) else 0
                output_content["usage_percent"] = min(100, _js_math_round((used_num / limit) * 100))
            else:
                output_content["usage_percent"] = 0
            reset_date = usage_entry.get("reset_date")
            if isinstance(reset_date, str) and len(reset_date) > 0:
                output_content["reset_date"] = reset_date

        interpolated_content = _interpolate_content_tokens(output_content)
        resolved_output: PlacementOutput = {
            **selected_output,
            "content": interpolated_content,
        }

        category = selected_output.get("category")
        is_upsell = category == "upsell" or category == "trial_conversion"
        is_enterprise = plan_handle == "enterprise"
        visible = not (is_upsell and is_enterprise)

        decision = PlacementDecision(
            placement_id=input_data["placement_id"],
            request_id=request_id,
            visible=visible,
            decision_source="fallback",
            reason_codes=[] if visible else ["plan_tier_suppressed"],
            content=_decision_content(
                _header_str(resolved_output["content"].get("header")),
                _header_str(resolved_output["content"].get("body")),
                _header_str(resolved_output["content"].get("cta_label")),
            ),
        )
        decision["output"] = resolved_output
        return decision

    return _resolve
