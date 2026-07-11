# RevTurbine SDK Pages Build

This app is intentionally scoped to `revturbine-sdk-internal` and does not modify the main web app.

## What It Shows

- A live Sandpack editor + preview
- The public `@revturbine/sdk` package installed into each Sandpack from npm
- The full sandbox scenario set from the Next app showcase tracker
- One page file per scenario (no in-preview scenario/user selectors)
- Next-app `exported_config.json` loaded through `localRuntime.exportedConfig`
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
	- `revturbine-sdk-internal/pages-build/src/sandpack/example-exported_config.json`

## SDK Docs Integration

- Scenario wiring guide: `revturbine-sdk-internal/docs/guides/sandpack-scenarios-local-runtime.md`
- SDK docs index: `revturbine-sdk-internal/docs/README.md`

## Notes

- Sandpack installs `@revturbine/sdk` from the public npm registry, so the in-sandbox import (`from "@revturbine/sdk"`) is exactly what a builder copies into their own app.
- The mounted config is `src/sandpack/example-exported_config.json` and is exposed to the Sandpack runtime as `/exported_config.json`.
