# Runtime Mode Guide

The runtime mode chooses where the Playbook and the user's state come from. It
does not choose where decisions run. In every mode the SDK evaluates
entitlements and placements locally, inside the app or on its server, from the
Playbook it holds. No entitlement check and no placement decision calls a
RevTurbine API, so RevTurbine's availability never decides what a user may do.

Choose a mode by answering one question first: where should the Playbook come
from?

- RevTurbine stores and versions it, and the SDK fetches the launched Release: connected mode, `revturbine_server`.
- The same, with selected context and telemetry calls routed through our own proxy: `custom_endpoints`.
- It ships with the app: local mode, `local_only`.

The public page is `pages-build/src/content/docs/guides/runtime-modes.mdx`; keep
this guide in step with it.

## Decision Tree

1. Should the Playbook ship with the app, with no config or decisioning calls?
- Yes: `local_only`
- No: continue

2. Do context or telemetry calls need to go through customer-owned endpoints?
- Yes: `custom_endpoints` (Playbook delivery stays with RevTurbine)
- No: `revturbine_server`

## Mode Comparison

Every mode requires `user: { id }` (your stable internal user id) as well as the
config in the last column: a Playbook is evaluated for an identified user, and
there is no anonymous mode. Without a non-empty id the SDK is disabled in every
mode — no requests, no evaluation, fallbacks only.

| Mode | Best for | Where the Playbook comes from | Network dependency | Storage behavior | Required config |
|---|---|---|---|---|---|
| `revturbine_server` (connected mode) | Changing monetization without a deploy | RevTurbine, cached locally and refreshed in the background | Playbook delivery, user state and telemetry. Never a decision | SDK cache and interaction state | `publicKey` (and a `clientSession` route for server-derived state). `tenantId` and `endpoint` are optional (`tenantId` since 0.11.14: the public key identifies the tenant; a passed id that differs is warned about and the key's tenant is used) |
| `custom_endpoints` | Customer proxy/service boundaries | RevTurbine, cached locally as in connected mode | As connected mode, with the overridden context and telemetry calls going to customer endpoints | SDK cache and interaction state | Connected-mode config + `endpointOverrides` |
| `local_only` (local mode) | Demos, offline use, and Playbooks that change with a deploy | Bundled with the app | None for config or decisions. The anonymous SDK init and error events are the one exception; set `anonymousTelemetry: false` for zero requests | SDK local runtime state in localStorage | `localRuntime: { playbook }` |

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
import { initRevTurbine, createServerRuntimeConfig } from '@revt-eng/sdk';

const sdk = initRevTurbine(
  createServerRuntimeConfig({
    tenantId: 'tenant_abc',
    publicKey: 'rtk_…',
    user: { id: 'user_123' }, // required in every runtime mode
  }),
);
```

### Server runtime with provider fallback

```ts
import { initRevTurbine, createServerRuntimeConfig } from '@revt-eng/sdk';

const sdk = initRevTurbine({
  ...createServerRuntimeConfig({
    tenantId: 'tenant_abc',
    publicKey: 'rtk_…',
    user: { id: 'user_123' },
  }),
  provider: primaryProvider,
  providerFallbacks: [fallbackProviderA, fallbackProviderB],
  providerFailureSlotBehavior: 'placeholder',
});
```

### Custom endpoints runtime

```ts
import { initRevTurbine, createCustomEndpointRuntimeConfig } from '@revt-eng/sdk';

const sdk = initRevTurbine(
  createCustomEndpointRuntimeConfig({
    tenantId: 'tenant_abc',
    publicKey: 'rtk_…',
    user: { id: 'user_123' },
    // `endpoint` stays RevTurbine: overrides do not reroute Playbook delivery.
    endpointOverrides: {
      clientContext: 'https://proxy.example.com/revturbine/client-context',
      userContext: 'https://proxy.example.com/revturbine/user-context',
      trialStatus: 'https://proxy.example.com/revturbine/trial-status',
      ingestEvents: 'https://proxy.example.com/revturbine/track',
    },
  }),
);
```

### Local-only runtime

```ts
import { initRevTurbine, RuntimeMode } from '@revt-eng/sdk';
import playbook from './revturbine.playbook.json';

// No account, key, tenant or endpoint: the Playbook is the whole configuration.
const sdk = initRevTurbine({
  runtimeMode: RuntimeMode.LocalOnly,
  user: { id: 'user_123' },
  localRuntime: {
    playbook,
    storageKey: 'my-app:revturbine-local-runtime',
  },
});
```
