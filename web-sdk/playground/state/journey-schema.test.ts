import { describe, expect, it } from 'vitest';
import { isSafeSetId, parseJourneySet } from './journey-schema';

/**
 * Plan 83 TASK-6: the set id becomes a filename, so the safe-id guard and the
 * validator are the security boundary for the dev-write middleware. These are
 * unit-tested directly because the middleware that consumes them runs only
 * inside the Vite dev server.
 */
describe('isSafeSetId', () => {
  it('accepts plain slugs', () => {
    for (const id of ['built-in', 'my_journeys', 'set1', 'A-b_2']) {
      expect(isSafeSetId(id)).toBe(true);
    }
  });

  it('rejects traversal, separators, and junk', () => {
    for (const id of ['../evil', 'a/b', 'a\\b', '.', '..', '', 'has space', 'a'.repeat(60), 42, null]) {
      expect(isSafeSetId(id)).toBe(false);
    }
  });
});

describe('parseJourneySet', () => {
  const valid = {
    id: 'my-set',
    label: 'My set',
    journeys: [{ id: 'j1', label: 'Journey one', shows: 'a thing', state: { planHandle: 'free' } }],
  };

  it('returns a typed set for valid input', () => {
    const parsed = parseJourneySet(valid);
    expect(parsed?.id).toBe('my-set');
    expect(parsed?.journeys).toHaveLength(1);
    expect(parsed?.journeys[0]?.shows).toBe('a thing');
  });

  it('defaults a missing "shows" to empty string', () => {
    const parsed = parseJourneySet({ ...valid, journeys: [{ id: 'j1', label: 'J', state: {} }] });
    expect(parsed?.journeys[0]?.shows).toBe('');
  });

  it('rejects an unsafe set id', () => {
    expect(parseJourneySet({ ...valid, id: '../escape' })).toBeNull();
  });

  it('rejects malformed shapes', () => {
    expect(parseJourneySet(null)).toBeNull();
    expect(parseJourneySet({ id: 'ok', label: 'ok' })).toBeNull();
    expect(parseJourneySet({ id: 'ok', label: 'ok', journeys: 'nope' })).toBeNull();
    expect(parseJourneySet({ id: 'ok', label: 'ok', journeys: [{ id: 'j' }] })).toBeNull();
    expect(parseJourneySet({ id: 'ok', label: 'ok', journeys: [{ id: 'j', label: 'L', state: 7 }] })).toBeNull();
  });
});
