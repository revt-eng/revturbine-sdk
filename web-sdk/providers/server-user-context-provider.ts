/**
 * Server-user-context provider (plan 165 TASK-4 = plan 157's "provider auto-wire"
 * follow-up).
 *
 * Surfaces the user's SERVER-KNOWN, client-safe context — fetched from
 * `GET /api/sdk/client-context` (plan 157) — into the evaluation traits bag under
 * the `traits:server` namespace, so segment/placement evaluation can match on
 * RevTurbine-authoritative signals (trial state, coarse billing) that the app
 * cannot self-assert.
 *
 * Precedence: the SDK merges `traits:<namespace>` domains into one unified traits
 * bag; app-provided traits take precedence over server traits. This provider only
 * contributes the server-authoritative signals below — it never overwrites an
 * app-set trait of the same name.
 *
 * Security (rides plan 157's client-session token model): the snapshot is fed
 * EXCLUSIVELY from the token-authenticated `GET /api/sdk/client-context` fetch —
 * authorized by the opaque `rt_client_` token the customer's backend mints (via
 * `clientSessions.create`, optionally through the hardened OIDC exchange). It is
 * never populated from app-assertable input, so an app cannot forge
 * server-authoritative signals (trial state, billing) into `traits:server`; and
 * because the token scopes the read to its own subject, one user cannot read
 * another's server context. Server-side entitlement checks remain authoritative
 * regardless of what the browser evaluates. The snapshot carries no raw PII (the
 * serve already projected the client-safe view); the transmit path applies
 * `redactPii` to trait/event payloads before they leave the browser regardless.
 */
import type { TraitsProvider, TraitsProviderState } from '@revt-eng/core';

/**
 * The client-safe, server-known signals surfaced as `traits:server` traits.
 * Sourced from the mapped `/api/sdk/client-context` response.
 */
export interface ServerUserContextSnapshot {
  /** Trial signals the control plane owns. */
  trial?: {
    in_trial?: boolean;
    state?: string;
    days_remaining?: number;
  };
  /** Coarse billing-recovery signal (raw failed-payment detail never crosses the boundary). */
  payment_at_risk?: boolean;
}

/** The `traits:server` domain name — a `TraitsNamespace`. */
export const SERVER_TRAITS_DOMAIN = 'traits:server' as const;

/**
 * A {@link TraitsProvider} keyed to `traits:server`. Auto-wired by the SDK when a
 * client-context token is configured; call {@link setSnapshot} whenever a fresh
 * server context is fetched.
 */
export class ServerUserContextProvider implements TraitsProvider<'traits:server'> {
  readonly domain = SERVER_TRAITS_DOMAIN;
  private snapshot: ServerUserContextSnapshot = {};

  /** Replace the server-known snapshot (called after each client-context fetch). */
  setSnapshot(snapshot: ServerUserContextSnapshot): void {
    this.snapshot = snapshot ?? {};
  }

  /** Whether any server signal is currently present. */
  hasSignals(): boolean {
    return Object.keys(this.toTraits()).length > 0;
  }

  /** Resolve the current `traits:server` state for evaluation. */
  resolve(): TraitsProviderState {
    return { traits: this.toTraits() };
  }

  private toTraits(): Record<string, string | number | boolean> {
    const traits: Record<string, string | number | boolean> = {};
    const trial = this.snapshot.trial;
    if (trial) {
      if (typeof trial.in_trial === 'boolean') traits.trial_active = trial.in_trial;
      if (typeof trial.state === 'string' && trial.state.length > 0) traits.trial_state = trial.state;
      if (typeof trial.days_remaining === 'number') traits.trial_days_remaining = trial.days_remaining;
    }
    if (this.snapshot.payment_at_risk === true) traits.payment_at_risk = true;
    return traits;
  }
}
