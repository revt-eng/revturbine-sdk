# RevTurbine SDK — Python

Headless, **in-memory** entitlement and placement decisioning for Python
services. `RevTurbineCustomerSdk` (plan 33 TASK-7) decides in-process from a
caller-supplied user context + `ExportedConfig` snapshot — no network, no
persistence beyond memory. Its decision output is **byte-identical** to the
canonical TypeScript `LocalRuntime` (cross-language parity is gate-enforced via
`revturbine-sdk-internal/tests/parity/`).

**Full docs:** the published Astro docs site — *Getting Started → Python SDK*
(source: `pages-build/src/content/docs/getting-started/python.mdx`).

## Install

Published as a GitHub **Release on `revt-eng/revturbine-external`** (the
customer-accessible repo — there is no PyPI). Requires Python ≥ 3.10.
`revturbine-external` is private, so fetch the wheel authenticated, then
install the file:

```bash
gh release download python-v0.1.0 \
  --repo revt-eng/revturbine-external \
  --pattern "revturbine-*.whl"
pip install ./revturbine-*.whl
```

A plain `pip install <url>` will not work — private-repo release assets
require authentication. (Contributors developing in this repo use the
editable install under [Local development](#local-development) instead.)

## Quick start

```python
import json
from revturbine import RevTurbineCustomerSdk

with open("playbook.json") as f:
    exported_config = json.load(f)

sdk = RevTurbineCustomerSdk(
    user_context={"tenant_id": "tenant_abc", "user_id": "user_123", "plan_handle": "pro"},
    exported_config=exported_config,
)

if not sdk.check_entitlement("advanced_analytics")["allowed"]:
    raise PermissionError("not entitled")

decision = sdk.get_placement_decision(
    {"placement_id": "pl_dashboard_upsell", "user_id": "user_123"}
)
```

### Public API

- `RevTurbineCustomerSdk(*, user_context, exported_config)` — keyword-only;
  `user_context` requires `tenant_id` + `user_id` (optional `plan_handle`,
  `plan_name`, `usage`). Stateless / in-memory — no storage parameter.
- `check_entitlement(handle, context=None) -> EntitlementCheckResult`
- `get_placement_decision(input) -> PlacementDecision`
- `get_placement_decisions(inputs) -> list[PlacementDecision]`

That is the entire public surface. Browser/full-SDK concerns (React, hooks,
HTTP/dual-mode, decision cache, segment/targeting derivation,
`identify`/`dismiss`/`snooze`/`convert`/`get_trial_status`/`capture`/…) are
intentionally **not** ported — plan 33 REQ-14 non-goals.

## Project layout

```
server-python/
├── pyproject.toml          ← package metadata + tool config (ruff, mypy, pytest)
├── tox.ini                 ← test/lint/type matrix
├── .pre-commit-config.yaml ← ruff + mypy hooks (scoped to this dir)
├── src/revturbine/         ← the headless SDK (sdk.py + core/ port)
├── revturbine_server/      ← legacy thin-RPC client (see below)
└── tests/                  ← pytest suite (incl. tests/test_public_api.py)
```

## Legacy `revturbine_server`

A historical thin-RPC HTTP client (`from revturbine_server import
RevTurbineServer`) also ships in this package. It is **independent of and
unrelated to** `RevTurbineCustomerSdk` — not folded in, not a dual-mode of it.
It currently depends on an unmaintained generated `revturbine.types` module
(plan REQ-4 / TASK-2) and is **not standalone-importable** until that
generator lands. Prefer `RevTurbineCustomerSdk` for all new server
integrations.

## Local development

```bash
pip install -e ".[dev]"
pytest                  # unit + smoke + parity-contract tests
mypy                    # strict type-check of src/ and tests/
ruff check src tests    # lint (CI scope)
ruff format --check src tests
tox                     # full matrix (py310–py313 + lint + type)
```

Cross-language parity (run from the SDK repo root):

```bash
node scripts/run-parity.mjs   # TS + Python runners, byte-diff (the gate)
```

## Dependencies

- Runtime: `pydantic>=2.0`.
- Stdlib only otherwise. The legacy `revturbine_server` client uses only
  `urllib` / `json` / `uuid` (plus the unmaintained generated-types import
  noted above).
