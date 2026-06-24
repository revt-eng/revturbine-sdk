# Headless API Guide

Use the RevTurbine SDK without React — from vanilla JS, Vue, Svelte, Angular, or server-side code.

The headless API provides three controllers and a factory function:

| Export | Purpose |
|---|---|
| `initRevTurbine()` | Async factory — creates an initialized `SdkSession` |
| `SdkSession` | Session wrapper with user context, placement, and entitlement APIs |
| `PlacementController` | Register → decide → impression-track → interact lifecycle |
| `EntitlementGate` | Check → auto-gate pipeline for feature access |

Import everything from the headless barrel:

```ts
import {
  initRevTurbine,
  PlacementController,
  EntitlementGate,
} from '@revt-eng/web-sdk/headless';
```

## Quick Start

```ts
import { initRevTurbine } from '@revt-eng/web-sdk/headless';

const session = await initRevTurbine({
  tenantId: 'tenant_abc',
  apiKey: 'rt_live_xxx',
  endpoint: 'https://api.revturbine.io',
  user: { id: 'user_123', plan: { id: 'pro' } },
});

// Placement
const banner = session.placement({ surfaceSlot: { id: 'upsell_banner' } });
await banner.load();
if (banner.visible) {
  console.log('Show banner:', banner.content);
}

// Entitlement
const gate = session.entitlement({ handle: 'brand_kit', autoGate: true });
await gate.check();
if (gate.denied) {
  console.log('Show upgrade gate:', gate.gatedPlacement);
}
```

## `initRevTurbine(options): Promise<SdkSession>`

Creates a fully-initialized session. Handles:

1. SDK initialization
2. User identification (if `options.user.id` is provided)
3. Theme resolution (from ExportedConfig or API)
4. Placement bootstrapping (optional preloaded decisions)

```ts
const session = await initRevTurbine({
  tenantId: 'tenant_abc',
  apiKey: 'rt_live_xxx',
  endpoint: 'https://api.revturbine.io',
  user: { id: 'user_123', plan: { id: 'pro' } },
  runtimeMode: 'revturbine_server',
  bootstrapPlacements: [
    { placement: { name: 'pricing_banner' } },
  ],
});
```

### Options

Extends `RevTurbineInitInputOptions` with:

| Option | Type | Description |
|---|---|---|
| `bootstrapPlacements` | `Array<{placement, userId?, contextMode?, overrides?, traits?, ttlMs?}>` | Placements to preload on creation |

All standard init options apply: `tenantId`, `apiKey`, `endpoint`, `runtimeMode`, `user`, `localRuntime`, `provider`, `providerFallbacks`, etc.

## `SdkSession`

The session returned by `initRevTurbine()`. Provides the full imperative API.

### User Context

```ts
// Identify a different user
session.identify('user_456', { plan: { id: 'enterprise' } });

// Merge fields into user context
session.setUserContext({ personalization: { company: 'Acme' } });

// Read current user context
const ctx = session.getUserContext();

// Reset to anonymous
session.resetIdentity();

// Update usage balances
session.updateUsage({ api_calls: { used: 150, limit: 1000 } });

// Fetch user context from server
const fullCtx = await session.fetchUserContext('user_456');

// Trial status
const trial = await session.getTrialStatus();

// Current usage snapshot
const usage = session.getUsage();
```

### Factory Methods

```ts
// Create a PlacementController
const ctrl = session.placement({ surfaceSlot: { id: 'upsell_banner' } });

// Create an EntitlementGate
const gate = session.entitlement({ handle: 'brand_kit', autoGate: true });

// One-shot: register slot, fetch decision, return it
const decision = await session.getPlacementBySlotId('upsell_banner');

// One-shot entitlement check
const result = await session.checkEntitlement('brand_kit');

// Track a custom event
await session.trackEvent('feature_used', { feature: 'export_csv' });
```

## `PlacementController`

Manages the full placement lifecycle: register → decide → impression-track → interact.

### Basic Usage

```ts
const ctrl = session.placement({
  surfaceSlot: { id: 'pricing_banner' },
});

await ctrl.load();

if (ctrl.visible) {
  renderBanner(ctrl.content);
}
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `surfaceSlot` | `{id, name?}` | — | Canonical surface slot (preferred) |
| `placement` | `RevTurbinePlacementConfig` | — | Alternative: placement config |
| `userId` | `string` | SDK user | Override target user |
| `contextMode` | `RevTurbineContextMode` | `'auto'` | Context resolution mode |
| `overrides` | `RevTurbinePlacementDecisionOverrides` | — | Override segment/plan/usage for testing |
| `traits` | `Record<string, string \| number \| boolean>` | — | Custom traits for decision request |
| `ttlMs` | `number` | — | Decision cache TTL |
| `autoTrackImpression` | `boolean` | `true` | Auto-record impression on visible decision |

### State & Getters

```ts
ctrl.visible;    // boolean — is the placement visible?
ctrl.content;    // resolved content or null
ctrl.decision;   // full decision object or null
ctrl.placementId; // registered placement ID
ctrl.state;      // full PlacementControllerState snapshot
```

### Interactions

```ts
await ctrl.dismiss();              // dismiss with 24h cooldown
await ctrl.dismiss(7200_000);      // custom cooldown (ms)
await ctrl.snooze();               // snooze for 1 hour
await ctrl.snooze(7200);           // custom snooze (seconds)
await ctrl.ctaClick('upgrade');    // CTA click
await ctrl.ctaComplete('upgrade'); // CTA completed (hides placement)
await ctrl.refresh();              // re-fetch decision
ctrl.reset();                      // reset all state
```

### Reactive Updates

```ts
const unsub = ctrl.onChange(() => {
  console.log('State changed:', ctrl.state);
  updateUI(ctrl.state);
});

