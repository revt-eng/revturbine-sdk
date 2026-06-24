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
<SurfaceSlotComponent
  id="upgrade_banner"
  surfaceType="banner"
/>
```

> [Try it live → Usage Warning Banner](/playground/global-slots/msg-banner/)

## Modal

```tsx
<SurfaceSlotComponent
  id="mp4_download_gate"
  surfaceType="modal"
/>
```

> [Try it live → Data Export Gate](/playground/access-gates/gate-modal/)

:::caution[Modal safety rule]
Only request a modal at **safe moments**: after a user action (clicked a button, hit a feature gate), completed a task, or reached a natural transition. Never on passive page render.
:::

## In-Page

```tsx
<SurfaceSlotComponent
  id="brand_kit_inline"
  surfaceType="in_page"
/>
```

## Toast

```tsx
<SurfaceSlotComponent
  id="trial_countdown_toast"
  surfaceType="toast"
/>
```

## Button

```tsx
<SurfaceSlotComponent
  id="nav_upgrade_button"
  surfaceType="button"
/>
```

> [Try it live → Upgrade Button](/playground/fixed-slots/fixed-button/)

## Full-Page

```tsx
<SurfaceSlotComponent
  id="plans_page_surface"
  surfaceType="full_page"
/>
```

## CLI

```tsx
<SurfaceSlotComponent
  id="cli_usage_warning"
  surfaceType="cli"
/>
```

## Quota Meter (In-Page)

```tsx
<SurfaceSlotComponent
  id="core_credits_quota_meter"
  surfaceType="in_page"
/>
```

> [Try it live → Quota Meter](/playground/fixed-slots/fixed-usage-counter/)

## Credit Balance (In-Page)

```tsx
<SurfaceSlotComponent
  id="credit_balance_panel"
  surfaceType="in_page"
/>
```

## Lifecycle Callbacks

```tsx
import type { PlacementUiPath } from '@revt-eng/sdk';

const createPlacementCallbacks = (
  sdk: import('@revt-eng/sdk').RevTurbineCustomerSdk,
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
} from '@revt-eng/sdk';

const slotRequest = createSlotPlacementRequest('dashboard_banner', 'banner');
const entitlementRequest = createEntitlementPlacementRequest('mp4_download', {
  surfaceType: 'modal',
});
const chainedRequest = createChainedPlacementRequest('upgrade_follow_up', {
  slotId: 'settings_footer',
  surfaceType: 'in_page',
});
```
