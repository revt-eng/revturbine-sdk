# RevTurbine SDK

Customer-facing JavaScript/TypeScript SDK for integrating RevTurbine placement decisioning, entitlement checks, and usage tracking into web applications.

## Architecture

```
sdk/
├── index.ts                  # Barrel export (entry point for @revt-eng/sdk)
├── customer-side.ts          # Core SDK class — identity, placements, entitlements, events
├── generated.ts              # Re-exports types from @revt-eng/schema (DO NOT EDIT)
├── react/                    # React integration layer
│   ├── RevTurbineProvider    # Context provider — wraps app for SDK access
│   ├── usePlacement          # Hook — load decision + manage interactions
│   └── Placement             # Render-prop alternative to usePlacement
├── placements/               # Placement rendering system
│   ├── types.ts              # Slot type interfaces (PlacementSlotProps, PlacementSlotType, etc.)
│   ├── registry.ts           # PlacementTypeRegistry — resolves outputs → slot components
│   ├── builtin.ts            # Registers all 9 built-in slot types
│   ├── PlacementRenderer     # Core renderer — resolves slot type, expands tokens, renders
│   ├── PlacementPreview      # Admin preview with device frame & interaction log
│   ├── SurfaceSlotComponent  # Drop-in component (decision + render in one step)
│   ├── useSurfaceSlot        # Hook variant of SurfaceSlotComponent
│   ├── useRegisterPlacementType # Runtime custom type registration
│   ├── PlacementCodeUpload   # Custom code/CSS upload UI
│   ├── SandboxedPlacement    # Iframe sandbox for custom uploaded code
│   └── slots/                # Built-in slot components
│       ├── BannerSlot            # Full-width sticky banner (top/bottom)
│       ├── ModalSlot             # Centered overlay dialog (optional/blocking)
│       ├── InlineEmbedSlot       # Inline card in page flow
│       ├── ToastSlot             # Ephemeral auto-dismiss notification
│       ├── ButtonSlot            # Single CTA button
│       ├── FullPageSlot          # Dedicated full-page (plans/upgrade)
│       ├── QuotaMeterSlot        # Usage meter (bar/gauge/numeric)
│       ├── CliSlot               # CLI-style monospace message
│       └── CreditBalanceSlot     # Depleting credit balance display
└── README.md                 # This file
```

## Quick Start

## Developer Tasks (Start Here)

Use this table to jump directly to the guide for your current job-to-be-done.

| I need to... | Start here |
|---|---|
| Use the SDK without React (headless / imperative) | `guides/headless-api-guide.md` |
| Choose the right runtime mode | `guides/runtime-mode-guide.md` |
| Diagnose integration issues quickly | `guides/troubleshooting.md` |
| Implement placement surfaces with lifecycle callbacks | `guides/placement-cookbook.md` |
| Implement or review placement changes with an agent workflow | `guides/placement-agent-workflow.md` |
| Wire scenario demos with local runtime in Sandpack | `guides/sandpack-scenarios-local-runtime.md` |
| Launch a local SDK test harness for Playwright and manual verification | `#sdk-local-harness` |
| Generate API docs and Storybook docs | `Documentation` section below |

## Runtime Mode Decision Tree

1. Need zero-network/offline behavior? Use `local_only`.
2. Need customer-owned API/proxy routing? Use `custom_endpoints`.
3. Otherwise use `revturbine_server`.

For setup details, see `guides/runtime-mode-guide.md`.

## Runtime Modes

The SDK now supports three runtime modes:

1. `revturbine_server` (default)
- Standard RevTurbine-hosted integration.
- SDK calls RevTurbine-managed decisioning, entitlement, and ingestion paths.

2. `custom_endpoints`
- Customer provides endpoint overrides for SDK API calls.
- Useful when the customer proxies or replaces RevTurbine service surfaces.

3. `local_only`
- No server dependency.
- Required context/content/config are provided at initialization.
- Runtime state is persisted in localStorage.

