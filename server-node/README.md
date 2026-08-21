# RevTurbine Server SDK — Node.js

Server-side support for RevTurbine on Node.

**Evaluation does not happen here.** It is a pure function of (UserContext,
Playbook) and runs in the customer SDKs — there is no hosted decision endpoint
(plan 192). This package gives a Node backend the two things it *does* need
from the server side: a way to mint browser-safe session tokens, and a way to
evaluate locally.

## Minting a client session

`RevTurbineServer` exchanges your secret key for a short-lived, browser-safe
`rt_client_` token. The client SDK's `clientSession` callback consumes it and
re-mints on expiry, so server-derived plan / trial / payment state stays fresh
with no further application code.

```ts
import { RevTurbineServer } from '@revt-eng/server-node';

const server = new RevTurbineServer({
  tenantId: 'tenant_abc',
  apiKey: process.env.REVTURBINE_SECRET_KEY!,
  endpoint: 'https://api.revturbine.io',
});

// Hand the token to the browser.
const { token } = await server.createClientSession({ userId: 'user_123' });
```

## Evaluating locally

`LocalEvaluationServer` fetches a Playbook and evaluates in-process — the same
engine the client SDKs run, so it decides identically.

## API

### `RevTurbineServer`

- `createClientSession(input)` — Mint a browser-safe `rt_client_` session token.
- `clientSessions.create(input)` — Namespaced alias of the same call.

### `LocalEvaluationServer`

- `evaluate(request)` — Evaluate placements and entitlements locally against a
  fetched Playbook.

### Removed in plan 194 TASK-9

`evaluate`, `getPlacement`, `checkEntitlement` and `getTrialStatus` were removed
from `RevTurbineServer`. Each called a hosted decision endpoint that plan 192
deleted, so each had been returning a network error since that shipped. Use
`LocalEvaluationServer` for evaluation, or the client SDK.

The Python thin-RPC client (`revturbine_server`) was removed in the same change
for the same reason — every one of its methods was a decision verb, and unlike
this class it had no session mint to keep. The Python server story is
`RevTurbineCustomerSdk`, which evaluates locally.

### Types

Payload types are re-exported from `@revt-eng/schema`.

## See Also

- [server-python/](../server-python/) — Python implementation (`RevTurbineCustomerSdk`)
