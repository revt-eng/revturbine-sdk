# Cloud entitlement examples

Protect an application action with `@revturbine/sdk` 0.12.4. Each request verifies
an application-issued UserContext token, obtains a bounded shared Playbook
snapshot, creates an SDK session for that user, checks `data_export`, and disposes
the session. Only the immutable Playbook and public-key cache are shared.

## Run locally

Requires Node.js 22.13 or newer and npm. From this directory:

```sh
npm ci
npm run typecheck
npm test
```

Tests build the actual adapters, exercise HTTP/event boundaries and the public
SDK, and run the browser bundle inside Edge Runtime. Upstream delivery and JWKS
responses are controlled fixtures. No provider account, credentials, provisioned
resources, or deployment is required. These checks establish local compatibility,
not production latency, regional availability, or your cloud IAM configuration.

Read the [cloud guide](https://revturbine.com/docs/guides/cloud-entitlements/) and
[step-by-step tutorial](https://revturbine.com/docs/tutorials/vercel-edge-entitlements/).

## Entry points

| Platform | Entry | Execution location |
| --- | --- | --- |
| Vercel | `api/check-export.ts` | Standalone Edge Function |
| Vercel | `api/check-export-node.ts` | Node.js Function |
| Firebase | `providers/firebase.ts` | Regional Functions v2; Hosting can rewrite to it |
| AWS | `providers/aws-lambda.ts` | Regional Lambda, HTTP API payload v2 |
| AWS | `providers/aws-lambda-edge.ts` | CloudFront Lambda@Edge origin-request |
| Google Cloud | `providers/google-cloud-run.ts` | Regional Cloud Run, optionally behind a global load balancer |
| Azure | `providers/azure-functions.ts` | Functions v4, optionally behind Front Door |

Firebase Hosting, Google's global load balancer, and Azure Front Door are edge
front doors; the SDK runs in their regional application backends. CloudFront
Functions does not support this SDK bundle; use Lambda@Edge or regional Lambda.

## Configuration and trust

The names in `.env.example` are the complete common configuration. Put the
server token in the provider's secret store, never a browser bundle, request body,
or query string. Set the tenant and exact HTTPS delivery origins for your account.
The application issuer owns the RSA private key and derives `UserContext` from
authenticated, authorized application records. `issuer/issue-context-token.ts`
is a signing helper, not a public endpoint accepting arbitrary context.

This application-issued JWT is not an `rt_client_` RevTurbine client-session
token. The two tokens have different issuers, audiences, and verification paths;
never substitute one for the other.

The token verifies issuer, audience, tenant, subject, type and a maximum five-minute
lifetime. Token claims can remain valid until expiry: choose shorter lifetimes or
add application revocation checks if your access policy requires them. Requests
cannot select a tenant, delivery origin, plan, or user through their body.

The cache authenticates bootstrap, validates tenant/environment, validity window,
schema compatibility, byte length and SHA-256, and allows only configured HTTPS
origins without redirects. It refreshes after at most 60 seconds, capped by
manifest expiry. Failed refreshes return 503 instead of stale grants. This example
does **not** verify an optional Ed25519 manifest signature; trust starts at the
authenticated HTTPS bootstrap and the digest it supplies. It is not an offline
signed-distribution implementation.

Delivery's four-second timeout applies to each fetch, not the whole operation.
JWKS resolution has its own three-second timeout. Sequential bootstrap,
manifest, bundle, and key requests can take longer in total; set an application
deadline and provider timeout appropriate to your latency budget.

Responses use `private, no-store`. Disable CDN caching for the protected route,
forward Authorization, and prevent bypass of the authenticated application route.
The example returns a decision receipt. Put the actual export after the allowed
check, with your resource ownership checks, in the same trusted operation. A
separate check endpoint is not enforcement. This boolean example does not provide
atomic quota reservation or durable usage accounting.

## Optional provider packaging

`npm run build` emits `dist/<provider>/` bundles. Deployment is optional and is
not part of the test procedure. Review current provider limits before adopting.

- **Vercel:** use the two `api/` entries in a Vercel application. Keep the Edge
  entry separate from Node-only imports. The standalone Edge Function is distinct
  from a Next.js page/route runtime selection. Use the Node entry when your
  framework/runtime does not support Edge execution.
- **Firebase:** `dist/firebase/` includes the functions package and a Hosting
  rewrite template. Install its production dependencies; set the server key with
  Firebase Secrets and other settings in your Functions environment. The template's
  `public` directory represents your own Hosting app and must exist before using
  the Hosting rewrite. Functions-only deployment does not need a Hosting site.
- **AWS Lambda:** zip `dist/aws/index.cjs`, select Node.js 22 and handler
  `index.handler`, and use API Gateway HTTP API payload format 2.0. Supply common
  configuration in environment variables and protect the token appropriately.
- **Lambda@Edge:** edit the non-secret Secrets Manager ARN/region in
  `providers/aws-edge-config.ts`, then rebuild. The secret holds the common
  configuration as a JSON object of strings. Grant the execution role only the
  required `secretsmanager:GetSecretValue` access and KMS decrypt when applicable.
  Deploy a numbered version in us-east-1 with a supported x86 Node runtime and
  Lambda/Edge Lambda service trust. Custom environment variables, VPCs and layers
  are unavailable. Associate with **origin-request**, disable caching for this
  behavior, and forward Authorization. Configuration refreshes every five minutes;
  failed refreshes fail closed. Budget cold-start and remote-secret latency.
- **Google Cloud:** build with `deploy/google-cloud-run/Dockerfile` using
  `dist/google-cloud-run/` as context. Supply environment/Secret Manager settings.
  The server binds `0.0.0.0:$PORT`. A global HTTPS load balancer does not move the
  evaluator out of the Cloud Run region.
- **Azure:** `dist/azure/` contains the v4 host/package files; install production
  dependencies and configure application settings/Key Vault references. The HTTP
  function is host-anonymous because the application JWT is verified inside it.
  Restrict origin ingress when using Front Door, disable caching on this route,
  and preserve the application Authorization header. Do not combine it with an
  origin-authentication mode that overwrites that header.

`src/native-connected-example.ts` shows the smaller native connected SDK path.
Use it when you do not need the custom cache policy; the cache here is application
code with explicit freshness and failure behavior, not an additional SDK API.
