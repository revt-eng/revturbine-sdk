---
title: Error Handling
description: SDK error model, fail-open semantics, provider failure cascade, and graceful degradation patterns.
sidebar:
  order: 11
---

import { Aside } from '@astrojs/starlight/components';

The SDK is designed with **fail-open semantics** — when RevTurbine is unreachable, your app's baseline UX continues unaffected. Placements disappear gracefully and entitlement checks default to `allowed`.

## Core Principle: Fail-Open

RevTurbine is an enhancement layer, not a critical dependency. The SDK never blocks your app from functioning:

| API failure scenario | SDK behavior |
|---|---|
| API unreachable | Placements return `visible: false` |
| Entitlement check fails | Returns `{ allowed: true, reason: 'entitlement_service_unavailable' }` |
| Config fetch fails | Falls back to cached config or empty state |
| Event delivery fails | Events are buffered and retried silently |

## Error Surface

### Hook Level

Hooks expose errors as strings — they never throw:

```tsx
const { error, isLoading } = usePlacement({ ... });
const { error: entError } = useEntitlement({ handle: 'data_export' });

if (error) {
  // Non-critical — log and continue
  console.warn('Placement error:', error);
}
```

### Controller Level

Headless controllers surface errors through state:

```ts
const ctrl = new PlacementController(sdk, config);
await ctrl.load();

if (ctrl.state.error) {
  console.warn('Controller error:', ctrl.state.error);
}
```

### SDK Level

Most SDK methods fail silently and return sensible defaults:

```ts
// Returns allowed on API failure
await sdk.checkEntitlement('data_export');

// Silently drops event on delivery failure
await sdk.trackEvent('page_viewed');

// Returns null decision on failure
await sdk.getPlacement({ slotId: 'banner' });
```

## Provider Failure Behavior

When the provider chain is exhausted (all providers failed), slots behave according to `providerFailureSlotBehavior`:

```tsx
<RevTurbineProvider
  options={{
    // ...
    providerFailureSlotBehavior: 'invisible', // default
  }}
>
```

| Value | Behavior |
|---|---|
| `'invisible'` | Slots render nothing — your layout stays intact |
| `'placeholder'` | Slots render fallback placeholder content |

### Recommendation

Use `'invisible'` (default) for production. Placements are additive — your app should work fine without them.

Use `'placeholder'` during development to visually verify that slots are wired correctly even when the provider is down.

## Reason Codes

Placement decisions include `reason_codes` that explain why a placement was hidden or shown:

| Code | Meaning |
|---|---|
| `cap_limit_exceeded` | Impression cap reached |
| `suppressed` | User recently dismissed/snoozed |
| `plan_mismatch` | User's plan doesn't match targeting |
| `segment_mismatch` | User doesn't match targeting segment |
| `config_not_loaded` | ExportedConfig not yet available |
| `api_error` | API returned non-200 |
| `network_error` | Network/timeout failure |
| `fallback_content` | Using fallback placeholder |

### Inspecting Reason Codes

```tsx
const { decision } = usePlacement({ ... });

if (decision?.reason_codes?.includes('cap_limit_exceeded')) {
  // User has seen this placement too many times
}
```

## Entitlement Error Reasons

| Reason | Meaning |
|---|---|
| `entitlement_service_unavailable` | API unreachable — defaulted to allowed |
| `entitlement_check_error` | Parse/exception error — defaulted to allowed |
| `local_runtime_default_allow` | Local mode with no matching entitlement data |

## Retry Behavior

| Operation | Retry Strategy |
|---|---|
| Placement resolution | No auto-retry. Call `refresh()` to retry manually. |
| Entitlement check | No auto-retry. Call `recheck()` to retry manually. |
| Event delivery | Auto-buffered and retried on next batch interval. |
| Config fetch | Falls back to cached config. Retried on next SDK initialization. |

### Manual Retry

```tsx
const { refresh, error } = usePlacement({ ... });
const { recheck, error: entError } = useEntitlement({ handle: 'data_export' });

// Retry after transient failure
if (error) await refresh();
if (entError) await recheck();
```

## Graceful Degradation Pattern

Structure your components so the SDK enhancement is purely additive:

```tsx
function Dashboard() {
  return (
    <div>
      {/* Baseline UX — always works */}
      <DashboardContent />

      {/* SDK enhancement — fails gracefully to nothing */}
      <SurfaceSlotComponent id="dashboard_banner" surfaceType="banner" />
    </div>
  );
}
```

If the SDK is down, `SurfaceSlotComponent` renders nothing and the baseline dashboard continues working.

## Debugging Errors

Enable verbose logging to diagnose issues:

```ts
// In browser console
localStorage.setItem('revturbine:debug', 'true');
```

This logs decision resolution, provider chain evaluation, and error details to the browser console.

## Next Steps

- [Configuration Reference](/reference/configuration/) — error-related configuration options
- [Error Codes Reference](/reference/errors/) — enumerated error codes
