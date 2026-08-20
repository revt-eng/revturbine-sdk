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
| Entitlement check fails | Returns `{ status: 'denied', allowed: false, reason: 'config_unavailable' }` |
| Config fetch fails | Falls back to cached Playbook; with none, entitlement checks deny |
| Event delivery fails | Events are buffered and retried silently |

## Error Surface

### Hook Level

Hooks expose errors as strings — they never throw:

```tsx
const { error, isLoading } = usePlacement({ placement: { name: 'hero_banner' } });
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
    ...options,
    providerFailureSlotBehavior: 'invisible', // default
  }}
>
  <YourApp />
</RevTurbineProvider>
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
const { decision } = usePlacement({ placement: { name: 'hero_banner' } });

if (decision?.reason_codes?.includes('cap_limit_exceeded')) {
  // User has seen this placement too many times
}
```

## Entitlement Reason Codes

Entitlement checks are **fail-closed**. When the SDK cannot produce an
affirmative grant — the Playbook never arrived, no rule grants the entitlement
to the user's plan, the SDK was disabled — it returns
`{ status: 'denied', allowed: false }` with a `reason` naming the cause. It
never defaults to allowed. Treat `allowed` as the answer and `reason` as the
explanation; the codes below are the complete set the SDK emits.

### Denied because a rule said so

| Reason | Meaning |
|---|---|
| `no_matching_entitlement_rule` | No rule grants this entitlement to the user's plan. Plan targeting is explicit — an entitlement with no enabling rule for that plan is not granted. |
| `feature_not_enabled_for_plan` | A matching `feature` rule has `enabled: false`. |
| `usage_limit_reached` | The user is at or over a `usage_limit` rule's limit. |
| `credit_balance_exhausted` | The user is at or over a `credits` rule's allowance. |

`usage_limit_reached` and `credit_balance_exhausted` carry a suffix reflecting
the rule's `enforcement` mode:

| Suffix | `enforcement` | Outcome |
|---|---|---|
| *(none)* | unset | `limited`, **not** allowed |
| `_soft_block` | `soft_block` | `denied` — render the upsell placement |
| `_degraded` | `degrade` | `limited` but **allowed** (throttled, not blocked) |
| `_overage` | `allow_overage` | `allowed` — metered overage |

### Denied because the SDK could not decide

| Reason | Meaning |
|---|---|
| `config_unavailable` | The launched Playbook could not be fetched (Server mode). Not a rule decision — an infrastructure failure. |
| `entitlement_not_in_playbook` | Local mode with no Playbook and no cached result: nothing describes this entitlement, so there is no basis to grant it. |
| `sdk_disabled_provider_failure` | The SDK disabled itself after a provider failure. |

### Allowed with a reason

| Reason | Meaning |
|---|---|
| `granted_by_reverse_trial` | Granted by an active reverse trial rather than by the user's plan. |

:::note[Renamed in 0.3.0]
`local_runtime_default_allow` is now `entitlement_not_in_playbook`. The old name
stated a verdict the result does not have — it denies — and was also emitted by
the headless runtime on an *allowed* result, so one code meant opposite things
on two surfaces. There is no deprecated alias; update any `switch` on the old
string.
:::

:::caution[Two entitlement types are not gates]
`price_per_unit` and `rate_limit` entitlements always evaluate to allowed. This
is by design and is the one explicit carve-out from the fail-closed rule: they
are **non-gating metadata**, present to populate text tokens (an overage price
in upgrade copy, a documented rate ceiling), not to control access. Do not gate
a feature on one of them — a `price_per_unit` check answering "allowed" tells
you the price exists, not that the user may proceed.
:::

## Retry Behavior

| Operation | Retry Strategy |
|---|---|
| Placement resolution | No auto-retry. Call `refresh()` to retry manually. |
| Entitlement check | No auto-retry. Call `recheck()` to retry manually. |
| Event delivery | Auto-buffered and retried on next batch interval. |
| Config fetch | Falls back to cached config. Retried on next SDK initialization. |

### Manual Retry

```tsx
const { refresh, error } = usePlacement({ placement: { name: 'hero_banner' } });
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
      <Slot id="dashboard_banner" />
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
