---
title: Architecture
description: SDK architecture, directory structure, and key concepts.
sidebar:
  order: 1
---

## Directory Structure

```text
sdk/
├── index.ts                  # Barrel export (entry point for @revt-eng/sdk)
├── customer-side.ts          # Core SDK class — identity, placements, entitlements, events
├── generated.ts              # Re-exports types from @revt-eng/schema (DO NOT EDIT)
├── react/                    # React integration layer
│   ├── RevTurbineProvider    # Context provider — wraps app for SDK access
│   ├── usePlacement          # Hook — load decision + manage interactions
│   └── Placement             # Render-prop alternative to usePlacement
├── placements/               # Placement rendering system
│   ├── types.ts              # Slot type interfaces
│   ├── registry.ts           # PlacementTypeRegistry — resolves outputs → slot components
│   ├── builtin.ts            # Registers all 9 built-in slot types
│   ├── PlacementRenderer     # Core renderer — resolves slot type, expands tokens, renders
│   ├── SurfaceSlotComponent  # Drop-in component (decision + render in one step)
│   ├── useSurfaceSlot        # Hook variant of SurfaceSlotComponent
│   └── slots/                # Built-in slot components
│       ├── BannerSlot        # Full-width sticky banner (top/bottom)
│       ├── ModalSlot         # Centered overlay dialog
│       ├── InlineEmbedSlot   # Inline card in page flow
│       ├── ToastSlot         # Ephemeral auto-dismiss notification
│       ├── ButtonSlot        # Single CTA button
│       ├── FullPageSlot      # Dedicated full-page (plans/upgrade)
│       ├── QuotaMeterSlot    # Usage meter (bar/gauge/numeric)
│       ├── CliSlot           # CLI-style monospace message
│       └── CreditBalanceSlot # Depleting credit balance display
```

## Runtime Modes

The SDK supports three runtime modes:

1. **`revturbine_server`** (default) — Standard RevTurbine-hosted integration. SDK calls RevTurbine-managed decisioning, entitlement, and ingestion paths.

2. **`custom_endpoints`** — Customer provides endpoint overrides for SDK API calls. Useful when the customer proxies or replaces RevTurbine service surfaces.

3. **`local_only`** — No server dependency. Required context/content/config are provided at initialization. Runtime state is persisted in localStorage.

See [Runtime Modes](/guides/runtime-modes/) for setup details and decision tree.

## Placement Type Registry

The SDK uses a registry pattern to map decision engine outputs to React components:

1. Built-in slot types (banner, modal, toast, etc.) are registered at init.
2. Customers can register custom slot types via `useRegisterPlacementType`.
3. `PlacementRenderer` resolves outputs → slot types via template → surface type → fallback chain.

## Personalization Tokens

Content fields support `{{token_name}}` syntax. The SDK resolves tokens against a `PersonalizationContext` before rendering:

```ts
const personalization = {
  user_name: 'Jane',
  plan_name: 'Pro',
  usage_current: 8500,
  usage_limit: 10000,
};
```

## Decision Lifecycle

1. `registerPlacement()` → deterministic placement ID
2. `getPlacementDecision()` → visibility + content + reason codes
3. `trackTreatmentInteraction()` → impression/dismiss/CTA tracking
4. Suppression rules prevent re-showing dismissed placements

## Provider Pattern

The SDK supports an optional provider strategy for `getPlacement`, `checkEntitlement`, and `identify`:

- **`provider`**: primary provider object or factory.
- **`providerFallbacks`**: ordered list of fallback providers.
- **`providerFailureSlotBehavior`**: slot behavior after provider-chain failure — `'invisible'` (default) or `'placeholder'`.

When the primary provider fails, the SDK logs a warning and tries each configured fallback in order. If every configured provider for that method fails, the SDK disables itself in fail-closed mode. This protects customer experiences from partially initialized or unstable provider chains.

See [Runtime Modes → Provider Fallback Strategy](/guides/runtime-modes/#provider-fallback-strategy) for configuration details.

## Self-Documenting Exports

All public SDK exports use **TSDoc** comments that are:

1. Shown inline in VS Code / IDE intellisense
2. Extracted by **TypeDoc** into the [API Reference](/api/)
3. Picked up by **Storybook** for component documentation pages

When adding or modifying SDK exports, include TSDoc with a summary sentence, `@example` code blocks, and `@param` / `@returns` for non-obvious function signatures.
