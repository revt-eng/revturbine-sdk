---
title: CLI Reference
description: Install and pin @revturbine/cli, move a Playbook from draft to Release, select config versions, and generate typed handles.
sidebar:
  order: 1
---

The public `@revturbine/cli` package installs the `revturbine` command. It
validates Playbooks offline, manages drafts and Releases, evaluates decisions,
generates typed handles, and exposes hosted analytics and ingest-key workflows.

## Install and pin it

RevTurbine requires Node.js **22.13 or newer**. Pin the CLI in each repository
that owns a Playbook; its version-stamped schema snapshot then travels with the
lockfile into local development, CI, and coding-agent sandboxes.

```bash
npm install -D --save-exact @revturbine/cli
npx revturbine --version
```

Use `pnpm add -D --save-exact @revturbine/cli` or
`yarn add -D --exact @revturbine/cli` for those package managers. A global
install is optional for ad-hoc work. The pinned CLI warns when another
`revturbine` version is running inside the repository.

## The default Playbook loop

The canonical filename is `revturbine.playbook.json`. `launch <file>` performs
the guarded file-to-Release path in one operation: validate, stage, and launch.

```bash
revturbine download --live --save ./revturbine.playbook.json
# edit ./revturbine.playbook.json
revturbine validate ./revturbine.playbook.json
revturbine diff ./revturbine.playbook.json --live
revturbine launch ./revturbine.playbook.json
```

For a separately reviewable draft, use the two-step form:

```bash
revturbine upload ./revturbine.playbook.json
revturbine preview
revturbine validate --draft
revturbine launch --draft
```

`diff <file> --live` uses live as the base. A `+` is created on launch; a `-`
is pruned on launch unless `--no-prune` is selected.

## Version selectors and positional files

Commands never guess which config version you mean.

| Command | Accepted config input |
|---|---|
| `download` | exactly one of `--draft`, `--live`, `--release <id>`; `--save <file>` writes it |
| `validate` | one or more positional files, or `--draft` |
| `diff` | exactly two from positional files, `--draft`, `--live`, `--release <id>` |
| `show <kind>` | one positional file or one server selector |
| `upload <config>` | one required positional Playbook file |
| `launch [file]` | one positional file or `--draft` |
| `generate types [file...]` | one positional file or one server selector |
| `preview` | the open draft; it takes no config file |
| `evaluate` | `--draft`, `--live`, or `--release <id>`; `--user <file>` is user context, not a Playbook |

Run `revturbine <command> --help` for the complete option set from the version
your repository pins.

## Command inventory

| Command | Purpose |
|---|---|
| `init` (`create`) | Detect the app, install the SDK, pin the CLI, add a starter Playbook, and install agent skills |
| `signup`, `login`, `logout`, `whoami` | Create an account and manage device-flow credentials |
| `schema`, `docs` | Emit the bundled schema or print the canonical docs URL |
| `download`, `validate`, `diff` | Retrieve and inspect Playbook versions without launching |
| `show <kind>` | Summarize plans, entitlements, segments, placements, or trials |
| `upload`, `preview`, `launch`, `discard` | Manage the open draft and produce a Release |
| `restore`, `status`, `history` | Restore or inspect Releases and draft state |
| `evaluate` | Evaluate entitlement or placement decisions locally against a selected server version |
| `generate types` | Generate typed Playbook handle objects and literal unions |
| `analytics catalog`, `templates`, `views`, `view` | Inspect the hosted Semantic Catalog and accessible analytics views |
| `analytics create`, `preview`, `query` | Save, validate, preview, or run canonical analytics-view documents |
| `ingest-keys create`, `list`, `revoke` | Manage public SDK telemetry keys; creation prints the secret once |

Read commands support `--json` where documented. Results go to stdout and
diagnostics go to stderr, so scripts can consume output safely.

## Generate typed handles

Generate after authoring a Playbook and again after a launch changes its
handles:

```bash
revturbine generate types ./revturbine.playbook.json \
  --out src/revturbine-handles.ts
```

The generated module contains five families:

- `Entitlements`, grouped by entitlement type, plus the `EntitlementHandle`
  union used by `can()`, `gate()`, and `checkEntitlement()`;
- `Plans` and `PlanHandle`;
- `Segments` and `SegmentHandle`;
- `SurfaceTemplates` and `SurfaceTemplateId`;
- `UiPathActionTypes` and `UiPathActionType`.

They are `as const` objects plus literal-union types, deliberately not enums.
The values are the runtime strings the SDK accepts, so no mapping layer is
needed:

```ts
import { Entitlements } from './revturbine-handles';

const handle = Entitlements.feature.data_export;
const result = await rt.can(handle);
```

The generated header records the exact regeneration command and source
selector. Use `--live`, `--draft`, or `--release <id>` instead of a file when
you want types from a hosted version.

## Related

- [Installation](/getting-started/installation/) — SDK and CLI setup
- [Entitlements](/guides/entitlements/) — use generated handles in checks
- [Runtime modes](/guides/runtime-modes/) — local and hosted SDK behavior
