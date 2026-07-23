'use client';

import { useCallback, useRef, useState } from 'react';
import { useRevTurbine } from './useRevTurbine';
import { useTrack, type TrackOptions } from './useTrack';
import { categorizeActionError, type ActionErrorCategory } from './useTrackedAction';
import type { RevTurbineGateResult, RevTurbineEntitlementContext, EntitlementResult } from '../customer-side';

/** State + runner returned by {@link useGatedAction}. */
export interface GatedAction<A extends unknown[], R> {
  /** Run the gated action. Returns the {@link RevTurbineGateResult}: `ran: true` with the result, or `ran: false` with the entitlement. */
  run: (...args: A) => Promise<RevTurbineGateResult<R>>;
  /** True while the gate check / action is in flight. */
  isRunning: boolean;
  /** True when the last run was denied by the entitlement. */
  denied: boolean;
  /** The entitlement result from the last run, or `null`. */
  entitlement: EntitlementResult | null;
  /** The last action failure's normalized category, or `null`. */
  error: ActionErrorCategory | null;
}

/**
 * The React analog of the headless `rt.gate(action, fn)` (plan 144 TASK-14 /
 * REQ-21, AC-11). `run` **delegates to `sdk.gate`**, so it emits the same active
 * gate sequence — `gate_attempted`, then `gate_allowed` or `gate_denied` — rather
 * than forking it. When allowed, the action runs wrapped in tracked-action
 * telemetry (`${action}_started` → `_completed` / `_failed`) and its return value
 * is preserved. Without a provider, `run` is a safe no-op that reports denied
 * (AC-13).
 */
export function useGatedAction<A extends unknown[], R>(
  action: string,
  fn: (...args: A) => Promise<R> | R,
  context?: RevTurbineEntitlementContext,
  options?: TrackOptions,
): GatedAction<A, R> {
  const { sdk } = useRevTurbine();
  const track = useTrack();
  const [isRunning, setIsRunning] = useState(false);
  const [denied, setDenied] = useState(false);
  const [entitlement, setEntitlement] = useState<EntitlementResult | null>(null);
  const [error, setError] = useState<ActionErrorCategory | null>(null);
  const latest = useRef({ action, fn, context, options, track, sdk });
  latest.current = { action, fn, context, options, track, sdk };

  const run = useCallback(async (...args: A): Promise<RevTurbineGateResult<R>> => {
    const { action, fn, context, options, track, sdk } = latest.current;
    if (!sdk) {
      // AC-13 — no provider: don't run, report denied without an entitlement.
      const denialResult: RevTurbineGateResult<R> = {
        ran: false,
        entitlement: { status: 'denied', allowed: false },
      };
      setDenied(true);
      return denialResult;
    }

    setIsRunning(true);
    setError(null);
    try {
      // Delegate to the headless gate so the gate_attempted/allowed/denied
      // sequence is emitted there — not forked here.
      const result = await sdk.gate(
        action,
        async (): Promise<R> => {
          track(`${action}_started`, {}, options);
          try {
            const value = await fn(...args);
            track(`${action}_completed`, {}, options);
            return value;
          } catch (err) {
            const category = categorizeActionError(err);
            setError(category);
            track(`${action}_failed`, { error_category: category }, options);
            throw err;
          }
        },
        context,
      );
      setDenied(!result.ran);
      setEntitlement(result.entitlement);
      return result;
    } finally {
      setIsRunning(false);
    }
  }, []);

  return { run, isRunning, denied, entitlement, error };
}