## Provider Pattern and Fallbacks

The SDK supports an optional provider strategy for `getPlacement`, `checkEntitlement`, and `identify`.

- `provider`: primary provider object or factory.
- `providerFallbacks`: ordered list of fallback providers.
- `providerFailureSlotBehavior`: slot behavior after provider-chain failure.
  - `invisible` (default): placements become hidden.
  - `placeholder`: placements render safe placeholder content.

When the primary provider fails, the SDK logs a warning and tries each configured fallback in order.
If every configured provider for that method fails, the SDK disables itself in fail-closed mode.

Fail-closed behavior:

1. SDK logs a warning in the console.
2. Decision cache is cleared.
3. Placement decisions return either placeholder or hidden output based on `providerFailureSlotBehavior`.

This protects customer experiences from partially initialized or unstable provider chains.

### Recommended Setup

Use fallbacks in production for `revturbine_server` and `custom_endpoints` deployments.

1. Keep provider chain order deterministic (most trusted first).
2. Prefer at least one operational fallback provider.
3. Choose `providerFailureSlotBehavior: 'placeholder'` for upgrade-critical surfaces.
4. Choose `providerFailureSlotBehavior: 'invisible'` for non-critical surfaces.

### Production Checklist (RT-First)

For production deployments that prefer RevTurbine as the primary runtime:

1. Set `runtimeMode: 'revturbine_server'` as the default path.
2. Configure a primary RT provider first in the chain.
3. Add at least one fallback provider (for example, a customer proxy provider) in `providerFallbacks`.
4. Keep fallback providers ordered by trust and operational readiness.
5. Choose `providerFailureSlotBehavior` intentionally per surface criticality.
6. Monitor console warnings for provider-chain failures and treat them as actionable operational alerts.
7. Assume fail-closed behavior: if all providers fail for a method, RT SDK disables itself and slots render placeholder or invisible output.

### Provider + Fallback Example

```ts
import { initRevTurbine } from '@revt-eng/sdk';

const primaryProvider = {
  async getPlacement(config) {
    return fetchPlacementFromPrimary(config);
  },
  async checkEntitlement(handle, context) {
    return fetchEntitlementFromPrimary(handle, context);
  },
  identify(userId, context) {
    primaryIdentify(userId, context);
  },
};

const fallbackProvider = {
  async getPlacement(config) {
    return fetchPlacementFromFallback(config);
  },
  async checkEntitlement(handle, context) {
    return fetchEntitlementFromFallback(handle, context);
  },
  identify(userId, context) {
    fallbackIdentify(userId, context);
  },
};

const sdk = initRevTurbine({
  tenantId: 'tenant_abc',
  apiKey: 'rt_live_xxx',
  endpoint: 'https://api.revturbine.io',
  mode: 'react',
  runtimeMode: 'revturbine_server',
  provider: primaryProvider,
  providerFallbacks: [fallbackProvider],
  providerFailureSlotBehavior: 'placeholder',
});
```

If you do not supply a provider, the SDK uses its built-in runtime mode behavior directly.

### Custom Endpoint Mode

```ts
const sdk = initRevTurbine({
  tenantId: 'tenant_abc',
  apiKey: 'unused_or_customer_key',
  endpoint: 'https://customer-proxy.example.com',
  mode: 'react',
  runtimeMode: 'custom_endpoints',
  endpointOverrides: {
    decideContext: '/decisioning/decide-context',
    bootstrapContext: '/decisioning/bootstrap',
    checkEntitlement: '/entitlements/check',
    ingestEvents: '/events/ingest',
    touchpointTransition: '/touchpoints/transition',
  },
});
```

### Local-Only Mode

