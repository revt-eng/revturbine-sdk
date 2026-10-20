"""Exercise generated Pydantic carriers, not the evaluator's untyped dict path."""

import json
from pathlib import Path

from revturbine.types import RevTurbineConfigPlanVariationsItem


def test_clerk_price_snapshots_roundtrip() -> None:
    path = Path(__file__).resolve().parents[2] / "tests/parity/canonical/clerk-price-snapshots.json"
    fixtures = json.loads(path.read_text(encoding="utf-8"))
    assert len(fixtures) == 2
    for fixture in fixtures:
        parsed = RevTurbineConfigPlanVariationsItem.model_validate(fixture)
        serialized = json.loads(parsed.model_dump_json())
        for key, expected in fixture.items():
            assert serialized[key] == expected
        assert serialized.get("stripe_price_id") is None
