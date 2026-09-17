---
title: Configuration Reference
description: Complete InitOptions specification — all configurable parameters with defaults and mode-specific requirements.
---

Complete reference for `RevTurbineInitOptions` and related configuration types.

## RevTurbineInitOptions

### Required Fields

Required in `revturbine_server` and `custom_endpoints` modes. In `local_only` mode all four are optional — `initRevTurbine({ runtimeMode: 'local_only', localRuntime: { playbook } })` is a complete configuration.

| Field | Type | Description |
|---|---|---|
| `tenantId` | `string` | Your RevTurbine tenant identifier |
| `apiKey` | `string` | API key (`rt_live_*` or `rt_test_*`) |
| `endpoint` | `string` | RevTurbine API endpoint URL |
| `mode` | `'react' \| 'snippet' \| 'iframe'` | SDK integration mode |

### Runtime Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `runtimeMode` | `'revturbine_server' \| 'custom_endpoints' \| 'local_only'` | `'revturbine_server'` | How the SDK resolves decisions |
| `endpointOverrides` | `Partial<RevTurbineEndpointOverrides>` | — | Route the SDK's non-decision calls through your own endpoints (`custom_endpoints` mode) |
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
| `user` | `RevTurbineUserContext` | — | Initial user context. `plan_handle` is the plan's `unique_handle` — the value plan-scoped rules match on |
| `clientSession` | `() => string \| Promise<string>` | — | Mints a client-session token so the SDK keeps server-derived context fresh on its own. See [Server-derived context](#server-derived-context-clientsession) |
| `page` | `RevTurbinePageContext` | — | Page context (URL, title, referrer, tags) |
| `contextPolicy` | `RevTurbineContextPolicy` | `{ inferUser: true, inferPage: true, routerAutoTrack: true }` | Auto-inference behavior |

### Server-derived context (`clientSession`)

Your app tells RevTurbine who the user is. Some of that state, though, is only
knowable on your server — the plan a Stripe webhook just changed, trial status,
a payment that failed. `clientSession` is how the SDK gets it without you
wiring a refresh loop.

Supply a function that returns a client-session token minted by your backend
(`POST /api/sdk/client-sessions`). The SDK calls it when it first needs a
token, again after `identify()`, and again if the control plane reports one
expired — then fetches `GET /api/sdk/client-context` and folds the result into
its decisions. **A purchase updates what the user can do with no further app
code.**

```ts
initRevTurbine({
  tenantId: 'tenant_abc',
  apiKey: 'rt_live_…',
  endpoint: 'https://revturbine.com/app',
  user: { id: 'user_123', plan_handle: 'free' },
  clientSession: () =>
    fetch('/api/revturbine-session', { method: 'POST' })
      .then((r) => r.json())
      .then((j) => j.client_token),
});
```

It is a **function, not a token**, because these tokens are short-lived (~10
minutes) — a value captured at init would go stale mid-session, and refreshing
it would become your problem.

The token is a transport credential, never user context: held in memory only,
never persisted, never logged, never placed in a URL. If your minter throws or
the fetch fails, the SDK keeps using the context your app supplied — enrichment
is best-effort and never breaks your app.

Omit `clientSession` and none of this happens: no token is requested and no
client-context call is made. Server-derived context is opt-in.

### Behavioral Flags

| Field | Type | Default | Description |
|---|---|---|---|
| `placementBehavior` | `Partial<RevTurbinePlacementBehaviorFlags>` | derived from the Playbook | Overrides for flags the SDK derives from what the Playbook authors (see below) |

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
| `userContextByUserId` | `Record<string, UserTargetingContext>` |
| `trialStatus` | `RevTurbineTrialContext` |

Entitlement grants are evaluated from `localRuntime.playbook`. For a custom
source, implement the documented `checkEntitlement` resolver; do not seed
grants through `initialData`.

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

Each flag is derived from the loaded Playbook; an explicit value in `placementBehavior` overrides the derivation. You rarely need to set them.

| Flag | Type | Derived default | Description |
|---|---|---|---|
| `enableClientCapsEnforcement` | `boolean` | `true` when any placement payload authors a cap, cooldown, or remind-later | Client-side cap enforcement |
| `enableAutoGatedPlacement` | `boolean` | `true` when the Playbook has a `gated` placement | Auto-render gated placements |
| `enableTrialAutoTriggers` | `boolean` | `true` when the Playbook has a `trials` placement | Auto-derive trial lifecycle triggers |

---

## RevTurbineEndpointOverrides

The calls the SDK makes over the network, and the key that reroutes each one in `custom_endpoints` mode. None of them is a decision — entitlements and placements are evaluated inside your app in every mode. A relative value is appended to `endpoint`; an absolute URL replaces it.

| Key | What it carries | Default path |
|---|---|---|
| `clientContext` | Server-derived user context, read with an `rt_client_` session token | `/api/sdk/client-context` |
| `userContext` | User context read | `/api/sdk/user-context` |
| `trialStatus` | Trial status read | `/api/sdk/trial-status` |
| `ingestEvents` | Clickstream events (`track` / `capture`) | `/api/track` |
| `touchpointTransition` | Placement interactions — impression, dismiss, CTA | `/api/events/interactions` |
| `ingestSdkMeta` | The anonymous `sdk_init` beacon | `/api/sdk/meta` |
| `surfaceSlots` | Surface-slot inventory registration | `/api/placements` |
| `placementTypes` | Custom placement-type persistence — meaningful only when overridden | `/api/sdk/placement-types` |

Not overridable: **Playbook delivery**. The SDK fetches the launched Playbook from `endpoint` directly (`/api/sdk/bootstrap`, then the signed manifest and bundle), so `custom_endpoints` routes context and telemetry through your proxy but not the Playbook itself.

The type also declares `decide`, `decideContext`, `bootstrapContext`, `getPlacement` and `checkEntitlement`. They are retired: the SDK never reads them, because there is no decision endpoint. They remain on the type so existing configurations still compile.

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

```ts docs-check=false reason="required-field shape sketch, not a value"
{
  tenantId: string;   // ✅ Required
  apiKey: string;     // ✅ Required (rt_live_* or rt_test_*)
  endpoint: string;   // ✅ Required
  mode: string;       // ✅ Required
}
```

### `local_only`

```ts docs-check=false reason="required-field shape sketch, not a value"
{
  runtimeMode: 'local_only';         // ✅ Required
  localRuntime: {
    playbook: Playbook;   // ✅ Required
  };
  // tenantId, apiKey, endpoint, mode — optional; no account or key is needed
}
```

### `custom_endpoints`

```ts docs-check=false reason="required-field shape sketch, not a value"
{
  tenantId: string;                   // ✅ Required
  apiKey: string;                     // ✅ Required
  endpoint: string;                   // ✅ Required
  mode: string;                       // ✅ Required
  runtimeMode: 'custom_endpoints';   // ✅ Required
  endpointOverrides: {               // ✅ At least one override required
    clientContext?: string;
    ingestEvents?: string;
    touchpointTransition?: string;
  };
}
```

## Related

- [Runtime Modes](/guides/runtime-modes/) — mode comparison and migration
- [Error Codes Reference](/reference/errors/) — error handling options
