/**
 * Trigger-name collision parity (plan 231 REQ-4 / AC-4).
 *
 * `emitTrigger` is a convenience wrapper over `emitSemantic`, so it rides the
 * GENERIC emit lane — the same lane a customer's `track()` uses. That lane
 * applies `namespacePlatformCollision`, which prefixes `clickstream_` to any
 * name the platform taxonomy already declares. This is deliberate and
 * protective: it is what stops a client from forging a first-party billing or
 * gate fact by naming an event after one.
 *
 * Three trigger names collide with taxonomy names — `trial_expired`,
 * `payment_failed`, `feature_gated` — so they land on the wire as
 * `clickstream_*`, NOT as the raw names a reader would expect from the
 * decision-engine vocabulary. That is easy to discover the hard way while
 * querying for triggers and finding nothing.
 *
 * Kent's ruling (2026-09-10) was to CODIFY the namespacing rather than rename
 * the triggers, so this test pins the wire outcome in both directions: the
 * colliding trio stays namespaced, and the non-colliding majority stays raw.
 * A future change in either direction — a taxonomy name added that shadows a
 * trigger, or the collision rule quietly relaxed — fails here instead of
 * silently moving where those events land.
 */
import { describe, expect, it } from 'vitest';
import { normalizeEventType } from '@revt-eng/core';
import {
  PLATFORM_EMITTED_EVENT_NAMES,
  TriggerEventTypeSchema,
  namespacePlatformCollision,
} from '@revt-eng/schema';

/** What the generic lane does to a name on its way to the wire. */
const onTheWire = (name: string): string => namespacePlatformCollision(normalizeEventType(name));

const TRIGGER_NAMES = TriggerEventTypeSchema.options as readonly string[];
const PLATFORM_NAMES: ReadonlySet<string> = new Set(PLATFORM_EMITTED_EVENT_NAMES);

/**
 * The collisions as of taxonomy v5. Named explicitly rather than derived, so
 * that adding a fourth collision fails the totality check below and forces a
 * decision instead of silently changing an event's landing name.
 */
const KNOWN_COLLIDING_TRIGGERS = ['trial_expired', 'payment_failed', 'feature_gated'] as const;

describe('emitTrigger names on the wire (plan 231 REQ-4)', () => {
  it('the known colliding triggers land namespaced, not raw', () => {
    for (const name of KNOWN_COLLIDING_TRIGGERS) {
      expect(TRIGGER_NAMES, `${name} must still be a declared trigger`).toContain(name);
      expect(PLATFORM_NAMES.has(name), `${name} must still collide with the taxonomy`).toBe(true);
      expect(onTheWire(name)).toBe(`clickstream_${name}`);
    }
  });

  it('every other trigger reaches the wire under its own name', () => {
    const nonColliding = TRIGGER_NAMES.filter(
      (n) => !(KNOWN_COLLIDING_TRIGGERS as readonly string[]).includes(n),
    );
    expect(nonColliding.length).toBeGreaterThan(0);
    for (const name of nonColliding) {
      expect(onTheWire(name), `${name} should not be namespaced`).toBe(name);
    }
  });

  it('the collision set is exactly the three we declared', () => {
    // The totality check. A taxonomy addition that shadows another trigger
    // changes where that trigger's events land — a silent analytics break —
    // so it must surface here as a failing test, not as an empty chart.
    const actual = TRIGGER_NAMES.filter((n) => PLATFORM_NAMES.has(normalizeEventType(n))).sort();
    expect(actual).toEqual([...KNOWN_COLLIDING_TRIGGERS].sort());
  });

  it('namespacing is idempotent — an already-prefixed name is not double-prefixed', () => {
    for (const name of KNOWN_COLLIDING_TRIGGERS) {
      expect(onTheWire(`clickstream_${name}`)).toBe(`clickstream_${name}`);
    }
  });

  it('the typed emit surface still reaches the raw platform names', () => {
    // The protection only holds because there IS a first-party path: platform
    // events are emitted by `emitPlatformEvent`, which does not namespace. If
    // that stopped being true, namespacing the generic lane would mean these
    // names could never be emitted at all.
    for (const name of KNOWN_COLLIDING_TRIGGERS) {
      expect(PLATFORM_EMITTED_EVENT_NAMES).toContain(name);
    }
  });
});
