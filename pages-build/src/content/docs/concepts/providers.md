---
title: Provider Architecture
description: How the SDK's provider pattern lets you supply custom placement, entitlement, and identity logic.
---

The SDK uses a **provider pattern** to decouple business logic from data sources. A provider is a plain object that implements one or more domain methods — placement resolution, entitlement checks, placement type persistence, and user identification.

## The Provider Interface

```ts
interface RevTurbineSdkProvider {
  getPlacement?: (config: RevTurbinePlacementRequestConfig) => Promise<PlacementOutput | null>;
  checkEntitlement?: (handle: string, context?: RevTurbineEntitlementContext) => Promise<EntitlementResult>;
  persistPlacementTypes?: (types: RevTurbinePlacementTypeEntity[]) => Promise<void>;
  identify?: (userId: string, contextOrTraits?: UserContextInput | SdkTraits) => void;
}
```

Every method is optional. Implement only the domains you need to customize — the SDK falls back to its built-in local runtime for anything you don't provide.

## Domain Methods

### `getPlacement`

Resolves a placement for a given slot and surface type. Called by `FixedSurfaceSlot`, `AccessGateSurfaceSlot`, `MessageSurfaceSlot`, and the headless API.

```ts
const analyticsProvider: RevTurbineSdkProvider = {
  async getPlacement(config) {
    // config.slotId — the slot requesting a placement
    // config.surfaceType — the surface type (button, modal, banner, etc.)
    // config.entitlementHandle — for access gate slots

    // Example: fetch from your own decisioning API
    const res = await fetch(`/api/placements/${config.slotId}`);
    if (!res.ok) return null;
    return res.json();
  },
};
```

**Input — `RevTurbinePlacementRequestConfig`:**

| Field | Type | Description |
|---|---|---|
| `slotId` | `string?` | Slot identifier |
| `surfaceType` | `string?` | Surface type (`button`, `modal`, `banner`, etc.) |
| `entitlementHandle` | `string?` | Entitlement to check (access gates) |
| `planHandle` | `string?` | Plan-specific placements |
| `placementHandle` | `string?` | Chaining from a prior CTA path |

**Return:** `PlacementOutput | null` — the resolved placement, or `null` if no placement matches.

### `checkEntitlement`

Checks whether the current user has access to a feature. Called by `AccessGateSurfaceSlot` and `sdk.checkEntitlement()`.

```ts
const entitlementProvider: RevTurbineSdkProvider = {
  async checkEntitlement(handle, context) {
    // handle — e.g. "data_export", "brand_kit"
    // context — optional entitlement context

    const res = await fetch(`/api/entitlements/${handle}`);
    const data = await res.json();
    return {
      status: data.allowed ? 'allowed' : 'denied',
      allowed: data.allowed,
    };
  },
};
```

**Return — `EntitlementResult`:**

| Field | Type | Description |
|---|---|---|
| `status` | `string` | `'allowed'`, `'denied'`, `'usage_capped'`, etc. |
| `allowed` | `boolean` | Whether access is granted |

### `persistPlacementTypes`

Stores placement type metadata. Called during SDK initialization to register built-in and custom slot types.

```ts
const storageProvider: RevTurbineSdkProvider = {
  async persistPlacementTypes(types) {
    // types — array of { id, label, description, surfaceType, priority }
    await fetch('/api/placement-types', {
      method: 'POST',
      body: JSON.stringify(types),
    });
  },
};
```

### `identify`

Called when a user is identified or their context changes. Use this for analytics, session tracking, or syncing identity to your backend.

```ts
const identityProvider: RevTurbineSdkProvider = {
  identify(userId, contextOrTraits) {
    analytics.identify(userId, contextOrTraits);
  },
};
```

## Using a Provider

Pass your provider via the `provider` option:

```tsx
import { RevTurbineProvider } from '@revturbine/sdk';
import exportedConfig from './exported_config.json';
import { useMemo } from 'react';

const myProvider = {
  async getPlacement(config) {
    const res = await fetch(`/api/placements/${config.slotId}`);
    if (!res.ok) return null;
    return res.json();
  },
  async checkEntitlement(handle) {
    const res = await fetch(`/api/entitlements/${handle}`);
    const data = await res.json();
    return { status: data.allowed ? 'allowed' : 'denied', allowed: data.allowed };
  },
};

function App() {
  const options = useMemo(() => ({
    localRuntime: { exportedConfig },
    provider: myProvider,
  }), []);

  return (
    <RevTurbineProvider options={options}>
      {/* slots will call myProvider.getPlacement() */}
    </RevTurbineProvider>
  );
}
```

