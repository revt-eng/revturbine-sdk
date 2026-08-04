# Bundle decode fixtures (plan 160 TASK-4)

Cross-language decode-parity fixtures for the Python `.rvtb` decoder
(`revturbine.core.bundle.decode`). **TypeScript is canonical** — a divergence is
a Python-port bug, never a fixture to loosen.

| File | What it is |
|---|---|
| `comprehensive.rvtb` | A compiled bundle (`SCHEMA_VERSION` 13) covering one of every entity type — plans, entitlements (incl. `capability_tier`, `price_per_unit`), rules (usage/credits with all the eval fields), segments, dimensions, content_ui_paths, free/reverse trial rules. |
| `comprehensive.playbook.json` | The **canonical decode golden** — the output of scaffold's `bundleToPlaybook` (TS, `@revt-eng/core`) on `comprehensive.rvtb`. Python's `bundle_to_playbook` must produce identical values (modulo the Zod defaults `PlaybookSchema.parse` fills, which are eval-neutral and listed in `test_bundle_decode.py`). |

## Regeneration

Generated from **revturbine-scaffold `main`** (which holds the encoder + the TS
decoder, plan 160 TASK-2/TASK-3). When the wire format changes, regenerate:

1. In revturbine-scaffold, build a config, then
   `encodeBundle(lowerToIR(config).ir)` → write the bytes to `comprehensive.rvtb`,
   and `bundleToPlaybook(new BundleHandle(bytes))` → write the JSON to
   `comprehensive.playbook.json`. (Run inside a scaffold vitest test — importing
   the scaffold `src` barrel via raw `tsx` trips an unrelated ESM export quirk.)
2. Copy both files here. The Python `.rvtb` bindings
   (`src/revturbine/bundle/`) are regenerated separately via `scripts/gen-fb.mjs`.
