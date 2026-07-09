---
title: Events & Analytics
description: Track user interactions, behavioral signals, and placement lifecycle events.
sidebar:
  order: 10
---

import { Aside } from '@astrojs/starlight/components';

The SDK tracks placement impressions and interactions automatically. You can also emit custom events and trigger events for behavioral signals.

## Automatic Tracking

The SDK tracks these events automatically when using React components or headless controllers:

| Event | When | Data |
|---|---|---|
| **Impression** | Placement becomes visible | `placementId`, `templateId`, `userId` |
| **Dismiss** | User dismisses a placement | `placementId`, `interactionType: 'dismiss'` |
| **CTA Click** | User clicks primary CTA | `placementId`, `interactionType: 'cta_clicked'` |
| **CTA Complete** | User completes the CTA flow | `placementId`, `interactionType: 'cta_completed'` |
| **Snooze** | User chooses "remind me later" | `placementId`, `interactionType: 'remind_me_later'` |

You don't need to instrument these — the slot components and hooks handle it.

## Custom Events

Track any behavioral signal with `track`:

```ts
const { sdk } = useRevTurbine();

// Track a custom event
await sdk.track('feature_explored', {
  feature: 'advanced_filters',
  source: 'sidebar_menu',
});

// Track a conversion signal
await sdk.track('checkout_completed', {
  plan: 'professional',
  billing_cycle: 'annual',
  revenue: 99.00,
});
```

### Event Properties

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Event name (use `snake_case`) |
| `data` | `Record<string, string \| number \| boolean>` | Optional event properties |

## Trigger Events

Trigger events are semantic lifecycle signals that the SDK uses to evaluate targeting rules. When you emit a trigger, the SDK re-evaluates all active placements.

### Built-In Trigger Types

| Trigger | When to Emit |
|---|---|
| `trial_started` | User begins a free trial |
| `trial_expiring` | Trial is ending soon |
| `trial_expired` | Trial has ended |
| `usage_limit_approaching` | Usage is near the limit (e.g., 80%) |
| `usage_limit_exceeded` | Usage has exceeded the limit |
| `feature_gated` | User hit a feature gate |
| `payment_retry_required` | Payment failed, retry needed |
| `subscription_renewing` | Subscription is about to renew |

### Emitting Triggers

```ts
// Trial lifecycle
await sdk.emitTrigger('trial_expiring', {
  days_remaining: 2,
});

// Usage limits
await sdk.emitTrigger('usage_limit_approaching', {
  entitlement_handle: 'api_calls',
  current_usage: 9500,
  usage_limit: 10000,
  usage_percent: 95,
});

// Feature gating
await sdk.emitTrigger('feature_gated', {
  feature: 'advanced_automation',
});
```

:::tip
Trigger events are the primary way to activate message-type placements (toasts, banners, modals). Targeting rules in the RevTurbine dashboard reference these triggers to decide when to show a placement.
:::

## Treatment Interactions

Record interactions with placement decisions directly (useful for headless or custom implementations):

```ts
await sdk.trackTreatmentInteraction({
  userId: 'user_123',
  placementId: 'placement_abc',
  interactionType: 'cta_clicked',
  treatmentId: 'treatment_xyz',
  metadata: { source: 'email_footer' },
});
```

### Interaction Types

| Type | Meaning | Effect |
|---|---|---|
| `dismiss` | User closed/dismissed the placement | Suppresses for cooldown period |
| `remind_me_later` | User chose to be reminded | Suppresses for specified duration |
| `cta_clicked` | User clicked the primary CTA | Records conversion signal |
| `cta_completed` | User finished the CTA flow | Suppresses further prompts |
| `suppress` | Programmatic suppression | Suppresses immediately |

## Impression History

The SDK maintains a local impression history to enforce:

- **Cooldown periods** — how long after a dismiss/snooze before showing again
- **Cap policies** — maximum impressions per session/day/week/month/lifetime
- **Suppression state** — which placements are currently suppressed

This state is persisted to localStorage and survives page reloads.

Inspect suppression state using the headless `PlacementController`:

```ts
const ctrl = session.placement({ surfaceSlot: { id: 'placement_abc' } });
await ctrl.load();
// ctrl.visible reflects suppression, cap limits, and targeting
console.log('Visible:', ctrl.visible);
```

## Event Batching

Events are batched and sent to the RevTurbine API in intervals to minimize network overhead. In `local_only` mode, events are stored locally but not sent to the server.

## Next Steps

- [Placements Guide](/guides/placements/) — placement lifecycle and interactions
- [Error Handling](/guides/error-handling/) — handling event delivery failures