// Stop listening
unsub();
```

## `EntitlementGate`

Checks feature access and optionally resolves a gated placement for denied users.

### Basic Usage

```ts
const gate = session.entitlement({
  handle: 'brand_kit',
  autoGate: true,
});

await gate.check();

if (gate.allowed) {
  enableFeature();
} else if (gate.denied && gate.gatedPlacement) {
  showUpgradeModal(gate.gatedPlacement);
}
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `handle` | `string` | — | Entitlement handle (e.g. `'brand_kit'`) |
| `context` | `RevTurbineEntitlementContext` | — | Optional usage/tier context |
| `autoGate` | `boolean` | `false` | Auto-resolve gated placement when denied |
| `gatePlacementRequest` | `Omit<RevTurbinePlacementRequestConfig, 'entitlementHandle'>` | — | Custom placement request for auto-gate |

### State & Getters

```ts
gate.allowed;        // boolean
gate.limited;        // boolean — usage partially exhausted
gate.denied;         // boolean
gate.result;         // raw EntitlementResult or null
gate.gatedPlacement; // PlacementOutput (when denied + autoGate)
gate.state;          // full EntitlementGateState snapshot
```

### Reactive Updates

```ts
const unsub = gate.onChange(() => {
  updateAccessUI(gate.state);
});

await gate.recheck(); // re-run the check
```

## Framework Integration Patterns

### Vanilla JS / Web Components

```ts
const session = await initRevTurbine({ /* ... */ });

const banner = session.placement({ surfaceSlot: { id: 'top_banner' } });
banner.onChange(() => {
  const el = document.getElementById('banner');
  if (!el) return;
  el.style.display = banner.visible ? 'block' : 'none';
  if (banner.content) {
    el.innerHTML = banner.content.headline || '';
  }
});
await banner.load();

document.getElementById('dismiss-btn')?.addEventListener('click', () => {
  banner.dismiss();
});
```

### Vue 3 (Composition API)

```ts
import { ref, onMounted, onUnmounted } from 'vue';
import { initRevTurbine } from '@revt-eng/web-sdk/headless';

export function usePlacement(slotId: string) {
  const state = ref({ visible: false, content: null });
  let unsub: (() => void) | undefined;

  onMounted(async () => {
    const session = await initRevTurbine({ /* ... */ });
    const ctrl = session.placement({ surfaceSlot: { id: slotId } });
    unsub = ctrl.onChange(() => {
      state.value = { visible: ctrl.visible, content: ctrl.content };
    });
    await ctrl.load();
  });

  onUnmounted(() => unsub?.());
  return state;
}
```

### Svelte

```ts
import { writable } from 'svelte/store';
import { initRevTurbine } from '@revt-eng/web-sdk/headless';

export function createPlacementStore(slotId: string) {
  const store = writable({ visible: false, content: null });

  (async () => {
    const session = await initRevTurbine({ /* ... */ });
    const ctrl = session.placement({ surfaceSlot: { id: slotId } });
    ctrl.onChange(() => {
      store.set({ visible: ctrl.visible, content: ctrl.content });
    });
    await ctrl.load();
  })();

  return store;
}
```

## Interactive Sandpack Demos

Three interactive headless scenarios are available in the [Sandpack demo page](../pages-build/):

1. **Headless Placement** — Initialize a session, load a placement, and interact with it.
2. **Headless Entitlement Gate** — Check feature access and display a gated placement.
3. **Headless Session** — Full session lifecycle: identify, context, placements, and entitlements.

## Comparison: Headless vs React

| Concern | React hooks | Headless controllers |
|---|---|---|
| State management | React `useState` | Manual via `onChange()` |
| Lifecycle | `useEffect` | Explicit `load()` / `check()` |
| Cleanup | Hook unmount | Call `unsub()` / `reset()` |
| Framework | React only | Any JS runtime |
| Bundle | Includes React dep | Zero framework deps |

The React hooks (`usePlacement`, `useEntitlement`) delegate to the headless controllers internally — they share the same business logic.
