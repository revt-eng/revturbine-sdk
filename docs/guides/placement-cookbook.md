# Placement Cookbook

This guide provides copy-paste patterns for each core surface type and lifecycle callbacks.

## Shared Lifecycle Callback Pattern

```tsx
import type { PlacementUiPath } from '@revt-eng/sdk';

type PlacementCallbacks = {
  onImpression: (outputId: string) => void;
  onDismiss: (outputId: string) => void;
  onCtaClick: (path: PlacementUiPath) => void;
  onSecondaryCtaClick?: (path: PlacementUiPath) => void;
};

export const createPlacementCallbacks = (
  sdk: import('@revt-eng/sdk').RevTurbineCustomerSdk,
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

## Custom CTA Actions & Resolvers

Built-in CTA actions (`open_checkout`, `view_plans`, …) are handled by your
`onCtaClick` switch. For a **tenant-defined** action, author it with the `custom`
path and put whatever your handler needs in `config` — the keys are free-form and
pass through to the decision verbatim:

```jsonc
// in the placement payload's surface (playbook.json)
"ctas": [{
  "label": "Connect CRM",
  "path": "custom",
  "config": { "url": "/integrations/crm", "org": "acme", "flow": "oauth" }
}]
```

The engine emits `cta_path: { type: "custom", url: "/integrations/crm", org: "acme", flow: "oauth" }`.
The SDK parses that into a `PlacementUiPath`, lifting known keys (`url`, …) onto
typed fields and collecting the rest into `params`:

```ts
// what your resolver receives
{ type: "custom", url: "/integrations/crm", params: { org: "acme", flow: "oauth" } }
```

Register a resolver **once at app init**, keyed on the action name. It targets the
default global registry, so `<PlacementRenderer>` (and the surface slots) dispatch
to it automatically:

```ts
import { registerCtaResolver } from '@revt-eng/sdk';

registerCtaResolver('custom', (uiPath, ctx) => {
  openCrmConnectModal({
    returnUrl:   uiPath.url,                  // '/integrations/crm'
    org:         String(uiPath.params?.org),  // 'acme'
    flow:        String(uiPath.params?.flow), // 'oauth'
    placementId: ctx.placement.output_id,     // for attribution; ctx.kind = 'primary' | 'secondary'
  });
});
```

Use a distinct action name per logical action (`'connect_crm'`, `'start_tour'`, …)
and register one resolver each — the registry key is the action `type`. A
registered resolver fully handles the click; unregistered types fall back to your
`onCtaClick(uiPath)` prop.

**Scoped (no global mutation)** — build a local registry and pass it in, e.g. for
tests or per-tenant isolation:

```tsx
import { CtaResolverRegistry, PlacementRenderer } from '@revt-eng/sdk';

const ctaResolvers = new CtaResolverRegistry();
ctaResolvers.register('custom', (uiPath) => openCrmConnectModal({ returnUrl: uiPath.url }));

<PlacementRenderer placement={decision} ctaResolvers={ctaResolvers} onCtaClick={fallback} />
```

## Banner Surface

```tsx
<SurfaceSlotComponent
  id="upgrade_banner"
  surfaceType="banner"
  userId="user_123"
/>
```

## Modal Surface

```tsx
<SurfaceSlotComponent
  id="mp4_download_gate"
  surfaceType="modal"
  userId="user_123"
/>
```

## In-Page Surface

```tsx
<SurfaceSlotComponent
  id="brand_kit_inline"
  surfaceType="in_page"
  userId="user_123"
/>
```

## Toast Surface

```tsx
<SurfaceSlotComponent
  id="trial_countdown_toast"
  surfaceType="toast"
  userId="user_123"
/>
```

## Button Surface

```tsx
<SurfaceSlotComponent
  id="nav_upgrade_button"
  surfaceType="button"
  userId="user_123"
/>
```

## Full-Page Surface

```tsx
<SurfaceSlotComponent
  id="plans_page_surface"
  surfaceType="full_page"
  userId="user_123"
/>
```

## CLI Surface

```tsx
<SurfaceSlotComponent
  id="cli_usage_warning"
  surfaceType="cli"
  userId="user_123"
/>
```

## Quota Meter Surface (In-Page Template)

```tsx
<SurfaceSlotComponent
  id="core_credits_quota_meter"
  surfaceType="in_page"
  userId="user_123"
/>
```

## Credit Balance Surface (In-Page Template)

```tsx
<SurfaceSlotComponent
  id="credit_balance_panel"
  surfaceType="in_page"
  userId="user_123"
/>
```

## Object Signature Placement Requests

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
