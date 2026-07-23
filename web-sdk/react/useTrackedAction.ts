'use client';

import { useCallback, useRef, useState } from 'react';
import { useTrack, type TrackOptions } from './useTrack';

/**
 * A non-sensitive, normalized error bucket for a failed action (plan 144
 * TASK-14). Deliberately coarse — it never carries the raw error message, which
 * could contain user input or PII.
 */
export type ActionErrorCategory =
  | 'aborted'
  | 'timeout'
  | 'network'
  | 'validation'
  | 'permission'
  | 'unknown';

/**
 * Bucket an unknown thrown value into a {@link ActionErrorCategory} without
 * surfacing its message (plan 144 TASK-14 — non-sensitive categories only).
 */
export function categorizeActionError(err: unknown): ActionErrorCategory { // sdk-ok: boundary-parse
  if (err instanceof Error) {
    const name = err.name.toLowerCase();
    const msg = err.message.toLowerCase();
    if (name === 'aborterror' || msg.includes('abort')) return 'aborted';
    if (name === 'timeouterror' || msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
    if (msg.includes('network') || msg.includes('failed to fetch') || msg.includes('fetch')) return 'network';
    if (name === 'validationerror' || msg.includes('invalid') || msg.includes('validation')) return 'validation';
    if (msg.includes('permission') || msg.includes('forbidden') || msg.includes('unauthorized')) return 'permission';
  }
  return 'unknown';
}

/** State + runner returned by {@link useTrackedAction}. */
export interface TrackedAction<A extends unknown[], R> {
  /** Run the action: emits `${name}_started`, then `${name}_completed` or `${name}_failed`. Preserves the return value and re-throws. */
  run: (...args: A) => Promise<R>;
  /** True while the action is in flight. */
  isRunning: boolean;
  /** The last failure's normalized category, or `null`. */
  error: ActionErrorCategory | null;
}

/**
 * Wrap an async action so its lifecycle is telemetered (plan 144 TASK-14 /
 * REQ-21). `run` emits `${name}_started`, then `${name}_completed` on success or
 * `${name}_failed` (with a non-sensitive `error_category`) on throw — and
 * **preserves the return type and re-throws**, so it is a drop-in wrapper. Events
 * inherit the enclosing {@link TelemetryScope}; a missing provider makes the
 * telemetry a no-op (AC-13) but never swallows the action.
 */
export function useTrackedAction<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R> | R,
  options?: TrackOptions,
): TrackedAction<A, R> {
  const track = useTrack();
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<ActionErrorCategory | null>(null);
  const latest = useRef({ name, fn, options, track });
  latest.current = { name, fn, options, track };

  const run = useCallback(async (...args: A): Promise<R> => {
    const { name, fn, options, track } = latest.current;
    setIsRunning(true);
    setError(null);
    track(`${name}_started`, {}, options);
    try {
      const result = await fn(...args);
      track(`${name}_completed`, {}, options);
      return result;
    } catch (err) {
      const category = categorizeActionError(err);
      setError(category);
      track(`${name}_failed`, { error_category: category }, options);
      throw err; // preserve the caller's error handling
    } finally {
      setIsRunning(false);
    }
  }, []);

  return { run, isRunning, error };
}
