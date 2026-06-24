# RevTurbine Server SDK — Node.js

Server-side evaluation SDK for RevTurbine. Pre-evaluate placement decisions, entitlements, and user context on the server and hydrate the client-side SDK with the results.

## Usage

```ts
import { RevTurbineServer } from '@revt-eng/server-node';

const server = new RevTurbineServer({
  tenantId: 'tenant_abc',
  apiKey: process.env.REVTURBINE_SECRET_KEY!,
  endpoint: 'https://api.revturbine.io',
});

const payload = await server.evaluate({
  userId: 'user_123',
  traits: { plan: 'pro' },
  placements: [{ slotId: 'hero_banner' }],
  includeTheme: true,
});

// Pass to client via page props, RSC, etc.
return { props: { rtPayload: payload } };
```

## API

### `RevTurbineServer`

- `evaluate(request)` — Full evaluation: placements, entitlements, trial status, user context, theme.
- `getPlacement(userId, placement, traits?)` — Evaluate a single placement.
- `checkEntitlement(userId, handle, context?)` — Check a single entitlement.
- `getTrialStatus(userId)` — Fetch trial status.

### Types

All payload types are re-exported from `@revt-eng/schema`:
- `ServerEvaluationPayload`
- `ServerEvaluationRequest`
- `RevTurbineServerOptions`
- `ServerPlacementRequest` / `ServerPlacementDecision`
- `ServerEntitlementResult` / `ServerUserContext`

## See Also

- [server-csharp/](../server-csharp/) — C# implementation
- [server-java/](../server-java/) — Java implementation
- [server-python/](../server-python/) — Python implementation
- [server-rust/](../server-rust/) — Rust implementation
