---
title: Error Handling
description: SDK error model, additive placements, fail-closed entitlement checks, provider failure cascade, and graceful degradation patterns.
sidebar:
  order: 11
---

import { Aside } from '@astrojs/starlight/components';

The SDK never throws into your app and never blocks your render. But *placements* and *entitlement checks* degrade in opposite directions, on purpose: a placement that can't resolve **renders nothing**, while an entitlement check that can't resolve **denies**.

## Two degradation modes

**Placements are additive.** If RevTurbine is paused, misconfigured, or unreachable, a slot renders nothing (or your configured fallback) — it can never take your product down.

**Entitlement checks are fail-closed.** If a check can't produce an affirmative grant, it returns `{ status: 'denied', allowed: false }` rather than granting access. The Playbook is cached and persisted locally, so a configured runtime evaluates real allow/deny answers with no network round-trip; the failure fallback only fires when the SDK has *no basis to answer at all* — no config, no cache, nothing reachable — which is exactly where denying is the safe, non-leaking default. The `reason` code is preserved so you can still tell an outage apart from a real denial.

| API failure scenario | SDK behavior |
|---|---|
| API unreachable | Placements return `visible: false` |
| Entitlement check fails | Returns `{ status: 'denied', allowed: false, reason: 'entitlement_service_unavailable' }` |
| Config fetch fails | Falls back to cached Playbook; with none, entitlement checks deny |
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
await sdk.can('data_export');

// Silently drops event on delivery failure
await sdk.track('page_viewed');

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
| `config_not_loaded` | Playbook not yet available |
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
      <Slot id="dashboard_banner" surfaceType="banner" />
    </div>
  );
}
```

If the SDK is down, `<Slot>` renders nothing and the baseline dashboard continues working.

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