## Provider Factory

If your provider needs access to the SDK's init options, use a factory function:

```ts
const myProviderFactory = (options) => ({
  async getPlacement(config) {
    // options.localRuntime, options.user, etc. are available here
    return null;
  },
});

const options = {
  localRuntime: { exportedConfig },
  provider: myProviderFactory,
};
```

## Fallback Chain

The SDK supports a chain of providers. If the primary provider returns `null` or throws, the next one is tried:

```tsx
const options = useMemo(() => ({
  localRuntime: { exportedConfig },
  provider: apiProvider,
  providerFallbacks: [cachedProvider, staticFallback],
}), []);
```

If all providers fail:

| Behavior | Result |
|---|---|
| `'invisible'` (default) | Slots render nothing |
| `'placeholder'` | Slots show fallback content |

Entitlement checks always fail-open to `{ allowed: true }` to avoid blocking users.

## Analytics Provider

The SDK can forward all impressions, interactions, and lifecycle events to your analytics platform (Segment, Heap, Amplitude, PostHog, Mixpanel, or any custom sink). Use `createAnalyticsProvider()` to create a domain provider that receives every SDK event.

### Basic Setup

```tsx
import { RevTurbineProvider, createAnalyticsProvider } from '@revturbine/sdk';
import exportedConfig from './exported_config.json';
import { useMemo } from 'react';

function App() {
  const options = useMemo(() => {
    const analytics = createAnalyticsProvider({
      handler: (eventName, properties) => {
        // Push to your analytics platform
        window.analytics.track(eventName, properties);
      },
    });

    return {
      localRuntime: { exportedConfig },
      domainProviders: [analytics],
    };
  }, []);

  return (
    <RevTurbineProvider options={options}>
      {/* All impressions and interactions now flow to Segment */}
    </RevTurbineProvider>
  );
}
```

### Events Captured

The analytics provider receives every SDK event, including:

| Event | When |
|---|---|
| `placement_interaction` | A placement is shown, clicked, or dismissed |
| `placement_dismissed` | User closes a placement |
| `placement_converted` | User completes a CTA |
| `placement_snoozed` | User clicks "remind me later" |
| `page_view` | Page navigation |
| Trigger events | `trial_expiring`, `usage_limit_reached`, etc. |

Each event includes `user_id`, `anonymous_id`, `session_id`, `placement_id`, `interaction_type`, `url`, `page_title`, and the full event properties.

### Filtering Events

Only forward the events you care about:

```ts
const analytics = createAnalyticsProvider({
  handler: (eventName, properties) => {
    heap.track(eventName, properties);
  },
  filter: ['placement_interaction', 'placement_dismissed', 'placement_converted'],
});
```

### Transforming Events

Rename events, enrich properties, or drop events with a `transform` function. Return `null` to suppress an event.

```ts
const analytics = createAnalyticsProvider({
  handler: (name, props) => posthog.capture(name, props),
  transform: (name, props) => ({
    eventName: `revturbine.${name}`,
    properties: { ...props, source: 'revturbine-sdk' },
  }),
});
```

### Platform Examples

**Segment:**

```ts
const analytics = createAnalyticsProvider({
  handler: (eventName, properties) => {
    window.analytics.track(eventName, properties);
  },
});
```

**Heap:**

```ts
const analytics = createAnalyticsProvider({
  handler: (eventName, properties) => {
    heap.track(eventName, properties);
  },
  filter: ['placement_interaction', 'placement_dismissed', 'placement_converted'],
});
```

**Amplitude:**

```ts
const analytics = createAnalyticsProvider({
  handler: (eventName, properties) => {
    amplitude.track(eventName, properties);
  },
});
```

**PostHog (with prefix):**

```ts
const analytics = createAnalyticsProvider({
  handler: (name, props) => posthog.capture(name, props),
  transform: (name, props) => ({
    eventName: `revturbine.${name}`,
    properties: props,
  }),
});
```

## Next Steps

- [Runtime Modes](/guides/runtime-modes/) — choosing the right runtime mode
- [Component Gallery](/components/) — interactive demos of every built-in slot
- [API Reference](/api/) — full TypeDoc reference for all exports