```ts
const sdk = initRevTurbine({
  tenantId: 'tenant_local',
  apiKey: 'local',
  endpoint: 'http://localhost',
  mode: 'react',
  runtimeMode: 'local_only',
  localRuntime: {
    storageKey: 'my-app:revturbine-local-runtime',
    initialData: {
      trialStatus: { inTrial: true, dayNumber: 3, daysRemaining: 11 },
      entitlementByHandle: {
        ai_export: { status: 'limited', allowed: true, reason: 'near_limit' },
      },
    },
  },
});
```

### Runtime Config Builders (Recommended)

Use the runtime config helpers to avoid invalid option combinations:

```ts
import {
  initRevTurbine,
  createServerRuntimeConfig,
  createCustomEndpointRuntimeConfig,
  createLocalRuntimeConfig,
} from '@revt-eng/sdk';

const serverSdk = initRevTurbine(
  createServerRuntimeConfig({
    tenantId: 'tenant_abc',
    apiKey: 'rt_live_xxx',
    endpoint: 'https://api.revturbine.io',
    mode: 'react',
  }),
);

const customSdk = initRevTurbine(
  createCustomEndpointRuntimeConfig({
    tenantId: 'tenant_abc',
    apiKey: 'rt_live_xxx',
    endpoint: 'https://proxy.example.com',
    mode: 'react',
    endpointOverrides: {
      decideContext: '/decisioning/decide-context',
      ingestEvents: '/events/ingest',
    },
  }),
);

const localSdk = initRevTurbine(
  createLocalRuntimeConfig({
    tenantId: 'tenant_local',
    apiKey: 'local',
    endpoint: 'http://localhost',
    mode: 'react',
    localRuntime: {
      initialData: {
        trialStatus: { inTrial: true, dayNumber: 2 },
      },
    },
  }),
);
```

### Typed Helper Creators

Use helper creators for common placement and event payloads:

```ts
import {
  createSlotPlacementRequest,
  createEntitlementPlacementRequest,
  createChainedPlacementRequest,
  createTreatmentInteraction,
  createSemanticEvent,
} from '@revt-eng/sdk';

const slotRequest = createSlotPlacementRequest('dashboard_banner', 'banner', {
  planHandle: 'professional',
});

const gateRequest = createEntitlementPlacementRequest('mp4_download', {
  surfaceType: 'modal',
});

const chainedRequest = createChainedPlacementRequest('upgrade_follow_up', {
  slotId: 'settings_footer',
  surfaceType: 'in_page',
});

const interaction = createTreatmentInteraction(
  'user_123',
  'placement_abc',
  'cta_clicked',
  { metadata: { cta_target: 'upgrade' } },
);

const semantic = createSemanticEvent('checkout_started', {
  plan_handle: 'professional',
});
```

### getPlacement Signature

`getPlacement` uses the object signature for richer context:

```ts
// Recommended
await sdk.getPlacement({
  slotId: 'dashboard_banner',
  surfaceType: 'banner',
  entitlementHandle: 'mp4_download',
  planHandle: 'professional',
});
```

For object-request helper patterns, see `guides/placement-cookbook.md`.

## Placement Agent Workflow

For agent-authored placement implementation/review, follow:

- Workflow + acceptance checklist + reusable prompts: `guides/placement-agent-workflow.md`

## SDK Local Harness

The SDK includes a standalone local-mode harness that is useful for:

1. Playwright tests against deterministic slot rendering and trigger behavior.
2. Manual developer testing of user context, entitlement state, and manual triggers.
3. Editing harness plans, entitlements, slot content/metadata, and exporting or importing an `ExportedConfig` JSON snapshot.

Start the harness server:

```bash
npm --prefix web run harness:dev
```

Open the harness directly:

```bash
npm --prefix web run harness:open
```

Default URL:

`http://127.0.0.1:4174/src/sdk/harness/index.html`

The harness side panel exposes live `ExportedConfig` JSON, download/copy actions, and JSON import so SDK and CLI-oriented local scenarios can be captured and replayed.


Configurable environment variables:

- `RT_HARNESS_HOST` (default `127.0.0.1`)
- `RT_HARNESS_PORT` (default `4174`)
- `RT_HARNESS_OPEN=1` to auto-open browser on launch

### Snippet Mode

```html
<script src="https://cdn.revturbine.io/sdk.js"></script>
<script>
  RevTurbine.init({
    tenantId: 'your_tenant_id',
    apiKey: 'rt_live_xxx',
    endpoint: 'https://api.revturbine.io',
    mode: 'snippet',
  });
</script>
```

### React Mode

```tsx
import { RevTurbineProvider, SurfaceSlotComponent } from '@revt-eng/sdk';

function App() {
  return (
    <RevTurbineProvider
      options={{
        tenantId: 'your_tenant_id',
        apiKey: 'rt_live_xxx',
        endpoint: 'https://api.revturbine.io',
        mode: 'react',
      }}
      defaultUserId="user_123"
    >
      <YourApp />
      <SurfaceSlotComponent
        id="pricing_banner"
        category="fixed"
        personalization={{ user_name: 'Jane', plan_name: 'Free' }}
      />
    </RevTurbineProvider>
  );
}
```

## Documentation

## Troubleshooting

Use the troubleshooting matrix in `guides/troubleshooting.md` for common symptoms and fixes.

### Generated Docs

| Type | Command | Output | URL (dev) |
|------|---------|--------|-----------|
| API Reference (Typedoc) | `pnpm docs:sdk` | `web/sdk-docs/` | `/sdk-docs` |
| SDK Docs PDF Export | `pnpm docs:sdk:pdf` | `web/dist/sdk-docs/revturbine-sdk-docs.pdf` | — |
| Component Storybook | `pnpm storybook:sdk` | — (dev server on 6007) | `localhost:6007` |
| Build both | `pnpm build:sdk-docs` | `web/sdk-docs/` + `web/dist/sdk-storybook/` | `/sdk-docs`, `/sdk-storybook` |

### Self-Documenting Pattern

All public SDK exports use **TSDoc** comments that are:
1. Shown inline in VS Code / IDE intellisense
2. Extracted by **Typedoc** into a static HTML API reference
3. Picked up by **Storybook addon-docs** for component documentation pages

When adding or modifying SDK exports, include TSDoc with:
- A summary sentence
- `@example` code blocks for components and public methods
- `@param` / `@returns` for non-obvious function signatures

### Storybooks

Two separate Storybook instances:

| Instance | Config | Port | Purpose |
|----------|--------|------|---------|
| **Internal** | `web/.storybook/` | 6006 | App UI components (design system, features) |
| **SDK** | `web/.storybook-sdk/` | 6007 | Customer-facing placement components |

The internal Storybook excludes `src/sdk/**` stories; the SDK Storybook only includes them.

## Key Concepts

### Placement Type Registry

The SDK uses a registry pattern to map decision engine outputs to React components:

1. Built-in slot types (banner, modal, toast, etc.) are registered at init
2. Customers can register custom slot types via `useRegisterPlacementType`
3. `PlacementRenderer` resolves outputs → slot types via template → surface type → fallback chain

### Personalization Tokens

Content fields support `{{token_name}}` syntax. The SDK resolves tokens against a `PersonalizationContext` before rendering:

```ts
const personalization = {
  user_name: 'Jane',
  plan_name: 'Pro',
  usage_current: 8500,
  usage_limit: 10000,
};
```

### Decision Lifecycle

1. `registerPlacement()` → deterministic placement ID
2. `getPlacementDecision()` → visibility + content + reason codes
3. `trackTreatmentInteraction()` → impression/dismiss/CTA tracking
4. Suppression rules prevent re-showing dismissed placements

## Testing

- Slot component stories in `placements/slots/*.stories.tsx`
- Run SDK Storybook: `pnpm storybook:sdk`
- Each story demonstrates key visual variants and prop combinations
