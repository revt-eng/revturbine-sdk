---
title: Events & Analytics
description: Track user interactions, engagement, and placement lifecycle — automatically, declaratively, or by hand — with consent, redaction, and a typed event pipeline.
sidebar:
  order: 10
---

RevTurbine reports what it did — a placement was shown, a CTA was clicked — and **RevTurbine reporting is on by default**. It is treated as functional: it is how a placement is attributed to the conversion it led to, and it is planned to carry caps and cooldowns. You turn it off explicitly, with `analytics: false` or `telemetry.consent` (see [Consent](#consent)). The one reporting feature that is opt-in is DOM capture: the SDK reports what the user was doing *around* a placement (annotated clicks) only when you opt in with `domCapture`. Placement lifecycle is tracked automatically, and everything is privacy-safe by default.

Every event carries a sortable, unique `event_id`, is PII-redacted before it leaves the browser, and is batched and delivered best-effort (a failed send never throws into your app, and a retry resends the identical row so it can't duplicate).

## Automatic tracking

Placement components and headless controllers instrument the placement lifecycle for you — you don't wire these up:

| Event | When |
|---|---|
| `impression` | A placement is presented (see [viewport exposure](#viewport-exposure)) |
| `placement_interaction` | The canonical interaction event, discriminated by `interaction_type`: `dismiss` · `remind_me_later` · `cta_clicked` · `cta_completed` · `suppress` |
| `placement_rendered` / `placement_exposed` | The visual root rendered / entered the viewport (when you attach `exposureRef`) |

`placement_interaction` is the one placement interaction event; there are no separate dismiss/snooze/convert events. Since `0.15.0` it is also the **only** way an interaction (impression included) is reported: it carries the full record — user and account, placement, treatment, `interaction_type` and `interaction_at`, surface slot and template, payload, message block, experiment and variant, rule, the exposure stamp (`trigger_source`, `entitlement_handle`, `playbook_version`), decision and segments — and RevTurbine derives the presentation row from it. There is no separate interactions request.

## Billing facts and application events

With Stripe connected and identity mapping configured, RevTurbine records
subscription, trial, renewal, and payment facts from Stripe webhooks. Your app
does not need to emit a second billing fact merely because a checkout page
returned successfully. A browser return URL is not authoritative payment proof.

The billing event names are `subscription_started`, `subscription_renewed`,
`subscription_expanded`, `subscription_canceled`, `trial_started`,
`trial_converted`, `trial_expired`, `payment_succeeded`, and `payment_failed`.
For example, record your app's checkout-button interaction as an application
event; let the webhook integration report the resulting `payment_succeeded`
and subscription fact. Do not send a duplicate `subscription_started` from
the browser's checkout-success page.

Use application events for what your app knows: feature use, an onboarding step,
or an interaction that is not a Stripe billing occurrence. `track()` is the
generic lane and namespaces collisions with platform event names. The typed
`emitPlatformEvent` API is the platform-event lane and requires that event's
payload contract; renaming an arbitrary `track()` event does not make it a
canonical billing fact.

`billing_ref` is a producer-owned stable billing-fact identity, not the SDK
transport `event_id`. Preserve it when retrying the same fact. Do not reuse it
for unrelated occurrences or invent a new one on each retry. Newer managed
billing profiles distinguish occurrence identity, source revision, delivery ID,
and the legacy billing reference; a legacy reference alone does not identify
every repeated subscription transition. Prefer the Stripe integration for
Stripe-owned facts rather than reproducing its accounting logic in the browser.

The SDK does not emit the removed `growth_signal_observed` event. Use the current
documented event/trigger contracts and keep custom names in the application lane.
For identity mapping and webhook setup, see [Billing & Stripe](/guides/billing/).

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

export const Examples = () => (
  <>
    <TrackOnView event="hero_seen" data={{ variant: 'a' }}>
      <Hero />
    </TrackOnView>

    <Track event="cta_clicked" data={{ plan: 'pro' }} asChild>
      <button onClick={handleUpgrade}>Upgrade</button>
    </Track>
  </>
);
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

RevTurbine's own reporting (clickstream and placement-interaction events) is **opt-out**: with neither `analytics` nor `telemetry.consent` set, it is on. It is functional: it is used to attribute placements to conversions and is planned to carry caps and cooldowns. You turn it off explicitly, with `analytics: false`, with `telemetry.consent: 'denied'` or `'pending'`, or at runtime with `setTelemetryConsent()`. Turning it off never changes Playbook delivery or any decision. (This page describes behaviour, not legal requirements: decide for your own product what you need to tell and ask your users.)

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

The anonymous SDK init and error events (`anonymousTelemetry`, see [SDK init and error events](#sdk-init-and-error-events)) are controlled separately and are unaffected by consent and by `analytics`.

Consent covers **placement interaction reporting** too. Impressions, dismissals, CTA clicks, conversions, snoozes and suppressions travel only as `placement_interaction` events, so with `denied` or `pending` the SDK sends no interaction data at all, exactly as it sends no other behavior.

Consent never affects how the SDK **behaves**. Playbook delivery, entitlement and placement decisions, dismissal cooldowns, suppression and presentation caps keep working from local state, so a visitor who declines analytics still gets a correct, capped experience. To keep reporting off for everyone, set `analytics: false` (below); it has the same scope.

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

`usePlacement` returns `exposureRef`; slot components receive the same ref through the additive `exposureRef` prop on `PlacementSlotProps`. The renderer threads it to every slot automatically, and a **custom component** must attach it to its true visual root. The built-in slots do not consume the ref, so their viewport mode uses the render fallback.

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

Built-in triggers: `trial_midpoint` · `trial_expiring` · `trial_expired` · `usage_limit_approaching` · `usage_limit_reached` · `credit_balance_low` · `seat_limit_reached` · `feature_gated` · `cancel_intent` · `payment_failed` · `auto_renewal_reminder` · `onboarding_complete` · `invite_teammate_prompt` · `referral_offer` · `plan_upgrade_nudge`. The compiler rejects any other name.

:::tip
Triggers are the primary way to activate message-type placements (toasts, banners, modals). Dashboard targeting rules reference them to decide when to show a placement.
:::

## Marking test traffic

Set `test: true` at init when an SDK instance generates **test traffic** — a staging deploy, an integration test, a QA walkthrough:

```ts
import { initRevTurbine } from '@revturbine/sdk';

const rt = await initRevTurbine({
  publicKey: process.env.NEXT_PUBLIC_REVTURBINE_PUBLIC_KEY!, // public key — safe in the browser
  test: true, // this instance's events are test traffic
  user: { id: 'qa_user_1' }, // required in every mode
});
```

Every emitted event (every clickstream row, `placement_interaction` included) is then stamped `test: true`, and RevTurbine analytics **exclude those events by default** from every metric, rollup, and denominator. An `include_test=1` toggle on the analytics pipes reveals them when you want to inspect test traffic.

This is a deliberate, code-passed decision: pass it explicitly from your own configuration. The SDK never infers it from the environment — no `NODE_ENV` sniffing. Whether traffic is test traffic is your call, not a deployment artifact. Omitted or `false`, events are emitted unchanged (byte-identical to earlier SDK versions).

:::note[Not the same as placement "Test Mode"]
Placement **Test Mode** (`off / test_users / all_traffic` on a placement's settings) controls **who is eligible to see** a placement during SDK evaluation and carries its own decision marker. The `test` init option is a *caller-declared* marker on **emitted events**. A production user in a placement's test audience is not test traffic; a staging deploy emitting real-looking events is. The two are independent.
:::

## Silent-failure diagnostics

When a placement or entitlement can't resolve for **infrastructure** reasons, the SDK reports it instead of failing silently — a `resolution_failure` diagnostic on the anonymous meta channel:

| Reason | Emitted when |
|---|---|
| `placement_not_registered` | A decision is requested for a placement the app never registered — the classic "my payload renders nothing, silently" |
| `config_unavailable` | The Playbook never arrived, so a placement fell back or an entitlement check denied without a rule saying no |
| `sdk_disabled_provider_failure` | The provider chain failed: entitlement checks deny with this reason and slots follow `providerFailureSlotBehavior` |

Diagnostics carry **only** author-defined handles (placement, slot, plan, entitlement) and closed reason codes — never user context, free text, or your tenant identifier (deployments are counted through a one-way hash). They're deduplicated per session and capped, and fire from keyed production installs as well as keyless ones.

Rule-based denials and local mode's default behavior are not failures and never emit.

## SDK init and error events

Since 0.16.0 the SDK sends three kinds of anonymous event to RevTurbine's `/api/sdk/meta`: one `sdk_init` per session (counts of plans, entitlements, placements and so on), `sdk_error` (the SDK itself failed) and the `resolution_failure` diagnostics above. They contain the SDK version, runtime mode, bundle version, a one-way hash of the deployment, closed reason codes, author-defined handles and a fixed-vocabulary message. They never contain a user, account, URL, token or anything you typed, and a caught exception's text is never copied into them. The requests carry no cookies (`credentials: 'omit'`), even to a same-origin endpoint.

- **They are sent without regard to `analytics` and `telemetry.consent`.** They are not behavior events.
- **With a public key configured** the request carries it as `Authorization: Bearer <public key>`, only so the events are attributed to your tenant and appear in its SDK health view. A server key is never sent. With no public key the request has no header and is attributed by the hash alone.
- **A missing user is reported.** The SDK that has no user is the one that cannot tell you, so a connected SDK (not `local_only`) sends one `sdk_error` with the message `user_id_required at <init|identify|setUserContext|user_promise_rejected|user_promise_resolved_blank>`. It is the only request an SDK without a user makes; `sdk_init` waits for a user.
- **Turn it off** with `anonymousTelemetry: false`. A render that is not an install (docs, a playground) uses `previewMode: true`.
- **Send it to your own endpoint, instead of or as well as RevTurbine** with `sdkTelemetryProviders`:

```ts
import { createHttpSdkTelemetryProvider } from '@revturbine/sdk';

initRevTurbine({
  // ...
  sdkTelemetryProviders: [createHttpSdkTelemetryProvider({ url: '/internal/sdk-meta', headers: { 'x-app': 'web' } })],
  anonymousTelemetry: false, // omit to send to both
});
```

The public `sdk.reportSdkError(reason, message)` forwards what you pass (up to 500 characters) to the same destinations, also without regard to consent: the message must be a fixed string and never contain user data, an exception's text, an id, an email or a URL.

A provider is `{ name, send(events) }` and receives the same events, after the same de-duplication, cap and `previewMode` / browser gates, in `local_only` mode too. A provider that throws or rejects is ignored (one console warning per provider per session) and never affects the SDK or another destination. A provider never receives your public key; the helper sends only the headers you give it. This is separate from the clickstream event consumers.

## Your taxonomy in analytics

Events that carry the `area` / `action` / `purpose` taxonomy (from `TelemetryScope`, `useTrack` options, `EngagementArea`, and tracked actions) are additionally stored with the taxonomy as first-class analytics columns — so engagement queries group by area and action directly, with no JSON unpacking and no configuration on your side. Untagged events are unaffected.

## Privacy & delivery

- **Redaction.** Email- and card-shaped values in properties and traits are scrubbed to `[REDACTED]` before any destination — one sanitized envelope, every mirror. Best-effort, not a guarantee: don't put PII in event data.
- **Advisory purpose, server-owned scoring.** A client-declared `purpose` never grants engagement eligibility; a static server-side allowlist decides which event names feed scoring, regardless of purpose.
- **One lane, two switches.** Interaction reporting rides the clickstream, so both switches cover it: `telemetry.consent` other than `granted` stops event creation, and `analytics: false` skips the ingest call. Neither affects Playbook delivery (a read), decisions, cooldowns, suppression or caps. There is no separate consent or opt-out for interactions and no second request to opt out of.
- **Delivery.** Events batch and flush on size, interval, or page-unload. A transient failure is retried with the byte-identical row, so storage collapses it to one; a permanent failure is dropped silently. In `local_only` mode nothing is sent at all — the right mode for demos and examples.

## Next steps

- [Placements Guide](/guides/placements/) — placement lifecycle and interactions
- [Runtime Modes](/guides/runtime-modes/) — local vs hosted mode
- [Error Handling](/guides/error-handling/) — graceful event-delivery failures
