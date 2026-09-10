/**
 * Type-level fixtures for the typed platform emit surface (plan 228 TASK-4).
 *
 * Compile-time assertions, checked by `pnpm check:types:exact` — every
 * `@ts-expect-error` is load-bearing: if the line stops erroring, tsc fails
 * with "Unused '@ts-expect-error' directive" and the structural guarantee is
 * gone.
 *
 * What is being guarded: control-plane events are STRUCTURALLY excluded from
 * `emitPlatformEvent` — a customer (or a careless internal caller) cannot
 * forge RevTurbine's own product telemetry through the platform surface. The
 * CP has its own typed path (`trackControlPlaneEvent`) with source
 * classification. And the payload parameter is inferred per event name, so a
 * wrong-shaped payload is a compile error, not a quarantined row.
 */
import type { EmittablePlatformEventName, RevTurbineCustomerSdk } from './customer-side';

declare const sdk: RevTurbineCustomerSdk;

// ── Control-plane names are not emittable platform names ────────────────────

// @ts-expect-error — playbook_version_deployed is control-plane vocabulary
const cp1: EmittablePlatformEventName = 'playbook_version_deployed';

// @ts-expect-error — web_signed_in is control-plane vocabulary
const cp2: EmittablePlatformEventName = 'web_signed_in';

// @ts-expect-error — entity_created is control-plane vocabulary
const cp3: EmittablePlatformEventName = 'entity_created';

// The non-CP bands ARE emittable: client, server, meta, webhook-derived.
const ok1: EmittablePlatformEventName = 'gate_evaluated';
const ok2: EmittablePlatformEventName = 'growth_signal_observed';
const ok3: EmittablePlatformEventName = 'sdk_validation_warning';
const ok4: EmittablePlatformEventName = 'subscription_started';
const ok5: EmittablePlatformEventName = 'account_created';

// ── emitPlatformEvent rejects CP names and wrong payload shapes ─────────────

void (async () => {
  // @ts-expect-error — CP event through the platform surface is forgery
  await sdk.emitPlatformEvent('playbook_version_deployed', {});

  // @ts-expect-error — gate_evaluated's payload requires entitlement_handle et al.
  await sdk.emitPlatformEvent('gate_evaluated', {});

  // Single line so the enum error lands within the directive's reach.
  // @ts-expect-error — outcome is the three-way enum, not arbitrary string
  await sdk.emitPlatformEvent('gate_evaluated', { entitlement_handle: 'seats', outcome: 'blocked', gated: true, reason: null, limit: null, used: null, remaining: null });

  // Correct payloads compile.
  await sdk.emitPlatformEvent('gate_evaluated', {
    entitlement_handle: 'seats',
    outcome: 'denied',
    gated: true,
    reason: 'limit_reached',
    limit: 5,
    used: 5,
    remaining: 0,
  });
  await sdk.emitPlatformEvent('subscription_started', {
    billing_ref: 'acc_1:billing:start',
    plan_handle: 'growth',
    billing_period: 'monthly',
    amount_cents: 9900,
    currency: 'usd',
  });
})();

void [cp1, cp2, cp3, ok1, ok2, ok3, ok4, ok5];
