# RevTurbine SDK Pages Build

This app is intentionally scoped to `revturbine-sdk-internal` and does not modify the main web app.

## What It Shows

- A live Sandpack editor + preview
- The public `@revturbine/sdk` package installed into each Sandpack from npm
- The full sandbox scenario set from the Next app showcase tracker
- One page file per scenario (no in-preview scenario/user selectors)
- Next-app `playbook.json` loaded through `localRuntime.exportedConfig`
- Easy copy/paste scenario wiring examples for `Slot` / `Gate` + user context

## SDK in Sandpack

Each sandbox installs the public `@revturbine/sdk` from npm via
`customSetup.dependencies`. The pinned version is derived at build time from
`../web-sdk/package.json` (`PUBLIC_SDK_VERSION`, injected in `astro.config.mjs`),
so the sandboxes always demo the currently-published SDK — there is no vendored
bundle to rebuild.

Dependencies resolve from GitHub Packages at their pinned versions (the
prefer-local sibling resolver was removed 2026-07-11 — publish + bump the pin
to test unpublished scaffold changes).

## Run

```bash
cd revturbine-sdk-internal/pages-build
pnpm install
pnpm dev
```

Then open the local Vite URL in your browser.

`pages-build` is **its own install root** — it has its own `pnpm-lock.yaml` and
`pnpm-workspace.yaml`, and is deliberately excluded from the repo-root pnpm
workspace so Vite resolves `@revt-eng/*` at this docs workspace's exact registry
pins rather than an outer tree. A `pnpm install` at the repo root therefore does
**not** cover it; installs here are always separate.

### Troubleshooting: `Cannot find package '<x>' imported from …`

A module-not-found for a package you can see in `package.json` means
`node_modules` is physically incomplete — an interrupted install, a half-finished
`rm -rf`, or a process holding files open.

pnpm cannot self-heal this. It decides whether to install by reading
`node_modules/.pnpm-workspace-state-v1.json`, not by checking the tree, so
`pnpm install`, `--frozen-lockfile`, and even `--force` all report
`Already up to date` in ~300ms and change nothing. (`verifyDepsBeforeRun`, on by
default, is blind to it for the same reason — it only catches *lockfile drift*,
which it does handle automatically.)

Drop the state file to force a real relink:

```bash
rm -f node_modules/.pnpm-workspace-state-v1.json
pnpm install --frozen-lockfile   # ~1s; relinks only what's missing
```

`pnpm dev` and `pnpm build` run `scripts/check-deps.mjs` first (as `predev` /
`prebuild`), which detects this and prints the same fix rather than letting the
build fail on a misleading transitive import. Run it directly with
`pnpm lint:deps`.

## Publish To GitHub Pages

The repository includes a workflow that builds `pages-build` and deploys `dist/` to GitHub Pages on pushes to `main`.

Expected URL:

- `https://<org-or-user>.github.io/<repo>/`

Required one-time repo setting:

- In GitHub, set Pages source to **GitHub Actions**.

## Scenario Inputs

- Scenario catalog file: `src/sandpack/scenarios.ts`
- User presets: `src/sandpack/demoUsers.ts`
- Exported config source copied from:
	- `revturbine-sdk-internal/pages-build/src/sandpack/example-playbook.json`

## SDK Docs Integration

- Scenario wiring guide: `revturbine-sdk-internal/docs/guides/sandpack-scenarios-local-runtime.md`
- SDK docs index: `revturbine-sdk-internal/docs/README.md`

## Notes

- Sandpack installs `@revturbine/sdk` from the public npm registry, so the in-sandbox import (`from "@revturbine/sdk"`) is exactly what a builder copies into their own app.
- The mounted config is `src/sandpack/example-playbook.json` and is exposed to the Sandpack runtime as `/playbook.json`.
