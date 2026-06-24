import { parseJourneySet, type Journey, type JourneySet } from './journey-schema';

export type { Journey, JourneySet };

/**
 * Journey sets are loaded from the committed JSON under `playground/journeys/`
 * (plan 83). `import.meta.glob` is resolved by Vite at transform time, so a set
 * the dev-write middleware adds appears in the picker after the next reload;
 * within a session the manager merges saves in optimistically.
 */
const modules = import.meta.glob('../journeys/*.json', { eager: true, import: 'default' });

function loadJourneySets(): JourneySet[] {
  const sets: JourneySet[] = [];
  for (const path in modules) {
    const set = parseJourneySet(modules[path]);
    if (set) sets.push(set);
  }
  // Built-in defaults first, then user sets alphabetically.
  return sets.sort((a, b) => {
    if (a.id === 'built-in') return -1;
    if (b.id === 'built-in') return 1;
    return a.label.localeCompare(b.label);
  });
}

/** The committed journey sets, built-in first. */
export const JOURNEY_SETS: JourneySet[] = loadJourneySets();

/** Every journey across every set, flattened. */
export function allJourneys(sets: JourneySet[] = JOURNEY_SETS): Journey[] {
  return sets.flatMap((set) => set.journeys);
}

/** Resolve a journey by id across the given sets (defaults to the committed ones). */
export function findJourney(id: string, sets: JourneySet[] = JOURNEY_SETS): Journey | undefined {
  return allJourneys(sets).find((journey) => journey.id === id);
}

/** Derive a safe slug id from a free-text label (journey id or set filename stem). */
export function toJourneyId(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

/**
 * Persist a journey set to the codebase via the dev-only write middleware
 * (`playground/journeys/<set.id>.json`). Only works against the Vite dev
 * server; returns a typed result so the UI can surface failures.
 */
export async function postJourneySet(
  set: JourneySet,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/__journeys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(set),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: detail || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
