# Runtime Mode Guide

Choose a runtime mode by answering one question first:

Do you want RevTurbine-hosted APIs as your runtime source of truth?

- Yes: use `revturbine_server`.
- No, but we have our own API/proxy layer: use `custom_endpoints`.
- No, and we want fully local execution: use `local_only`.

## Decision Tree

1. Do you need offline/local-only behavior with no network calls?
- Yes: `local_only`
- No: continue

2. Do you need to route SDK calls through customer-owned endpoints?
- Yes: `custom_endpoints`
- No: `revturbine_server`

## Mode Comparison

| Mode | Best for | Network dependency | Storage behavior | Required config |
|---|---|---|---|---|
| `revturbine_server` | Standard production integration | RevTurbine edge endpoints | SDK cache and interaction state | `tenantId`, `apiKey`, `endpoint`, `mode` |
| `custom_endpoints` | Customer proxy/service boundaries | Customer endpoints | SDK cache and interaction state | Base config + `endpointOverrides` |
| `local_only` | Demo/offline/local simulation | None | SDK local runtime state in localStorage | Base config + `localRuntime` |

## Provider Fallback Strategy (Recommended)

Provider fallbacks are orthogonal to runtime mode. You can configure them in any mode when you want explicit provider-chain control.

Available options:

- `provider`: primary provider.
- `providerFallbacks`: ordered fallback provider list.
- `providerFailureSlotBehavior`: `'invisible'` (default) or `'placeholder'`.

Behavior:

1. SDK calls primary provider first.
2. If primary fails, SDK logs a warning and executes fallbacks in order.
3. If all configured providers fail for a method, SDK disables itself.
4. Disabled SDK returns hidden or placeholder placement output based on `providerFailureSlotBehavior`.

Recommendation by mode:

1. `revturbine_server`: add at least one fallback provider for resilience.
2. `custom_endpoints`: strongly recommend fallbacks because proxy integrations can be brittle during deploys.
3. `local_only`: provider fallbacks are optional; local runtime resolvers are often sufficient.

## Copy-Paste Setup

### Server runtime

```ts
import { initRevTurbine, createServerRuntimeConfig } from '@revturbine/sdk';

const sdk = initRevTurbine(
  createServerRuntimeConfig({
    tenantId: 'tenant_abc',
    apiKey: 'rt_live_xxx',
    endpoint: 'https://api.revturbine.io',
    mode: 'react',
  }),
);
```

### Server runtime with provider fallback

```ts
import { initRevTurbine, createServerRuntimeConfig } from '@revturbine/sdk';

const sdk = initRevTurbine({
  ...createServerRuntimeConfig({
    tenantId: 'tenant_abc',
    apiKey: 'rt_live_xxx',
    endpoint: 'https://api.revturbine.io',
    mode: 'react',
  }),
  provider: primaryProvider,
  providerFallbacks: [fallbackProviderA, fallbackProviderB],
  providerFailureSlotBehavior: 'placeholder',
});
```

### Custom endpoints runtime

```ts
import { initRevTurbine, createCustomEndpointRuntimeConfig } from '@revturbine/sdk';

const sdk = initRevTurbine(
  createCustomEndpointRuntimeConfig({
    tenantId: 'tenant_abc',
    apiKey: 'rt_live_xxx',
    endpoint: 'https://proxy.example.com',
    mode: 'react',
    endpointOverrides: {
      decideContext: '/decisioning/decide-context',
      bootstrapContext: '/decisioning/bootstrap',
      checkEntitlement: '/entitlements/check',
      ingestEvents: '/events/ingest',
      touchpointTransition: '/touchpoints/transition',
    },
  }),
);
```

### Local-only runtime

```ts
import { initRevTurbine, createLocalRuntimeConfig } from '@revturbine/sdk';

const sdk = initRevTurbine(
  createLocalRuntimeConfig({
    tenantId: 'tenant_local',
    apiKey: 'local',
    endpoint: 'http://localhost',
    mode: 'react',
    localRuntime: {
      storageKey: 'my-app:revturbine-local-runtime',
      initialData: {
        trialStatus: { inTrial: true, dayNumber: 3, daysRemaining: 11 },
      },
    },
  }),
);
```
