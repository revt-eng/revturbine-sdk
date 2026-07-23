'use client';

import { useCallback, useContext, useRef } from 'react';
import { useRevTurbine } from './useRevTurbine';
import { TelemetryScopeContext, type TrackPurpose } from './TelemetryScope';
import type { SdkEventProperties } from '../customer-side';

/**
 * Property names a caller must not set — they belong to RevTurbine's canonical
 * envelope and lifted provenance columns (plan 144 TASK-12). Passing one is
 * dropped rather than allowed to overwrite the system value.
 */
const RESERVED_TRACK_PROPS = new Set<string>([
  'tenant_id',
  'user_id',
  'anonymous_id',
  'session_id',
  'url',
  'path',
  'page_title',
  'event_time',
  'event_id',
  'request_id',
  'origin',
  'playbook_version',
  'decision_id',
]);

/**
 * Per-event options for {@link useTrack} — the one shared shape scope defaults
 * and later telemetry components also draw from (plan 144 TASK-12).
 */
export interface TrackOptions {
  /** Overrides the scope `area` for this event. */
  area?: string;
  /** Overrides the scope `action` for this event. */
  action?: string;
  /** Advisory {@link TrackPurpose}; overrides the scope purpose. */
  purpose?: TrackPurpose;
  /** Emit at most once per distinct key, for this hook instance's lifetime. */
  dedupeKey?: string;
  /** Emit at most once (keyed on the event name), for this hook instance's lifetime. */
  once?: boolean;
  /** Send immediately instead of batching. */
  immediate?: boolean;
}

/** The tracking function returned by {@link useTrack}. */
export type TrackFn = (name: string, data?: SdkEventProperties, options?: TrackOptions) => void;

let reservedWarned = false;

function stripReserved(data?: SdkEventProperties): SdkEventProperties {
  if (!data) return {};
  const out: SdkEventProperties = {};
  let dropped = false;
  for (const [key, value] of Object.entries(data)) {
    if (RESERVED_TRACK_PROPS.has(key)) {
      dropped = true;
      continue;
    }
    out[key] = value;
  }
  if (dropped && !reservedWarned && typeof console !== 'undefined') {
    reservedWarned = true;
    console.warn(
      '[RevTurbine] Dropped reserved property name(s) from a tracked event — these are ' +
        'RevTurbine canonical/provenance fields and cannot be overwritten from event data.',
    );
  }
  return out;
}

/**
 * Returns a `track(name, data?, options?)` function bound to the enclosing
 * {@link TelemetryScope} (plan 144 TASK-12 / REQ-21).
 *
 * - Scope context (`area` / `action` / `purpose`) merges **outer → inner →
 *   invocation** — the per-event option wins.
 * - `once` and `dedupeKey` suppress repeats for this hook instance's lifetime.
 * - Reserved property names are dropped so a caller can't overwrite canonical
 *   fields.
 * - Without a RevTurbine provider (absent or failed init) the function is a safe
 *   no-op and never throws (AC-13).
 */
export function useTrack(): TrackFn {
  const { sdk } = useRevTurbine();
  const scope = useContext(TelemetryScopeContext);
  const firedKeys = useRef<Set<string>>(new Set());

  return useCallback<TrackFn>(
    (name, data, options) => {
      if (!sdk) return; // AC-13 — no provider, no crash

      const dedupe = options?.dedupeKey ?? (options?.once ? `once:${name}` : null);
      if (dedupe !== null) {
        if (firedKeys.current.has(dedupe)) return;
        firedKeys.current.add(dedupe);
      }

      const area = options?.area ?? scope.area;
      const action = options?.action ?? scope.action;
      const purpose = options?.purpose ?? scope.purpose;

      const payload: SdkEventProperties = { ...stripReserved(data) };
      if (area != null) payload.area = area;
      if (action != null) payload.action = action;
      if (purpose != null) payload.purpose = purpose;

      void sdk.capture(name, payload, { immediate: options?.immediate }).catch(() => {
        // Best-effort — a capture failure must never surface to the host UI.
      });
    },
    [sdk, scope],
  );
}
