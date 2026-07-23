/**
 * Sortable, unique event identifiers for telemetry (plan 144 TASK-7).
 *
 * REQ-7 / AC-6 require every event to carry an `event_id` that is both
 * **unique** — even for two events captured in the same millisecond — and
 * **sortable**, so lexicographic string order equals capture order without a
 * separate timestamp comparison.
 *
 * We mint a ULID rather than reuse `crypto.randomUUID()`: a v4 UUID is fully
 * random and therefore unordered. A ULID's leading 48-bit millisecond timestamp
 * makes string comparison order ids by time, while a monotonically-incremented
 * random tail breaks ties inside a millisecond and still preserves order (the
 * standard ULID monotonic-factory guarantee).
 *
 * @see https://github.com/ulid/spec
 */

// Crockford's base32 — omits I, L, O, U to stay unambiguous and case-insensitive.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length; // 32
const ENCODING_MAX = ENCODING_LEN - 1; // 31
const TIME_LEN = 10; // 10 base32 chars hold a 48-bit ms timestamp (good past year 10000)
const RANDOM_LEN = 16; // 16 base32 chars = 80 bits of entropy, per the ULID spec

function encodeTime(timeMs: number): string {
  let time = timeMs;
  let out = '';
  for (let i = 0; i < TIME_LEN; i += 1) {
    const mod = time % ENCODING_LEN;
    out = ENCODING[mod] + out;
    time = Math.floor(time / ENCODING_LEN);
  }
  return out;
}

function randomComponent(): number[] {
  // 256 is an exact multiple of 32, so `byte % 32` is unbiased over 0..31.
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  const out = new Array<number>(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i += 1) out[i] = bytes[i] % ENCODING_LEN;
  return out;
}

/**
 * Increment a base32 digit array in place, carrying left. Returns `false` only
 * on the astronomically-improbable overflow of all 80 random bits inside one
 * millisecond, signalling the caller to reseed.
 */
function incrementComponent(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    if (digits[i] < ENCODING_MAX) {
      digits[i] += 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

/**
 * Mints sortable, unique event ids. One generator per SDK instance keeps every
 * event from a page globally ordered.
 */
export interface EventIdGenerator {
  /**
   * Return the next event id. Pass `nowMs` only in tests to pin the clock;
   * production callers omit it and get `Date.now()`.
   */
  next(nowMs?: number): string;
}

/**
 * Create an independent monotonic ULID generator. The SDK uses one shared
 * {@link eventIds} instance; tests create their own for isolation.
 */
export function createEventIdGenerator(): EventIdGenerator {
  let lastTime = -1;
  let lastRandom: number[] = [];

  return {
    next(nowMs: number = Date.now()): string {
      if (nowMs <= lastTime && lastRandom.length === RANDOM_LEN) {
        // Same (or a backwards-drifting) clock tick: keep the timestamp and
        // increment the random tail so the id still strictly increases.
        if (!incrementComponent(lastRandom)) {
          // 80-bit overflow within one ms — nudge time forward a tick and
          // reseed so ordering is preserved rather than colliding. Defensive:
          // this branch is effectively unreachable.
          lastTime += 1;
          lastRandom = randomComponent();
        }
      } else {
        lastTime = nowMs;
        lastRandom = randomComponent();
      }
      let out = encodeTime(lastTime);
      for (let i = 0; i < lastRandom.length; i += 1) out += ENCODING[lastRandom[i]];
      return out;
    },
  };
}

/**
 * Process-wide event-id generator. Sharing one instance across every event from
 * a page guarantees ids are globally ordered and never collide.
 */
export const eventIds: EventIdGenerator = createEventIdGenerator();
