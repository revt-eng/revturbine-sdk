import type { DemoState } from './demo-state';

/**
 * A saved journey: a named, full {@link DemoState} that puts the simulated user
 * at a recognisable monetization moment (plan 83). Journeys live in JSON under
 * `playground/journeys/<set>.json` so they persist to the codebase.
 */
export interface Journey {
  id: string;
  label: string;
  /** What the viewer should see when this journey is selected. */
  shows: string;
  state: DemoState;
}

/** A named group of journeys, persisted as one `journeys/<id>.json` file. */
export interface JourneySet {
  id: string;
  label: string;
  journeys: Journey[];
}

/**
 * Safe set id ↔ filename: the set id IS the JSON filename stem, so it must be a
 * plain slug — no path separators / traversal. Shared by the loader and the
 * dev-write middleware (the latter writes `journeys/<id>.json`).
 */
export const SAFE_SET_ID = /^[a-z0-9][a-z0-9_-]{0,48}$/i;

export function isSafeSetId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_SET_ID.test(id);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate untrusted data (a committed JSON file or a POSTed save) into a typed
 * {@link JourneySet}, or return null. Enforces a safe set id (filename safety)
 * and the journey shape; the inner state is parsed at the JSON boundary (it is
 * applied to demo state, not a security vector).
 */
export function parseJourneySet(data: unknown): JourneySet | null {
  if (!isObject(data) || !isSafeSetId(data.id) || typeof data.label !== 'string') return null;
  if (!Array.isArray(data.journeys)) return null;
  const journeys: Journey[] = [];
  for (const entry of data.journeys) {
    if (!isObject(entry) || typeof entry.id !== 'string' || typeof entry.label !== 'string') return null;
    if (!isObject(entry.state)) return null;
    journeys.push({
      id: entry.id,
      label: entry.label,
      shows: typeof entry.shows === 'string' ? entry.shows : '',
      state: entry.state as unknown as DemoState, // sdk-ok: boundary-parse (JSON → DemoState; applied to demo state only)
    });
  }
  return { id: data.id, label: data.label, journeys };
}
