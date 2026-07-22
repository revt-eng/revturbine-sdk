---
title: Configuration Reference
description: Complete InitOptions specification — all configurable parameters with defaults and mode-specific requirements.
---

Complete reference for `RevTurbineInitOptions` and related configuration types.

## RevTurbineInitOptions

### Required Fields

| Field | Type | Description |
|---|---|---|
| `tenantId` | `string` | Your RevTurbine tenant identifier |
| `apiKey` | `string` | API key (`rt_live_*`, `rt_test_*`, or `'local'` for local mode) |
| `endpoint` | `string` | RevTurbine API endpoint URL |
| `mode` | `'react' \| 'snippet' \| 'iframe'` | SDK integration mode |

### Runtime Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `runtimeMode` | `'revturbine_server' \| 'custom_endpoints' \| 'local_only'` | `'revturbine_server'` | How the SDK resolves decisions |
| `endpointOverrides` | `Partial<RevTurbineEndpointOverrides>` | — | Custom endpoint URLs (for `custom_endpoints` mode) |
| `configProvider` | `RevTurbineConfigProvider` | — | Custom provider for Playbook |
| `localRuntime` | `RevTurbineLocalRuntimeOptions` | — | Local-only mode configuration |

### Provider Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | `RevTurbineSdkProvider \| RevTurbineProviderFactory` | — | Primary provider override |
| `providerFallbacks` | `Array<...>` | — | Fallback provider chain |
| `domainProviders` | `AnyDomainProvider[]` | — | Domain-specific providers |
| `providerFailureSlotBehavior` | `'placeholder' \| 'invisible'` | `'invisible'` | Slot behavior after provider failure |

### UI Path Handling

| Field | Type | Default | Description |
|---|---|---|---|
| `uiPathResolvers` | `RevTurbineUiPathResolverMap` | — | Map of CTA action types to resolver functions |

### User & Page Context

| Field | Type | Default | Description |
|---|---|---|---|
| `user` | `RevTurbineUserContext` | — | Initial user context |
| `page` | `RevTurbinePageContext` | — | Page context (URL, title, referrer, tags) |
| `contextPolicy` | `RevTurbineContextPolicy` | `{ inferUser: true, inferPage: true, routerAutoTrack: true }` | Auto-inference behavior |

### Behavioral Flags

| Field | Type | Default | Description |
|---|---|---|---|
| `placementBehavior` | `Partial<RevTurbinePlacementBehaviorFlags>` | — | Opt-in pipeline flags |

### Storage

| Field | Type | Default | Description |
|---|---|---|---|
| `persistentStorage` | `RevTurbineStorage` | `localStorage` | Persistent storage override |
| `sessionStorage` | `RevTurbineStorage` | `sessionStorage` | Session storage override |

---

## RevTurbineContextPolicy

| Field | Type | Default | Description |
|---|---|---|---|
| `inferUser` | `boolean` | `true` | Auto-detect user info from browser APIs |
| `inferPage` | `boolean` | `true` | Auto-capture URL, title, referrer |
| `routerAutoTrack` | `boolean` | `true` | Track SPA route changes |

---

## RevTurbineLocalRuntimeOptions

| Field | Type | Description |
|---|---|---|
| `playbook` | `Playbook` | Full Playbook snapshot for local execution |
| `placements` | `LocalPlacementDataset` | Optional static placements dataset |
| `initialData` | `object` | Static data for local decisions (see below) |
| `resolvers` | `object` | Optional resolver callbacks (see below) |
| `storageKey` | `string` | Optional localStorage key override |
| `getContext` | `() => Promise<JsonObject>` | Reactive context callback |

### initialData

| Field | Type |
|---|---|
| `placementDecisionsByPlacementId` | `Record<string, RevTurbinePlacementDecision>` |
| `placementsByLookupKey` | `Record<string, PlacementOutput \| null>` |
| `entitlementByHandle` | `Record<string, EntitlementResult>` |
| `userContextByUserId` | `Record<string, UserTargetingContext>` |
| `trialStatus` | `RevTurbineTrialContext` |

### resolvers

| Field | Signature |
|---|---|
| `getPlacementDecision` | `(input, placement?, context?) => Promise<RevTurbinePlacementDecision>` |
| `getPlacement` | `(config) => Promise<PlacementOutput \| null>` |
| `checkEntitlement` | `(handle, context?) => Promise<EntitlementResult>` |
| `fetchUserContext` | `(userId) => Promise<UserTargetingContext>` |
| `getTrialStatus` | `() => Promise<RevTurbineTrialContext>` |
| `resolveExportedConfig` | `() => Promise<Playbook>` |

---

## RevTurbinePlacementBehaviorFlags

| Flag | Type | Default | Description |
|---|---|---|---|
| `enableClientCapsEnforcement` | `boolean` | `false` | Client-side cap enforcement |
| `enableAutoGatedPlacement` | `boolean` | `false` | Auto-render gated placements |
| `enableTrialAutoTriggers` | `boolean` | `false` | Auto-derive trial lifecycle triggers |

---

## RevTurbineEndpointOverrides

Override individual API endpoints for `custom_endpoints` mode:

| Field | Default Path |
|---|---|
| `decideContext` | `/api/decide-context` |
| `bootstrapContext` | `/api/bootstrap-context` |
| `decide` | `/api/decide` |
| `getPlacement` | `/api/placement` |
| `checkEntitlement` | `/api/entitlement` |
| `userContext` | `/api/user-context` |
| `trialStatus` | `/api/trial-status` |
| `ingestEvents` | `/api/events` |
| `touchpointTransition` | `/api/touchpoint-transition` |
| `placementTypes` | `/api/placement-types` |
| `surfaceSlots` | `/api/surface-slots` |

---

## RevTurbineStorage

Interface for custom storage providers:

```ts
interface RevTurbineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
```

---

## Mode-Specific Required Fields

### `revturbine_server` (default)

```ts
{
  tenantId: string;   // ✅ Required
  apiKey: string;     // ✅ Required (rt_live_* or rt_test_*)
  endpoint: string;   // ✅ Required
  mode: string;       // ✅ Required
}
```

### `local_only`

```ts
{
  tenantId: string;                   // ✅ Required (can be 'demo')
  apiKey: string;                     // ✅ Required (can be 'local')
  endpoint: string;                   // ✅ Required (can be 'http://localhost')
  mode: string;                       // ✅ Required
  runtimeMode: 'local_only';         // ✅ Required
  localRuntime: {
    playbook: Playbook;   // ✅ Required
  };
}
```

### `custom_endpoints`

```ts
{
  tenantId: string;                   // ✅ Required
  apiKey: string;                     // ✅ Required
  endpoint: string;                   // ✅ Required
  mode: string;                       // ✅ Required
  runtimeMode: 'custom_endpoints';   // ✅ Required
  endpointOverrides: {               // ✅ At least one override required
    decide?: string;
    getPlacement?: string;
    checkEntitlement?: string;
  };
}
```

## Related

- [Runtime Modes](/guides/runtime-modes/) — mode comparison and migration
- [Error Codes Reference](/reference/errors/) — error handling options
