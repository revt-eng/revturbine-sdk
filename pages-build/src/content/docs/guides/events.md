---
title: Events & Analytics
description: Track user interactions, engagement, and placement lifecycle — automatically, declaratively, or by hand — with consent, redaction, and a typed event pipeline.
sidebar:
  order: 10
---

RevTurbine reports what it did — a placement was shown, a CTA was clicked — and, when you opt in, what the user was doing around it. Placement lifecycle is tracked automatically; everything else is opt-in, additive, and privacy-safe by default. An integration that sets no telemetry options behaves exactly as before.

Every event carries a sortable, unique `event_id`, is PII-redacted before it leaves the browser, and is batched and delivered best-effort (a failed send never throws into your app, and a retry resends the identical row so it can't duplicate).

## Automatic tracking

Placement components and headless controllers instrument the placement lifecycle for you — you don't wire these up:

| Event | When |
|---|---|
| `impression` | A placement is presented (see [viewport exposure](#viewport-exposure)) |
| `placement_interaction` | The canonical interaction event, discriminated by `interaction_type`: `dismiss` · `remind_me_later` · `cta_clicked` · `cta_completed` · `suppress` |
| `placement_rendered` / `placement_exposed` | The visual root rendered / entered the viewport (when you attach `exposureRef`) |

`placement_interaction` is the one canonical placement event — earlier standalone `placement_dismissed` / `_snoozed` / `_converted` events are retired.

## Custom events

In React, `useTrack` returns a `track(name, data?, options?)` bound to the surrounding [scope](#scoping-with-telemetryscope). Reserved names (canonical identity + provenance fields) are dropped so you can't overwrite a system value; without a provider, `track` is a safe no-op.

```tsx
import { useTrack } from '@revturbine/sdk';

function AdvancedFilters() {
  const track = useTrack();
  return (
    <button onClick={() => track('feature_used', { feature: 'advanced_filters' })}>
      Filter
    </button>
  );
}
```

Headless / server code uses `sdk.track`:

```ts
await sdk.track('checkout_completed', { plan: 'professional', revenue: 99 });
```

### Track options

| Option | Meaning |
|---|---|
| `area` / `action` | Scope labels; merge outer → inner → invocation |
| `purpose` | **Advisory** intent (e.g. `'engagement'`). A server-side allowlist — not this value — decides whether an event feeds scoring |
| `once` | Emit at most once for the hook's lifetime |
| `dedupeKey` | Emit at most once per key |
| `immediate` | Send now instead of batching |

## Scoping with TelemetryScope

`TelemetryScope` sets ambient `area` / `action` / `purpose` for its descendants. It renders its children unchanged — no wrapper element, no added `role` — and nested scopes merge inner-over-outer, with per-event options winning.

```tsx
import { TelemetryScope, useTrack } from '@revturbine/sdk';

<TelemetryScope area="billing" purpose="engagement">
  <UpgradePanel /> {/* every useTrack() here inherits area="billing" */}
</TelemetryScope>
```

## Declarative tracking

| Component / hook | Fires |
|---|---|
| `TrackOnView` | Its event **once** when the element scrolls into view (falls back to render when `IntersectionObserver` is unavailable). Strict-Mode safe |
| `EngagementArea` | A one-shot `engagement_view`, accrues `engagement_dwell` (`dwell_ms`) only while onscreen **and** the tab is visible, and bubbles descendant clicks as `engagement_interaction` |
| `Track` (`asChild`) | Composes onto a child's `onClick` (no wrapper) — telemetry fires only if the child didn't `preventDefault`; leaves the child's accessible name and disabled state unchanged |
| `useTelemetryProps` | Telemetry props to spread onto a primitive that can't take a wrapper |

```tsx
import { TrackOnView, Track } from '@revturbine/sdk';

<TrackOnView event="hero_seen" data={{ variant: 'a' }}>
  <Hero />
</TrackOnView>

<Track event="cta_clicked" data={{ plan: 'pro' }} asChild>
  <button onClick={handleUpgrade}>Upgrade</button>
</Track>
```

## Tracked & gated actions

`useTrackedAction` wraps an async action, emitting `${name}_started` then `${name}_completed` or `${name}_failed` (with a non-sensitive `error_category` — never the raw message). It preserves the return value and re-throws, so it's a drop-in wrapper.

```tsx
import { useTrackedAction } from '@revturbine/sdk';

const { run, isRunning } = useTrackedAction('export_pdf', () => exportPdf());
<button disabled={isRunning} onClick={() => run()}>Export</button>
```

`useGatedAction` is the React analog of `rt.gate(action, fn)`: it delegates to the SDK so it emits the same `gate_attempted` → `gate_allowed` / `gate_denied` sequence (not a fork), running the action wrapped in tracked-action telemetry only when allowed. A passively-rendered `<Gate>` instead emits `gate_evaluated`.

## Consent

`telemetry.consent` gates event **creation** ahead of every destination:

| Value | Effect |
|---|---|
| `granted` (default) | Emit normally |
| `denied` | No event is created — nothing reaches ingest, consumers, or integrations |
| `pending` | Dropped in MVP; never persisted |

Change it at runtime with no remount:

```ts
sdk.setTelemetryConsent('denied'); // stop; 'granted' resumes on the next event
```

The keyless anonymous SDK-init beacon (`anonymousTelemetry`) is controlled separately and is unaffected by consent.

## Annotated DOM capture

Opt into hand-authored capture with `domCapture` on the provider. One delegated listener per event reads **only** allowlisted `data-rt-*` attributes — never element text, input values, `href`s, or selectors — and always skips password / file / hidden / payment-autocomplete controls. A `data-rt-no-capture` ancestor opts an element and its subtree out. Collected values pass through the same PII redactor.

```tsx
<RevTurbineProvider options={options} domCapture>
  <button data-rt-event="cta_clicked" data-rt-prop-plan="pro">Upgrade</button>
</RevTurbineProvider>
```

## Viewport exposure

`placementExposure` controls when the presentation-writing `impression` fires:

| Mode | Impression fires |
|---|---|
| `legacy_resolution` (default) | At decision resolution — exactly as today |
| `render` | When the placement renders |
| `viewport` | When it scrolls into the viewport; falls back to resolution (`exposure_basis: 'render_fallback'`) when `IntersectionObserver` is unavailable |

Attach `exposureRef` (from `usePlacement`) or the additive `exposureRef` prop on `PlacementSlotProps` to the placement's true visual root.

:::caution[Metric-migration note]
Only `placementExposure: 'viewport'` **with `IntersectionObserver` present** moves the `placement_presentations` denominator to viewport-qualified presentations — a deliberate metric-definition change. CTR and conversion-rate for a placement switched to `viewport` reflect *seen* presentations from that point forward and no longer compare against pre-switch history. `legacy_resolution` (the default) leaves the denominator — and every existing dashboard — unchanged.
:::

## Third-party analytics

Forward the same semantic events to a third-party tool without adding a second transport. `createPostHogIntegration` adds an opt-in identity lifecycle (all sync flags default `false`, so it behaves like the capture-only provider until you turn one on); PostHog is injected, never bundled.

```ts
import posthog from 'posthog-js';
import { createPostHogIntegration } from '@revturbine/sdk';

initRevTurbine({
  domainProviders: [createPostHogIntegration({ posthog, syncIdentity: true })],
  // ...
});
```

A throwing integration never blocks RevTurbine ingest, and an ingest failure never blocks a configured mirror.

## Trigger events

Trigger events are semantic lifecycle signals the SDK uses to re-evaluate targeting. Emit one and all active placements re-evaluate:

```ts
await sdk.emitTrigger('trial_expiring', { days_remaining: 2 });
await sdk.emitTrigger('usage_limit_approaching', {
  entitlement_handle: 'api_calls', usage_percent: 95,
});
```

Built-in triggers: `trial_started` · `trial_expiring` · `trial_expired` · `usage_limit_approaching` · `usage_limit_exceeded` · `feature_gated` · `payment_retry_required` · `subscription_renewing`.

:::tip
Triggers are the primary way to activate message-type placements (toasts, banners, modals). Dashboard targeting rules reference them to decide when to show a placement.
:::

## Privacy & delivery

- **Redaction.** Email- and card-shaped values in properties and traits are scrubbed to `[REDACTED]` before any destination — one sanitized envelope, every mirror. Best-effort, not a guarantee: don't put PII in event data.
- **Advisory purpose, server-owned scoring.** A client-declared `purpose` never grants engagement eligibility; a static server-side allowlist decides which event names feed scoring, regardless of purpose.
- **Delivery.** Events batch and flush on size, interval, or page-unload. A transient failure is retried with the byte-identical row, so storage collapses it to one; a permanent failure is dropped silently. In `local_only` mode nothing is sent at all — the right mode for demos and examples.

## Next steps

- [Placements Guide](/guides/placements/) — placement lifecycle and interactions
- [Runtime Modes](/guides/runtime-modes/) — `local_only` vs server modes
- [Error Handling](/guides/error-handling/) — graceful event-delivery failures
