# Placement Cookbook

This guide provides copy-paste patterns for each core surface type and lifecycle callbacks.

## Shared Lifecycle Callback Pattern

```tsx
import type { PlacementUiPath } from '@revturbine/sdk';

type PlacementCallbacks = {
  onImpression: (outputId: string) => void;
  onDismiss: (outputId: string) => void;
  onCtaClick: (path: PlacementUiPath) => void;
  onSecondaryCtaClick?: (path: PlacementUiPath) => void;
};

export const createPlacementCallbacks = (
  sdk: import('@revturbine/sdk').RevTurbineCustomerSdk,
  placementId: string,
): PlacementCallbacks => ({
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
  onSecondaryCtaClick: () => {
    void sdk.trackTreatmentInteraction({
      userId: 'user_123',
      placementId,
      interactionType: 'cta_clicked',
      metadata: { secondary: true },
    });
  },
});
```

## Banner Surface

```tsx
<SurfaceSlotComponent
  id="upgrade_banner"
  acceptedComponentTypes={['banner']}
/>
```

## Modal Surface

```tsx
<SurfaceSlotComponent
  id="mp4_download_gate"
  acceptedComponentTypes={['modal']}
/>
```

## In-Page Surface

```tsx
<SurfaceSlotComponent
  id="brand_kit_inline"
  acceptedComponentTypes={['in_page']}
/>
```

## Toast Surface

```tsx
<SurfaceSlotComponent
  id="trial_countdown_toast"
  acceptedComponentTypes={['toast']}
/>
```

## Button Surface

```tsx
<SurfaceSlotComponent
  id="nav_upgrade_button"
  acceptedComponentTypes={['button']}
/>
```

## Full-Page Surface

```tsx
<SurfaceSlotComponent
  id="plans_page_surface"
  acceptedComponentTypes={['full_page']}
/>
```

## CLI Surface

```tsx
<SurfaceSlotComponent
  id="cli_usage_warning"
  acceptedComponentTypes={['cli']}
/>
```

## Quota Meter Surface (In-Page Template)

```tsx
<SurfaceSlotComponent
  id="core_credits_quota_meter"
  acceptedComponentTypes={['in_page']}
/>
```

## Credit Balance Surface (In-Page Template)

```tsx
<SurfaceSlotComponent
  id="credit_balance_panel"
  acceptedComponentTypes={['in_page']}
/>
```

## Object Signature Placement Requests

```ts
import {
  createSlotPlacementRequest,
  createEntitlementPlacementRequest,
  createChainedPlacementRequest,
} from '@revturbine/sdk';

const slotRequest = createSlotPlacementRequest('dashboard_banner', 'banner');
const entitlementRequest = createEntitlementPlacementRequest('mp4_download', {
  surfaceType: 'modal',
});
const chainedRequest = createChainedPlacementRequest('upgrade_follow_up', {
  slotId: 'settings_footer',
  surfaceType: 'in_page',
});
```
