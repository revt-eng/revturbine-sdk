# RevTurbine SDK Pages Build

This app is intentionally scoped to `revturbine-sdk-internal` and does not modify the main web app.

## What It Shows

- A live Sandpack editor + preview
- A locally bundled RevTurbine SDK artifact injected into Sandpack
- The full sandbox scenario set from the Next app showcase tracker
- One page file per scenario (no in-preview scenario/user selectors)
- Next-app `exported_config.json` loaded through `localRuntime.exportedConfig`
- Easy copy/paste scenario wiring examples for SurfaceSlotComponent + user context

## Local SDK Bundle

The sandbox bundles the workspace SDK source (`web/src/sdk/customer-side.ts`) into:

- `src/sandpack/vendor/revturbine-sdk.local.js`

Bundle command:

```bash
pnpm bundle:sdk-local
```

This runs automatically before `pnpm dev` and `pnpm build`.

Dependency preference during build:

- `pnpm build` first runs `deps:prefer-local`.
- If sibling `../revturbine-scaffold` exists, local `@revt-eng/schema` is used for `pages-build` and `web-sdk`.
- If sibling `../revturbine-web` exists, local `@revt-eng/web-api-client` is prepared and used for `web-sdk`.
- If siblings do not exist, dependencies resolve from GitHub Packages as normal.

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

- Sandpack imports the generated `vendor/revturbine-sdk.local.js` file directly, so it can run without publishing to npm.
- The mounted config is `src/sandpack/example-exported_config.json` and is exposed to the Sandpack runtime as `/exported_config.json`.
