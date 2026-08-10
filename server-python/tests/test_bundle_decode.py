"""Cross-language decode parity for the Python ``.rvtb`` decoder (plan 160 TASK-4).

TypeScript (scaffold ``bundleToPlaybook`` / ``@revt-eng/core``) is canonical. These
tests lock that ``revturbine.core.bundle.decode.bundle_to_playbook`` decodes a
compiled bundle to the SAME canonical Playbook the TS decoder produces, and that
the decoded config decides identically through the Python SDK — so the Python
server SDK can consume the compact bundle on the wire in place of the full JSON
Playbook with byte-for-byte decision parity. A divergence is a port bug.

The fixtures (``bundle_fixtures/``) come from scaffold ``main``; see their README.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from revturbine import RevTurbineCustomerSdk
from revturbine.core.bundle.decode import bundle_to_playbook

_FIXTURES = Path(__file__).resolve().parent / "bundle_fixtures"


def _load() -> tuple[dict[str, Any], dict[str, Any]]:
    rvtb = (_FIXTURES / "comprehensive.rvtb").read_bytes()
    ts_golden: dict[str, Any] = json.loads(
        (_FIXTURES / "comprehensive.playbook.json").read_text(encoding="utf-8")
    )
    return bundle_to_playbook(rvtb), ts_golden


# Scalar defaults `PlaybookSchema.parse` fills on the TS side that a raw decoded
# dict legitimately omits (the Python evaluator applies them at read time, so
# they are eval-neutral). `None`, `{}`, `[]` are also accepted defaults.
_SCALAR_DEFAULTS = frozenset({"public", "next_tier_up", "time", "signup", 0, 1})


def _is_schema_default(value: Any) -> bool:
    return value is None or value == {} or value == [] or value in _SCALAR_DEFAULTS


def _assert_values_match(py: Any, ts: Any, path: str, ts_only: list[str]) -> None:
    """Walk py vs ts; assert every shared key has an identical value, and record
    any key present in ts but absent in py together with a default-ness check —
    Python may omit a field ONLY where TS filled a schema default, never a real
    value."""
    if isinstance(py, dict) and isinstance(ts, dict):
        for k, tv in ts.items():
            if k not in py:
                assert _is_schema_default(tv), (
                    f"Python omitted a non-default value at {path}.{k}: {tv!r}"
                )
                ts_only.append(k)
            else:
                _assert_values_match(py[k], tv, f"{path}.{k}", ts_only)
    elif isinstance(py, list) and isinstance(ts, list):
        assert len(py) == len(ts), f"list length differs at {path}: {len(py)} vs {len(ts)}"
        for i, (a, b) in enumerate(zip(py, ts, strict=True)):
            _assert_values_match(a, b, f"{path}[{i}]", ts_only)
    else:
        assert py == ts, f"value differs at {path}: {py!r} (py) vs {ts!r} (ts)"


def test_decode_values_match_ts_canonical() -> None:
    """Every value Python decodes matches the TS canonical decode; the only keys
    TS has that Python omits carry schema-default values (eval-neutral)."""
    py, ts = _load()
    assert set(py) == set(ts), f"top-level key sets differ: py={sorted(py)} ts={sorted(ts)}"
    _assert_values_match(py, ts, "", [])


def test_decode_structural_sanity() -> None:
    """Spot-check the load-bearing reversals: header identity, entitlement type
    mapping (incl. the eval-inert types), enforcement + credits eval fields, and
    the trial-rule projection."""
    py, _ = _load()
    assert py["artifact_type"] == "playbook"
    assert py["environment_id"] == "env_c"
    assert py["tenant_id"] == "tn_c"
    assert py["playbook_handle"] == "pb_c"

    types = {e["unique_handle"]: e["type"] for e in py["entitlements"]}
    assert types["tier"] == "capability_tier"  # IR `tiered` -> config `capability_tier`
    assert types["metered"] == "price_per_unit"  # IR `unknown` -> re-normalizes to `unknown`
    assert types["api"] == "usage_limit"
    assert types["cred"] == "credits"

    tier_ent = next(e for e in py["entitlements"] if e["unique_handle"] == "tier")
    assert [t["handle"] for t in tier_ent["tier_definitions"]] == ["bronze", "gold"]

    rules = {r["id"]: r for r in py["entitlement_rules"]}
    assert rules["r_u"]["enforcement"] == "allow_overage"
    assert rules["r_c"]["enforcement"] == "soft_block"
    assert rules["r_c"]["initial_grant"] == 250
    assert rules["r_c"]["allowance_value"] == 500
    assert rules["r_c"]["reset_period"] == "month"  # synthesized for the non-zero-allowance refine

    free = py["free_trial_rules"][0]
    assert free["plan_id"] == "pro"
    assert free["usage_entitlement_handle"] == "api"
    assert free["usage_limit_value"] == 100
    rev = py["reverse_trial_rules"][0]
    assert rev["premium_plan_id"] == "pro"
    assert rev["fallback_plan_id"] == "free"
    assert rev["entitlements_during_trial"] == ["api", "cred"]


def _check(cfg: dict[str, Any], handle: str, usage: dict[str, Any]) -> Any:
    sdk = RevTurbineCustomerSdk(
        user_context={"tenant_id": "tn_c", "user_id": "u1", "plan_handle": "pro", "usage": usage},
        exported_config=cfg,
    )
    return sdk.check_entitlement(handle)


def test_decode_eval_parity() -> None:
    """The Python-decoded config decides identically to the TS-decoded canonical
    config through the Python SDK — across enforcement modes, credits, tier/
    price-per-unit, and the fail-closed unknown handle."""
    py, ts = _load()
    scenarios: list[tuple[str, dict[str, Any]]] = [
        ("api", {"api": {"used": 5, "limit": 1000}}),  # under limit
        ("api", {"api": {"used": 5000, "limit": 1000}}),  # over limit -> allow_overage
        ("cred", {}),
        ("tier", {}),
        ("metered", {}),
        ("nonexistent", {}),  # fail-open default
    ]
    for handle, usage in scenarios:
        assert _check(py, handle, usage) == _check(ts, handle, usage), (
            f"decode->eval parity broke for {handle} @ {usage}"
        )
