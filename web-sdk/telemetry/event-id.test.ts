/**
 * Plan 144 TASK-7 — sortable, unique event ids (REQ-7, AC-6).
 *
 * Locks the two properties the wire column depends on: every id is unique
 * (even inside one millisecond) and lexicographic order equals capture order,
 * so a dashboard can sort by `event_id` alone.
 */
import { describe, expect, it } from 'vitest';
import { createEventIdGenerator, eventIds } from './event-id';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('event-id generator', () => {
  it('mints a 26-char Crockford base32 id', () => {
    const id = createEventIdGenerator().next();
    expect(id).toHaveLength(26);
    expect(id).toMatch(ULID_RE);
  });

  it('is unique across a large burst', () => {
    const gen = createEventIdGenerator();
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) ids.add(gen.next());
    expect(ids.size).toBe(10_000);
  });

  it('is strictly increasing within a single millisecond (monotonic tail)', () => {
    const gen = createEventIdGenerator();
    const fixed = 1_700_000_000_000; // pin the clock so only the tail moves
    let prev = gen.next(fixed);
    for (let i = 0; i < 1_000; i += 1) {
      const next = gen.next(fixed);
      expect(next > prev).toBe(true); // lexicographic
      prev = next;
    }
  });

  it('orders ids by time across milliseconds', () => {
    const gen = createEventIdGenerator();
    const earlier = gen.next(1_700_000_000_000);
    const later = gen.next(1_700_000_000_001);
    expect(later > earlier).toBe(true);
  });

  it('never emits an id whose time prefix goes backwards even if the clock does', () => {
    const gen = createEventIdGenerator();
    const first = gen.next(1_700_000_000_005);
    // Clock drifts backwards (NTP correction): the id must still not regress.
    const second = gen.next(1_700_000_000_000);
    expect(second > first).toBe(true);
  });

  it('exposes a shared process-wide generator', () => {
    const a = eventIds.next();
    const b = eventIds.next();
    expect(a).toMatch(ULID_RE);
    expect(b > a).toBe(true);
  });
});
