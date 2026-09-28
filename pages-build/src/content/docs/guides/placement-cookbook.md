---
title: Placement Cookbook
description: Copy-paste patterns for each core surface type and lifecycle callback.
sidebar:
  order: 3
---

This guide provides ready-to-use patterns for each surface type supported by the SDK.

## Surface Types at a Glance

| Surface Type | Component | Use Case |
|---|---|---|
| `banner` | `BannerSlot` | Full-width sticky banner (top/bottom) |
| `modal` | `ModalSlot` | Centered overlay dialog |
| `in_page` | `InlineEmbedSlot` | Inline card in page flow |
| `toast` | `ToastSlot` | Ephemeral auto-dismiss notification |
| `button` | `ButtonSlot` | Single CTA button |
| `full_page` | `FullPageSlot` | Dedicated full-page (plans/upgrade) |
| `cli` | `CliSlot` | CLI-style monospace message |
| `in_page` (quota) | `QuotaMeterSlot` | Usage meter (bar/gauge/numeric) |
| `in_page` (credits) | `CreditBalanceSlot` | Depleting credit balance display |

## Banner

```tsx
<Slot
  id="upgrade_banner"
/>
```

> [Try it live → Usage Warning Banner](/playground/#msg-banner)

## Modal

```tsx
<Slot
  id="mp4_download_gate"
/>
```

> [Try it live → Data Export Gate](/guides/entitlements/#gate-modal)

:::caution[Modal safety rule]
Only request a modal at **safe moments**: after a user action (clicked a button, hit a feature gate), completed a task, or reached a natural transition. Never on passive page render.
:::

## In-Page

```tsx
<Slot
  id="brand_kit_inline"
/>
```

## Toast

```tsx
<Slot
  id="trial_countdown_toast"
/>
```

## Button

```tsx
<Slot
  id="nav_upgrade_button"
/>
```

> [Try it live → Upgrade Button](/guides/placements/#fixed-button)

## Full-Page

```tsx
<Slot
  id="plans_page_surface"
/>
```

## CLI

```tsx
<Slot
  id="cli_usage_warning"
/>
```

## Quota Meter (In-Page)

```tsx
<Slot
  id="core_credits_quota_meter"
/>
```

> [Try it live → Quota Meter](/playground/#fixed-usage-counter)

## Credit Balance (In-Page)

```tsx
<Slot
  id="credit_balance_panel"
/>
```

## Lifecycle Callbacks

```tsx
import type { PlacementUiPath } from '@revturbine/sdk';

const createPlacementCallbacks = (
  sdk: import('@revturbine/sdk').RevTurbineCustomerSdk,
  placementId: string,
) => ({
  onImpression: () => {
    void sdk.trackTreatmentInteraction({
      userId: 'user_123',
      placementId,
      interactionType: 'impression',
    });
  },
  onDismiss: () => {
    void sdk.trackTreatmentInteraction({
      userId: 'user_123',
      placementId,
      interactionType: 'dismiss',
    });
  },
  onCtaClick: () => {
    void sdk.trackTreatmentInteraction({
      userId: 'user_123',
      placementId,
      interactionType: 'cta_clicked',
    });
  },
});
```

## Object Signature Placement Requests

Use typed helper creators for placement requests:

```ts
import {
  createSlotPlacementRequest,
  createEntitlementPlacementRequest,
  createChainedPlacementRequest,
} from '@revturbine/sdk';

const slotRequest = createSlotPlacementRequest('dashboard_banner', 'banner');
const entitlementRequest = createEntitlementPlacementRequest('mp4_download', {
  componentType: 'modal',
});
const chainedRequest = createChainedPlacementRequest('upgrade_follow_up', {
  slotId: 'settings_footer',
  componentType: 'in_page',
});
```

## Route surface

Every slot lifecycle event (`slot_evaluated`, `slot_filled`, `slot_suppressed`,
`slot_empty`) is stamped with the app **route** it was evaluated on
(`slotContextBase.route`, BL-0207 / ruling D-30). Ingestion-driven surface-slot
discovery persists that route on the discovered slot, so the same slot
rendered at `/projects/42` and `/projects/43` is recognized as one recurring
surface instead of two — that's what lets discovery, the placement dashboard,
and needs-attention surfacing group slots by *where* they live in your app
rather than by every distinct URL a user happened to visit.

A route is always a **path**, never a URL — no origin, no query string, no
fragment. Query strings are where tokens, emails and search terms live, so
they never reach the wire.

### `<RevTurbineRoute>` boundary

`<RevTurbineRoute route="...">` declares the route pattern for every slot
rendered beneath it. It's renderless (no DOM node), and the innermost boundary
wins if you nest them:

```tsx
import { RevTurbineRoute } from '@revturbine/sdk';

function ProjectLayout({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  return (
    <RevTurbineRoute route={`/projects/[projectId]`}>
      {children}
    </RevTurbineRoute>
  );
}
```

Mounting it is **optional**. Without it, slots fall back to
`window.location.pathname` (see below). Mount it once your router knows the
route *pattern*, so `/projects/42` and `/projects/43` collapse to one route
instead of being reported as two.

### Next.js recipe

Pair it with `routePatternFromParams(pathname, params)`, which rebuilds the
framework route pattern from `usePathname()` + `useParams()` without the SDK
importing `next/navigation`:

```tsx
'use client';

import { usePathname, useParams } from 'next/navigation';
import { RevTurbineRoute, routePatternFromParams } from '@revturbine/sdk';

export function RouteBoundary({ children }: { children: React.ReactNode }) {
  const route = routePatternFromParams(usePathname(), useParams());
  return <RevTurbineRoute route={route}>{children}</RevTurbineRoute>;
}
```

`/projects/p_42/settings` with `useParams()` returning `{ projectId: 'p_42' }`
becomes `/projects/[projectId]/settings`; a catch-all param
(`{ slug: ['a', 'b'] }`) becomes `[...slug]`. Mount `<RouteBoundary>` once,
near the root layout — every slot beneath it inherits the pattern.

### The pathname fallback and `:id` normalization

When no `<RevTurbineRoute>` is mounted (or none of its ancestors declared a
route), a slot reports the browser's `window.location.pathname`, with
identifier-like segments templated to `:id` so neither PII nor per-entity
cardinality reaches discovery. A segment is templated when it looks like a
number, a UUID, a long hex string, a prefixed id (`cus_Q1w2E3r4`,
`tn_4bcd07d7-…`), an opaque token, or contains an `@` (email-shaped):

```ts
import { normalizeSlotRoute } from '@revturbine/sdk';

normalizeSlotRoute('/accounts/4821/billing?tab=x');
// → '/accounts/:id/billing'   (numeric id templated, query string dropped)

normalizeSlotRoute('/projects/9b1f2e3a-4c5d-4e6f-8a9b-0c1d2e3f4a5b');
// → '/projects/:id'           (UUID templated)
```

A route pattern segment the host already templated (`[id]`, `[...slug]`,
`:id`, `*`) is left verbatim rather than re-templated.

### The 512-character cap

A normalized route is truncated to **512 characters** if it exceeds that
length (`SLOT_ROUTE_MAX_LENGTH`, matching scaffold's
`SURFACE_SLOT_ROUTE_MAX_LENGTH`) before it's stamped on an event — an
unbounded pathname (deep-linked search state, long catch-all segments) never
grows the event payload without limit.

### The headless route option

Outside React, pass `route` directly to a headless `PlacementController` — a
string, or a getter read at emission time so a long-lived controller reports
the route it was evaluated on after a client-side navigation:

```ts
import { initRevTurbine } from '@revturbine/sdk/headless';

const session = await initRevTurbine({
  tenantId: 'tenant_abc',
  publicKey: 'rtk_…',
  endpoint: 'https://edge.example.com',
  mode: 'snippet',
});
const ctrl = session.placement({
  surfaceSlot: { id: 'pricing_banner' },
  route: () => window.location.pathname,
});
```

Both forms are normalized the same way as the React path. If `route` is
omitted, a headless controller emits `route: null` — there's no browser
`window.location` fallback outside React, so headless callers that want route
attribution supply it explicitly.
