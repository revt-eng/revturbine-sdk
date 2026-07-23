# Sandpack Scenario Pages (Local Runtime)

This guide documents the scenario-per-page Sandpack setup under:

- `revturbine-sdk-internal/pages-build`

## Goal

Demonstrate the easiest wiring path for each scenario using the same local runtime shape used by the Next app demo:

- `localRuntime.exportedConfig`
- `SurfaceSlotComponent`
- `sdk.setUserContext(...)`

## Architecture

The sandbox preview is generated as virtual files for Sandpack:

- `/App.tsx` — hash-route entry and scenario index page
- `/ScenarioPageTemplate.tsx` — shared scenario wiring template
- `/pages/<scenario-id>.tsx` — one page per scenario (thin wrappers)
- `/scenarios.ts` — scenario catalog
- `/demoUsers.ts` — user presets
- `/playbook.json` — exported config source for local mode

## Scenario Page Contract

Each scenario page is intentionally thin and passes only what is needed:

- `placementName`
- `userId`
- metadata (`scenarioCode`, `scenarioTitle`, etc.)

Example pattern:

```tsx
import React from "react";
import { ScenarioPageTemplate } from "../ScenarioPageTemplate";

export default function ScenarioPage() {
  return (
    <ScenarioPageTemplate
      scenarioCode="NAV-1"
      scenarioTitle="Upgrade Button"
      scenarioGroup="Fixed"
      scenarioSummary="Persistent nav conversion prompt for starter/pro users."
      placementName="nav_upgrade"
      userId="user_carol"
    />
  );
}
```

## Shared Wiring Template

`ScenarioPageTemplate` handles the actual SDK wiring:

1. Resolve preset user context from `demoUsers`.
2. Call `sdk.setUserContext(...)`.
3. Render scenario placement with:

```tsx
<SurfaceSlotComponent id={placementName} userId={userId} />
```

## Routing

The sandbox uses hash routes to keep things simple inside Sandpack:

- index: `#/`
- scenario page: `#/scenario/<scenario-id>`

No runtime dropdown selectors are used in the preview.

## Local Runtime Configuration

Provider options are initialized once and keep parity with demo local mode:

```tsx
const options = {
  localRuntime: {
    exportedConfig,
  },
  uiPathResolvers: {
    navigate_to_plans: async () => {},
    open_upgrade_modal: async () => {},
    open_checkout_modal: async () => {},
  },
};
```

## Source of Truth

- Scenario catalog: `revturbine-sdk-internal/pages-build/src/sandpack/scenarios.ts`
- User presets: `revturbine-sdk-internal/pages-build/src/sandpack/demoUsers.ts`
- Exported config copy source:
  - `revturbine-sdk-internal/pages-build/src/sandpack/example-playbook.json`

## Run

```bash
cd revturbine-sdk-internal/pages-build
pnpm install
pnpm dev
```

Then open the local Vite URL and navigate scenario pages from the index.
