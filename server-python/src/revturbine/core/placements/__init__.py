"""revturbine.core.placements — Python port of @revt-eng/core/placements/.

Batch 2a landed payload-resolution (token/content/segment-matched
payload). Batch 2b adds the placement-decision lifecycle (candidate
resolution, scoring, milestone supersession, cap computation, cache
keys). Batch 2c lands the static local resolver
(``create_static_placement_resolver``).
"""

from revturbine.core.placements.local_resolver import (
    DEFAULT_TEMPLATE_TO_SURFACE,
    ExportedConfig,
    LocalPlacementDataset,
    LocalPlacementEntry,
    create_static_placement_resolver,
)
from revturbine.core.placements.payload_resolution import (
    PayloadResolutionOptions,
    PlacementContentLookupProvider,
    ResolvedPayload,
    apply_value_maps,
    create_static_placement_content_lookup_provider,
    resolve_content,
    resolve_payload_for_user,
    resolve_payload_for_user_with_provider,
    resolve_tokens,
)
from revturbine.core.placements.placement_decision import (
    CandidateResolutionOptions,
    CapCheckResult,
    DecisionCacheKeyInput,
    FilteredSlotDecision,
    PlacementRequestConfig,
    SlotDecision,
    SupersessionRecord,
    SupersessionResult,
    apply_category_conflict_suppression,
    apply_milestone_supersession,
    apply_milestone_supersession_with_metadata,
    check_placement_caps,
    check_system_presentation_caps,
    decision_cache_key,
    extract_placement_cap_policies,
    filter_one_discretionary,
    local_placement_lookup_key,
    normalize_decision_from_response,
    normalize_placement_output,
    resolve_local_placement_from_candidates,
)

__all__ = [
    # payload_resolution
    "PayloadResolutionOptions",
    "PlacementContentLookupProvider",
    "ResolvedPayload",
    "apply_value_maps",
    "create_static_placement_content_lookup_provider",
    "resolve_content",
    "resolve_payload_for_user",
    "resolve_payload_for_user_with_provider",
    "resolve_tokens",
    # local_resolver
    "DEFAULT_TEMPLATE_TO_SURFACE",
    "ExportedConfig",
    "LocalPlacementDataset",
    "LocalPlacementEntry",
    "create_static_placement_resolver",
    # placement_decision
    "CandidateResolutionOptions",
    "CapCheckResult",
    "DecisionCacheKeyInput",
    "FilteredSlotDecision",
    "PlacementRequestConfig",
    "SlotDecision",
    "SupersessionRecord",
    "SupersessionResult",
    "apply_category_conflict_suppression",
    "apply_milestone_supersession",
    "apply_milestone_supersession_with_metadata",
    "check_placement_caps",
    "check_system_presentation_caps",
    "decision_cache_key",
    "extract_placement_cap_policies",
    "filter_one_discretionary",
    "local_placement_lookup_key",
    "normalize_decision_from_response",
    "normalize_placement_output",
    "resolve_local_placement_from_candidates",
]
