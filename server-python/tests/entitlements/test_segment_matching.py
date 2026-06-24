"""Tests for ``revturbine.core.entitlements.segment_matching`` — plan
#39 REQ-8 dimensional matcher (intra-OR + cross-AND). Mirrors the
scaffold's `segment-matching.test.ts` corpus so the port stays byte-
identical to the canonical TS algorithm. The cross-language parity
suite cannot exercise this surface end-to-end today (LocalRuntime's
rule-fallback hardcodes empty user segments on both sides — see plan
#39 PR C follow-up), so a focused unit test is the only structural
guard against the divergence the audit surfaced.
"""

from __future__ import annotations

from revturbine.core.entitlements.segment_matching import matches_rule_segments


def test_empty_rule_segments_matches_all_users() -> None:
    """Empty `rule_segment_ids` means the rule matches every user,
    regardless of user segments or dimensions."""
    assert matches_rule_segments([], [], {}) is True
    assert matches_rule_segments([], ["seg_a"], {}) is True
    assert matches_rule_segments(None, ["seg_a"], {"seg_a": "d_geo"}) is True


def test_no_dimension_data_is_flat_or() -> None:
    """With no dimension lookup, all rule segments fall into the
    `__no_dim__` bucket → flat-OR back-compat behaviour."""
    # User in seg_a matches a rule scoped to {seg_a, seg_b}.
    assert matches_rule_segments(["seg_a", "seg_b"], ["seg_a"], {}) is True
    # User in neither does not match.
    assert matches_rule_segments(["seg_a", "seg_b"], ["seg_c"], {}) is False


def test_intra_dimension_or() -> None:
    """Two segments in the same dimension OR together — user matching
    either satisfies the bucket."""
    dims = {"seg_us": "d_geo", "seg_eu": "d_geo"}
    assert matches_rule_segments(["seg_us", "seg_eu"], ["seg_us"], dims) is True
    assert matches_rule_segments(["seg_us", "seg_eu"], ["seg_eu"], dims) is True
    # User in neither geo segment → fails.
    assert matches_rule_segments(["seg_us", "seg_eu"], ["seg_apac"], dims) is False


def test_cross_dimension_and() -> None:
    """Two segments in different dimensions AND together — user must
    match at least one in each dimension."""
    dims = {"seg_pro": "d_plan", "seg_us": "d_geo"}
    # Both dimensions satisfied.
    assert matches_rule_segments(["seg_pro", "seg_us"], ["seg_pro", "seg_us"], dims) is True
    # Plan matches, geo doesn't → fails.
    assert matches_rule_segments(["seg_pro", "seg_us"], ["seg_pro"], dims) is False
    # Geo matches, plan doesn't → fails.
    assert matches_rule_segments(["seg_pro", "seg_us"], ["seg_us"], dims) is False
    # Neither → fails.
    assert matches_rule_segments(["seg_pro", "seg_us"], ["seg_free", "seg_eu"], dims) is False


def test_mixed_no_dim_bucket_is_an_and_partner() -> None:
    """Segments missing a dimension form their own bucket; that bucket
    must be satisfied like any other dimension (cross-AND)."""
    dims = {"seg_pro": "d_plan"}
    # User has the plan segment but not the no-dim one → fails (the
    # __no_dim__ bucket needs satisfying too).
    assert matches_rule_segments(["seg_pro", "seg_unknown"], ["seg_pro"], dims) is False
    # User has both → passes.
    assert (
        matches_rule_segments(["seg_pro", "seg_unknown"], ["seg_pro", "seg_unknown"], dims) is True
    )


def test_pre_fix_divergence_case() -> None:
    """The exact scenario the audit called out — and the case the
    pre-fix python `any()` flat-OR would have over-granted on.

    Rule scopes to two segments in two different dimensions; user is
    only in one dimension. Flat-OR would return True (rule applies);
    cross-AND correctly returns False (the other dimension bucket
    isn't satisfied).
    """
    dims = {"seg_pro_plan": "d_plan"}  # seg_eu_region intentionally absent
    result = matches_rule_segments(
        ["seg_pro_plan", "seg_eu_region"],
        ["seg_pro_plan"],
        dims,
    )
    assert result is False, (
        "cross-AND must reject: the __no_dim__ bucket "
        "(seg_eu_region) has no overlap with user segments"
    )
