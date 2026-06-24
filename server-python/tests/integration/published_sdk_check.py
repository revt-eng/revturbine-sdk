"""Integration check for the *published* ``revturbine`` package
(plan 33, the published-package task).

Python parallel of
``revturbine-sdk-internal/tests/integration/published-sdk.test.mjs``. Installs
the **published wheel** (built + released by ``release-python.yml`` to a
GitHub Release on ``revt-eng/revturbine-external`` — superseding the
plan's TestPyPI wording, consistent with the TASK-12 GitHub-publish
decision) into a throwaway venv, then exercises the headless
``RevTurbineCustomerSdk`` surface in a subprocess and asserts exports +
behavior.

It is intentionally **not** a ``test_*`` module: it must run against
the *installed wheel*, not the editable working tree, so the normal
``pytest`` suite must not collect it. The post-publish CI job
(``release-python.yml``) downloads the release wheel and runs:

    REVTURBINE_WHEEL=/abs/path/revturbine-<ver>-py3-none-any.whl \\
      python server-python/tests/integration/published_sdk_check.py

Exit code 0 = all assertions passed; non-zero = failure (CI-gating).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import venv
from pathlib import Path

# The scenario the installed package must satisfy. Run in the throwaway
# venv's interpreter; emits one JSON object per check on stdout.
_CHILD = r"""
import json
from revturbine import RevTurbineCustomerSdk, UserContext  # noqa: F401

cfg = {
    "version": "0.1.0",
    "entitlements": [
        {"unique_handle": "feat_x", "unit": None},
        {"unique_handle": "credits", "unit": "credit"},
    ],
    "placements": [{"placement_id": "pl_known", "name": "Known"}],
}
sdk = RevTurbineCustomerSdk(
    user_context={"tenant_id": "t", "user_id": "u", "plan_handle": "pro"},
    exported_config=cfg,
)

print(json.dumps({
    "check": "exports",
    "has_check_entitlement": callable(getattr(sdk, "check_entitlement", None)),
    "has_get_placement_decision": callable(getattr(sdk, "get_placement_decision", None)),
    "has_get_placement_decisions": callable(getattr(sdk, "get_placement_decisions", None)),
}))

ent = sdk.check_entitlement("feat_x")
print(json.dumps({
    "check": "entitlement",
    "allowed": ent.get("allowed"),
    "status": ent.get("status"),
}))

dec = sdk.get_placement_decision({"placement_id": "pl_known", "user_id": "u"})
print(json.dumps({
    "check": "placement",
    "placement_id": dec.get("placement_id"),
    "has_visible": "visible" in dec,
}))

batch = sdk.get_placement_decisions([
    {"placement_id": "pl_known", "user_id": "u"},
    {"placement_id": "missing", "user_id": "u"},
])
print(json.dumps({
    "check": "batch_order",
    "order": [d.get("placement_id") for d in batch],
}))
"""


def _fail(msg: str) -> None:
    print(f"  [FAIL] {msg}", file=sys.stderr)


def _resolve_wheel() -> Path:
    raw = os.environ.get("REVTURBINE_WHEEL") or (sys.argv[1] if len(sys.argv) > 1 else "")
    if not raw:
        raise SystemExit(
            "REVTURBINE_WHEEL not set (and no argv path). Point it at the "
            "wheel downloaded from the revturbine-external GitHub Release."
        )
    wheel = Path(raw).expanduser().resolve()
    if not wheel.is_file():
        raise SystemExit(f"wheel not found: {wheel}")
    return wheel


def _venv_python(venv_dir: Path) -> Path:
    win = venv_dir / "Scripts" / "python.exe"
    nix = venv_dir / "bin" / "python"
    return win if win.exists() else nix


def main() -> int:
    wheel = _resolve_wheel()
    passed = 0
    failed = 0

    with tempfile.TemporaryDirectory(prefix="revturbine-it-") as tmp:
        tmp_path = Path(tmp)
        venv_dir = tmp_path / ".venv"
        print(f"-> installing {wheel.name} into a clean venv")
        venv.EnvBuilder(with_pip=True).create(venv_dir)
        py = _venv_python(venv_dir)

        install = subprocess.run(
            [str(py), "-m", "pip", "install", "--quiet", str(wheel)],
            capture_output=True,
            text=True,
            check=False,
        )
        if install.returncode != 0:
            _fail(f"pip install failed:\n{install.stderr}")
            return 1

        child_file = tmp_path / "scenario.py"
        child_file.write_text(_CHILD, encoding="utf-8")
        proc = subprocess.run(
            [str(py), str(child_file)],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            _fail(f"scenario crashed:\n{proc.stdout}\n{proc.stderr}")
            return 1

        results: dict[str, dict[str, object]] = {}
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict) and "check" in obj:
                results[str(obj["check"])] = obj

        def check(cond: bool, label: str) -> None:
            nonlocal passed, failed
            if cond:
                passed += 1
                print(f"  [ok] {label}")
            else:
                failed += 1
                _fail(label)

        exports = results.get("exports", {})
        check(exports.get("has_check_entitlement") is True, "check_entitlement exported")
        check(
            exports.get("has_get_placement_decision") is True,
            "get_placement_decision exported",
        )
        check(
            exports.get("has_get_placement_decisions") is True,
            "get_placement_decisions exported",
        )

        ent = results.get("entitlement", {})
        check(ent.get("allowed") is True, "feat_x entitlement allowed (static-allow)")
        check(ent.get("status") == "allowed", "feat_x status == allowed")

        plc = results.get("placement", {})
        check(plc.get("placement_id") == "pl_known", "placement_id round-trips")
        check(plc.get("has_visible") is True, "placement decision carries 'visible'")

        batch = results.get("batch_order", {})
        check(
            batch.get("order") == ["pl_known", "missing"],
            "get_placement_decisions preserves order",
        )

    total = passed + failed
    print(f"\n{'=' * 48}\nResults: {passed}/{total} passed\n{'=' * 48}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
