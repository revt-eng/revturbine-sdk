# Headless API Guide

Framework-agnostic SDK controllers for placement decisioning, entitlement gating, and user context management. Use these when you don't want React — or when you need full imperative control.

## Quick Start

```ts
import { initRevTurbine } from '@revt-eng/sdk/headless';

const session = await initRevTurbine({
  tenantId: 'tenant_abc',
  apiKey: 'rt_live_xxx',
  endpoint: 'https://api.revturbine.io',
  user: { id: 'user_123', plan: { id: 'pro' } },
});
```

The returned `SdkSession` is your entry point for everything below.

---

## PlacementController

Manages the full lifecycle of a single placement: register → decide → render → interact.

### Create and load

```ts
const banner = session.placement({
  surfaceSlot: { id: 'dashboard_top_banner', name: 'dashboard_top_banner' },
});

await banner.load();

if (banner.visible) {
  console.log(banner.content);
  // { header: 'Upgrade to Pro', body: '...', cta_label: 'See plans' }
}
```

### Subscribe to state changes

```ts
const unsubscribe = banner.onChange(() => {
  console.log('State changed:', banner.state);
  // { isLoading, error, placementId, visible, decision, content }
});

// Later:
unsubscribe();
```

### User interactions

```ts
// Dismiss (default 24h cooldown)
await banner.dismiss();

// Dismiss with custom cooldown (1 hour)
await banner.dismiss(3_600_000);

// Snooze ("remind me later", default 1h)
await banner.snooze();
await banner.snooze(7200); // 2 hours

// CTA click (does NOT hide the placement)
await banner.ctaClick('/plans');

// CTA complete (hides the placement)
await banner.ctaComplete('/plans');

// Re-fetch with fresh impression tracking
await banner.refresh();

// Clear all state
banner.reset();
```

### Options reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `surfaceSlot` | `{ id, name }` | — | Surface slot to register. Use this or `placement`. |
| `placement` | `{ name, ... }` | — | Placement config to register. Use this or `surfaceSlot`. |
| `userId` | `string` | from SDK context | Override the user ID for this placement. |
| `contextMode` | `'auto' \| 'server' \| 'local' \| 'offline'` | `'auto'` | Context resolution mode. |
| `overrides` | `object` | — | Decision overrides (e.g. `planHandle`). |
| `traits` | `Record<string, string \| number \| boolean>` | — | Extra traits for targeting. |
| `ttlMs` | `number` | — | Decision cache TTL in milliseconds. |
| `autoTrackImpression` | `boolean` | `true` | Auto-track impression on visible decisions. |

---

## EntitlementGate

Checks entitlement access and optionally fetches a gated placement.

### Check access

```ts
const gate = session.entitlement({
  handle: 'brand_kit',
  autoGate: true,
});

await gate.check();

if (gate.allowed) {
  showBrandKit();
} else if (gate.denied) {
  console.log('Denied — show gate:', gate.gatedPlacement);
} else if (gate.limited) {
  console.log('Approaching limit');
}
```

### Subscribe and recheck

```ts
gate.onChange(() => {
  updateUI(gate.state);
  // { isLoading, error, result, allowed, limited, denied, gatedPlacement }
});

// After a state change (user upgraded, usage changed)
await gate.recheck();
```

### Options reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `handle` | `string` | **required** | Entitlement handle (e.g. `'brand_kit'`, `'data_export'`). |
| `context` | `object` | — | Entitlement context (e.g. `{ requiredTier: 'pro' }`). |
| `autoGate` | `boolean` | `false` | Automatically fetch a gated placement when denied. |
| `gatePlacementRequest` | `object` | — | Custom request config for the gated placement fetch. |

### Auto-gate behavior

When `autoGate: true` and the entitlement is denied:

1. If the entitlement result includes an inline `placement`, it's used directly.
2. Otherwise, the gate calls `sdk.getPlacement({ entitlementHandle })` to fetch one.
3. The result is available as `gate.gatedPlacement`.

---

## SdkSession

The session wraps the SDK instance and provides convenience methods.

### User context

```ts
session.identify('user_456', { plan: { id: 'enterprise' } });
session.setUserContext({ personalization: { company: 'Acme' } });

const ctx = session.getUserContext();
session.updateUsage({ api_calls: 5 });

const trial = await session.getTrialStatus();
const usage = session.getUsage();

session.resetIdentity();
```

### One-shot helpers

For simple fire-and-forget calls that don't need a controller:

```ts
// Quick placement fetch by slot ID
const decision = await session.getPlacementBySlotId('pricing_banner');
if (decision?.visible) {
  renderBanner(decision.content);
}

// Quick entitlement check
const access = await session.checkEntitlement('data_export');
if (access.status === 'denied') {
  showUpgradePrompt();
}

// Raw placement fetch
const output = await session.getPlacement({
  slotId: 'settings_brand_section',
  entitlementHandle: 'brand_kit',
});

// Track custom events
await session.trackEvent('button_clicked', { target: 'upgrade_cta' });
```

---

## initRevTurbine Factory

Creates a fully-initialized session. Handles SDK init, user identification, theme resolution, and optional placement bootstrapping.

```ts
import { initRevTurbine } from '@revt-eng/sdk/headless';

const session = await initRevTurbine({
  // Required
  tenantId: 'tenant_abc',
  apiKey: 'rt_live_xxx',
  endpoint: 'https://api.revturbine.io',
  user: { id: 'user_123', plan: { id: 'pro' } },

  // Optional: preload placement decisions
  bootstrapPlacements: [
    { placement: { name: 'pricing_banner' } },
    { placement: { name: 'upsell_modal' }, ttlMs: 60_000 },
  ],

  // Optional: local runtime mode (no server)
  localRuntime: { exportedConfig },
});
```

### Initialization sequence

1. `initRevTurbineCore(options)` — creates the SDK instance
2. `sdk.identify(userId)` — if `options.user.id` is provided
3. Theme resolution — from `localRuntime.exportedConfig.theme` or server API
4. `sdk.bootstrapPlacementDecisions()` — if `bootstrapPlacements` is provided
5. Returns `SdkSession`

---

## When to use what

| Need | Use |
|------|-----|
| Full lifecycle control over a placement | `session.placement()` → `PlacementController` |
| Entitlement check with auto-gate | `session.entitlement()` → `EntitlementGate` |
| Quick one-shot placement | `session.getPlacementBySlotId()` |
| Quick one-shot entitlement | `session.checkEntitlement()` |
| React components with automatic state | `usePlacement()`, `SurfaceSlotComponent` (from React SDK) |

## Sandpack Demos

Interactive demos are available in the sandpack playground under the **Headless API** group:

- **H-1: PlacementController** — loads a banner placement with dismiss/snooze/refresh interactions
- **H-2: EntitlementGate** — checks `brand_kit` access with auto-gating
- **H-3: SdkSession One-Shot** — combines `getPlacementBySlotId` + `checkEntitlement` in a single view
